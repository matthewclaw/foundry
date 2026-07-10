/**
 * E4.2 — run supervisor: invokes the adapter for a queued run, persists its normalized
 * event stream, and folds the terminal outcome into run + workstream state
 * (03-system-architecture.md "The Agent Runtime" — Run supervisor, steps 1-5; step 6
 * crash-handling is E4.5, watchdogs are E4.3, workspace worktrees are E4.4).
 *
 * Wired as a `RunQueue`'s `execute` callback (E4.1): the queue decides *when* a job may
 * run, this decides *what happens* while it does.
 */
import type { Run } from "@foundry/core";
import type { Store } from "@foundry/store";
import type { EngineEvent, ExecutionAdapter, RunSpec } from "@foundry/adapter-api";
import type { RunQueueJob } from "../scheduler/queue.js";

export interface RunSupervisorOptions {
  store: Pick<Store, "commands" | "workstreams" | "runs">;
  /** Adapter registry keyed by engine id (contracts.md: Runtime "configured with Store + adapter registry"). */
  adapters: Record<string, ExecutionAdapter>;
  defaultWallClockMs?: number;
}

const DEFAULT_WALL_CLOCK_MS = 10 * 60 * 1000;

export function createRunSupervisor(opts: RunSupervisorOptions) {
  async function execute(run: Run, job: RunQueueJob): Promise<void> {
    const adapter = opts.adapters[job.engineId];
    if (!adapter) throw new Error(`no adapter registered for engine "${job.engineId}"`);

    ensureWorkstreamRunnable(job);

    opts.store.commands.transitionRunState({
      id: run.id,
      workstreamId: job.workstreamId,
      to: "starting",
      actorId: null,
    });

    const spec: RunSpec = {
      runId: run.id,
      agentName: job.agentName ?? "",
      contextFile: job.inputContextRef,
      workspaceDir: job.workspaceDir ?? "",
      orgTools: job.orgTools ?? {},
      engineConfig: job.engineConfig,
      limits: { wallClockMs: job.wallClockMs ?? opts.defaultWallClockMs ?? DEFAULT_WALL_CLOCK_MS },
    };

    const handle = await adapter.start(spec);

    let sawRunEnded = false;
    try {
      for await (const event of adapter.events(handle)) {
        if (event.t === "run_ended") sawRunEnded = true;
        handleEvent(run, job, event);
      }
    } catch {
      // Adapter stream ended abnormally (F1: process crash) — folded below, same as a
      // watchdog-forced cancel (F2) that the adapter doesn't acknowledge gracefully.
    }
    if (!sawRunEnded) {
      foldAbnormalTermination(run, job);
    }
  }

  /**
   * The event stream ended (threw, or the iterable just completed) without a `run_ended`
   * — an engine crash (F1) or a forced watchdog interrupt (F2) the adapter didn't
   * acknowledge with a graceful terminal event. Folds into whatever the run's current
   * state allows: `starting` (never got going) → `failed`; `running`/`awaiting_input`/
   * `awaiting_approval` (was actually underway) → `interrupted`, resumable per E4.6.
   */
  function foldAbnormalTermination(run: Run, job: RunQueueJob): void {
    const current = opts.store.runs.get(run.id);
    if (!current) return;
    if (current.state === "starting") {
      opts.store.commands.transitionRunState({
        id: run.id,
        workstreamId: job.workstreamId,
        to: "failed",
        actorId: null,
        error: "adapter stream ended before the run started",
      });
      return;
    }
    if (current.state === "running" || current.state === "awaiting_input" || current.state === "awaiting_approval") {
      opts.store.commands.transitionRunState({
        id: run.id,
        workstreamId: job.workstreamId,
        to: "interrupted",
        actorId: null,
        reason: "adapter stream ended abnormally",
      });
    }
  }

  function ensureWorkstreamRunnable(job: RunQueueJob): void {
    const ws = opts.store.workstreams.get(job.workstreamId);
    if (!ws) throw new Error(`workstream not found: ${job.workstreamId}`);
    if (ws.state === "active") return;
    if (ws.state === "open" || ws.state === "waiting") {
      opts.store.commands.transitionWorkstreamState({ id: ws.id, to: "active", actorId: null });
      return;
    }
    throw new Error(`workstream ${job.workstreamId} is "${ws.state}", not runnable`);
  }

  function handleEvent(run: Run, job: RunQueueJob, event: EngineEvent): void {
    switch (event.t) {
      case "run_started":
        opts.store.commands.transitionRunState({
          id: run.id,
          workstreamId: job.workstreamId,
          to: "running",
          actorId: null,
          engineSessionId: event.sessionRef ?? null,
        });
        return;
      case "output_delta":
        opts.store.commands.emitRunDetailEvent({
          entity_id: run.id,
          type: "run_output_delta",
          payload: { text: event.text },
          run_id: run.id,
          workstream_id: job.workstreamId,
          actor_id: null,
        });
        return;
      case "tool_call":
        opts.store.commands.emitRunDetailEvent({
          entity_id: run.id,
          type: "run_tool_call",
          payload: { phase: event.phase, name: event.name, detail: event.detail },
          run_id: run.id,
          workstream_id: job.workstreamId,
          actor_id: null,
        });
        return;
      case "usage_delta":
        opts.store.commands.emitRunDetailEvent({
          entity_id: run.id,
          type: "run_usage_updated",
          payload: {
            tokens_in: event.tokensIn,
            tokens_out: event.tokensOut,
            cost_usd: event.costUsd,
          },
          run_id: run.id,
          workstream_id: job.workstreamId,
          actor_id: null,
        });
        return;
      case "awaiting_input":
        opts.store.commands.transitionRunState({
          id: run.id,
          workstreamId: job.workstreamId,
          to: "awaiting_input",
          actorId: null,
          prompt: event.prompt,
        });
        opts.store.commands.transitionWorkstreamState({
          id: job.workstreamId,
          to: "waiting",
          actorId: null,
          // ponytail: no message exists yet to point this at — server/E8.3 wires a real
          // waiting_on_ref once the question is a Message.
          waitingOnRef: null,
        });
        return;
      case "reasoning_summary":
      case "permission_request":
        // ponytail: reasoning_summary has no catalogue slot yet (E1.3 is additive-only,
        // not extended here); permission_request → Foundry approval is E6.4's job, out of
        // scope for the run supervisor. Both silently unreported for now.
        return;
      case "run_ended":
        handleRunEnded(run, job, event);
        return;
    }
  }

  function handleRunEnded(run: Run, job: RunQueueJob, event: Extract<EngineEvent, { t: "run_ended" }>): void {
    switch (event.outcome) {
      case "completed":
        opts.store.commands.transitionRunState({
          id: run.id,
          workstreamId: job.workstreamId,
          to: "completed",
          actorId: null,
          result: { outcome: "completed", final_text: event.finalText ?? null, artifact_refs: [] },
        });
        return;
      case "needs_input":
        // Already folded into run/workstream state by the preceding `awaiting_input`
        // event (per adapter-fake's own scenario contract: the two always pair up).
        return;
      case "failed":
        opts.store.commands.transitionRunState({
          id: run.id,
          workstreamId: job.workstreamId,
          to: "failed",
          actorId: null,
          error: event.error ?? "unknown error",
        });
        return;
      case "cancelled":
        opts.store.commands.transitionRunState({
          id: run.id,
          workstreamId: job.workstreamId,
          to: "cancelled",
          actorId: null,
          reason: event.error ?? "adapter reported cancelled",
        });
        return;
    }
  }

  return { execute };
}

export type RunSupervisor = ReturnType<typeof createRunSupervisor>;
