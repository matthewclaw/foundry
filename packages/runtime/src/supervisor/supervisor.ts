/**
 * E4.2 — run supervisor: invokes the adapter for a queued run, persists its normalized
 * event stream, and folds the terminal outcome into run + workstream state
 * (03-system-architecture.md "The Agent Runtime" — Run supervisor, steps 1-5; step 6
 * crash-handling is E4.5, watchdogs are E4.3, workspace worktrees are E4.4).
 *
 * Wired as a `RunQueue`'s `execute` callback (E4.1): the queue decides *when* a job may
 * run, this decides *what happens* while it does.
 */
import { formatRef, type Run } from "@foundry/core";
import type { Store } from "@foundry/store";
import { EngineEventSchema, type EngineEvent, type ExecutionAdapter, type RunHandle, type RunSpec } from "@foundry/adapter-api";
import type { RunQueueJob } from "../scheduler/queue.js";
import type { PidRegistry } from "../reconcile/reconcile.js";

export interface RunSupervisorOptions {
  store: Pick<Store, "commands" | "workstreams" | "runs" | "events" | "agents">;
  /** Adapter registry keyed by engine id (contracts.md: Runtime "configured with Store + adapter registry"). */
  adapters: Record<string, ExecutionAdapter>;
  defaultWallClockMs?: number;
  /** Default stall timeout: no event from adapter for this duration triggers cancellation. */
  defaultStallMs?: number;
  /** Optional budget caps: if cumulative usage exceeds any cap, the run is cancelled. */
  budgetCaps?: { tokensIn?: number; tokensOut?: number; costUsd?: number };
  /** F7: engine pids registered here while their stream is live, swept on startup (E4.5). */
  pids?: PidRegistry;
  /**
   * E5 facade: live (adapter, handle) pairs keyed by run id, so `Runtime.cancelRun` can
   * reach a run that is already streaming. Maintained here (set around each attempt's
   * stream, deleted when it ends); owned/read by the caller.
   */
  liveHandles?: Map<string, { adapter: ExecutionAdapter; handle: RunHandle }>;
}

const DEFAULT_WALL_CLOCK_MS = 10 * 60 * 1000;
const DEFAULT_STALL_MS = 5 * 60 * 1000; // 5 minutes

export function createRunSupervisor(opts: RunSupervisorOptions) {
  /**
   * E4.6: supervises a stream (start or resume) end-to-end — races watchdogs
   * against the event iterator, accumulates budget, handles events, and returns
   * whether a run_ended was observed and the final budget totals.
   * Keeps the exact watchdog semantics of the original execute loop.
   */
  async function superviseStream(
    run: Run,
    job: RunQueueJob,
    adapter: ExecutionAdapter,
    spec: RunSpec,
    handle: RunHandle,
    startingTotals: { tokensInTotal: number; tokensOutTotal: number; costUsdTotal: number }
  ): Promise<{ sawRunEnded: boolean; totals: typeof startingTotals }> {
    const wallClockMs = spec.limits.wallClockMs;
    const stallMs = opts.defaultStallMs ?? DEFAULT_STALL_MS;
    const startTime = Date.now();
    let lastEventTime = Date.now();
    let tokensInTotal = startingTotals.tokensInTotal;
    let tokensOutTotal = startingTotals.tokensOutTotal;
    let costUsdTotal = startingTotals.costUsdTotal;
    let cancelled = false;

    const eventIterator = adapter.events(handle)[Symbol.asyncIterator]();
    let sawRunEnded = false;
    const WATCHDOG_TIMEOUT = Symbol("watchdog-timeout");
    opts.liveHandles?.set(run.id, { adapter, handle });

    try {
      for (;;) {
        // Check wall-clock timeout before attempting to get next event
        const elapsedWallClock = Date.now() - startTime;
        if (elapsedWallClock >= wallClockMs && !cancelled) {
          cancelled = true;
          await adapter.cancel(handle);
        }

        // Check stall timeout before attempting to get next event
        const elapsedStall = Date.now() - lastEventTime;
        if (elapsedStall >= stallMs && !cancelled) {
          cancelled = true;
          await adapter.cancel(handle);
        }

        // Race next event against wall-clock and stall timers
        const wallClockTimeoutMs = wallClockMs - (Date.now() - startTime);
        const stallTimeoutMs = stallMs - (Date.now() - lastEventTime);
        const minTimeoutMs = Math.min(
          wallClockTimeoutMs > 0 ? wallClockTimeoutMs : Infinity,
          stallTimeoutMs > 0 ? stallTimeoutMs : Infinity
        );

        let raced: IteratorResult<EngineEvent> | typeof WATCHDOG_TIMEOUT;

        if (!isFinite(minTimeoutMs)) {
          // Both watchdogs already tripped (or disabled) — just wait for the adapter to
          // respond to the cancel() already issued above, no artificial timeout needed.
          raced = await eventIterator.next();
        } else {
          const timeoutPromise = new Promise<typeof WATCHDOG_TIMEOUT>((resolve) => {
            setTimeout(() => resolve(WATCHDOG_TIMEOUT), Math.max(0, minTimeoutMs));
          });
          raced = await Promise.race([eventIterator.next(), timeoutPromise]);
        }

        if (raced === WATCHDOG_TIMEOUT) {
          // Not real stream exhaustion — just a tick to let the top-of-loop checks above
          // re-evaluate and actually call adapter.cancel() once a threshold is crossed.
          continue;
        }

        if (raced.done) {
          break; // Iterator genuinely exhausted
        }

        // F15: a buggy adapter's event is trusted at the type level only (TS erases at
        // runtime) — validate before folding it into any state. Throwing here is caught
        // by the same abnormal-termination path as F1/F2 below, so a malformed event
        // fails the run safely (adapter blamed, org state never sees the bad shape)
        // instead of a downstream handler silently accepting garbage or throwing a
        // confusing, unrelated error deeper in the switch.
        const parsed = EngineEventSchema.safeParse(raced.value);
        if (!parsed.success) {
          throw new Error(`adapter "${adapter.id}" emitted a malformed EngineEvent: ${parsed.error.message}`);
        }
        const event = parsed.data;
        lastEventTime = Date.now();

        // Accumulate budget on usage_delta events
        if (event.t === "usage_delta") {
          if (event.tokensIn !== undefined) tokensInTotal += event.tokensIn;
          if (event.tokensOut !== undefined) tokensOutTotal += event.tokensOut;
          if (event.costUsd !== undefined) costUsdTotal += event.costUsd;

          // Check if budget exceeded
          if (opts.budgetCaps && !cancelled) {
            if (
              opts.budgetCaps.tokensIn !== undefined &&
              tokensInTotal > opts.budgetCaps.tokensIn
            ) {
              cancelled = true;
              await adapter.cancel(handle);
            } else if (
              opts.budgetCaps.tokensOut !== undefined &&
              tokensOutTotal > opts.budgetCaps.tokensOut
            ) {
              cancelled = true;
              await adapter.cancel(handle);
            } else if (opts.budgetCaps.costUsd !== undefined && costUsdTotal > opts.budgetCaps.costUsd) {
              cancelled = true;
              await adapter.cancel(handle);
            }
          }
        }

        if (event.t === "run_ended") sawRunEnded = true;
        handleEvent(run, job, event);
      }
    } catch {
      // Adapter stream ended abnormally (F1: process crash) — folded below, same as a
      // watchdog-forced cancel (F2) that the adapter doesn't acknowledge gracefully.
    } finally {
      // Stream over (gracefully or not) — the engine process is no longer ours to sweep
      // or cancel.
      if (opts.pids && typeof handle.pid === "number") opts.pids.unregister(run.id);
      opts.liveHandles?.delete(run.id);
    }
    return { sawRunEnded, totals: { tokensInTotal, tokensOutTotal, costUsdTotal } };
  }

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

    // Conversation continuity: if the engine supports session resume and the most
    // recent prior run on this workstream ended with a session to resume into,
    // continue that session instead of cold-starting a fresh one with no memory
    // beyond the "Prior runs" summary in the composed context (compose.ts). This is
    // the same adapter.resume() as E4.6's crash recovery, just triggered by "another
    // message arrived" rather than "the process died mid-run."
    const priorSessionId = findResumableSessionId(job.workstreamId, run.id, adapter);
    const handle = priorSessionId
      ? await adapter.resume!({ ...spec, sessionRef: priorSessionId })
      : await adapter.start(spec);
    // F7: while this stream is live, the engine process (if the adapter spawned a real
    // one) is registered so a control-plane restart can sweep it as an orphan (E4.5).
    if (opts.pids && typeof handle.pid === "number") opts.pids.register(run.id, handle.pid);

    const startingTotals = { tokensInTotal: 0, tokensOutTotal: 0, costUsdTotal: 0 };
    const { sawRunEnded, totals } = await superviseStream(run, job, adapter, spec, handle, startingTotals);

    if (!sawRunEnded) {
      await foldAbnormalTermination(run, job, adapter, spec, totals);
    }
  }

  /**
   * The event stream ended (threw, or the iterable just completed) without a `run_ended`
   * — an engine crash (F1) or a forced watchdog interrupt (F2) the adapter didn't
   * acknowledge with a graceful terminal event. Folds into whatever the run's current
   * state allows: `starting` (never got going) → `failed`; `running`/`awaiting_input`/
   * `awaiting_approval` (was actually underway) → `interrupted`, resumable per E4.6.
   */
  async function foldAbnormalTermination(
    run: Run,
    job: RunQueueJob,
    adapter: ExecutionAdapter,
    spec: RunSpec,
    carryingTotals: { tokensInTotal: number; tokensOutTotal: number; costUsdTotal: number }
  ): Promise<void> {
    if (foldTerminalState(run, job) === "interrupted") {
      // E4.6: auto-resume interrupted runs exactly once if all gates below pass.
      await attemptResume(run, job, adapter, spec, carryingTotals);
    }
  }

  /**
   * The state-dispatch half of the fold, shared by the first attempt and the resume
   * attempt: `starting` (never got going — no session to resume, and no valid
   * `starting → interrupted` edge exists) → `failed`; `running`/`awaiting_*` →
   * `interrupted`. Never resumes; the caller decides that.
   */
  function foldTerminalState(run: Run, job: RunQueueJob, suffix = ""): "failed" | "interrupted" | undefined {
    const current = opts.store.runs.get(run.id);
    if (!current) return undefined;
    if (current.state === "starting") {
      opts.store.commands.transitionRunState({
        id: run.id,
        workstreamId: job.workstreamId,
        to: "failed",
        actorId: null,
        error: `adapter stream ended before the run started${suffix}`,
      });
      return "failed";
    }
    if (current.state === "running" || current.state === "awaiting_input" || current.state === "awaiting_approval") {
      opts.store.commands.transitionRunState({
        id: run.id,
        workstreamId: job.workstreamId,
        to: "interrupted",
        actorId: null,
        reason: `adapter stream ended abnormally${suffix}`,
      });
      return "interrupted";
    }
    return undefined;
  }

  /**
   * Conversation continuity: the session id to resume into for a brand-new run on
   * this workstream, if any. Distinct from attemptResume() below — that one resumes
   * THIS run's own session after a crash; this one looks at the PREVIOUS (already
   * ended) run's session so a new message continues the same engine conversation.
   */
  function findResumableSessionId(workstreamId: RunQueueJob["workstreamId"], currentRunId: Run["id"], adapter: ExecutionAdapter): string | undefined {
    if (!adapter.capabilities().resume || !adapter.resume) return undefined;
    const priorRuns = opts.store.runs
      .list({ workstream_id: workstreamId })
      .filter((r) => r.id !== currentRunId && r.ended_at !== null);
    return priorRuns.at(-1)?.engine_session_id ?? undefined;
  }

  /**
   * E4.6: Attempt to resume an interrupted run if conditions permit.
   * Conditions: adapter supports resume, run has engine_session_id, never been resumed before.
   */
  async function attemptResume(
    run: Run,
    job: RunQueueJob,
    adapter: ExecutionAdapter,
    spec: RunSpec,
    carryingTotals: { tokensInTotal: number; tokensOutTotal: number; costUsdTotal: number }
  ): Promise<void> {
    // ponytail: guards below enforce the once-only resume contract even across restarts
    const current = opts.store.runs.get(run.id);
    if (!current) return;

    // Gate 1: adapter supports resume
    if (!adapter.capabilities().resume || !adapter.resume) return;

    // Gate 2: run must have a session reference to resume into
    if (!current.engine_session_id) return;

    // Gate 3: never resumed before — once-only, and the event log makes the guard
    // hold even across a control-plane restart between interruption and resume.
    if (opts.store.events.after(0, { run_id: run.id, type: "run_resumed" }).length > 0) return;

    // All gates passed — attempt resume
    opts.store.commands.transitionRunState({
      id: run.id,
      workstreamId: job.workstreamId,
      to: "starting",
      actorId: null,
    });

    const resumeSpec: RunSpec & { sessionRef: string } = { ...spec, sessionRef: current.engine_session_id };
    const handle2 = await adapter.resume(resumeSpec);

    // F7: register pid for the resumed attempt too
    if (opts.pids && typeof handle2.pid === "number") opts.pids.register(run.id, handle2.pid);

    // Use the same spec for supervising — the adapter's internal state carries the session context
    const { sawRunEnded: sawRunEnded2 } = await superviseStream(run, job, adapter, resumeSpec, handle2, carryingTotals);

    if (!sawRunEnded2) {
      // The resumed stream also died — fold by current state (it may have crashed before
      // its run_started, i.e. still `starting`, where only `failed` is a legal edge).
      // Never a second resume.
      foldTerminalState(run, job, " (after resume)");
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
        // ponytail: no catalogue slot yet (E1.3 is additive-only, not extended here) —
        // silently unreported, OPEN_ISSUES #23.
        return;
      case "permission_request": {
        // E6.4: engine permission prompt → Foundry approval item. The RUN state is
        // deliberately untouched: an engine may keep streaming past the request (its
        // hook resolves in-process, see the fake's permission-request-granted scenario),
        // and the async grant path schedules a *fresh* run via the approvals route.
        const agent = job.agentId ? opts.store.agents.get(job.agentId) : undefined;
        if (!agent) return; // no agent to attribute the request to (bare-supervisor callers)
        const approval = opts.store.commands.requestApproval({
          requested_by_actor: agent.actor_id,
          kind: "engine_permission",
          payload: {
            request_id: event.requestId,
            description: event.description,
            run_id: run.id,
            workstream_id: job.workstreamId,
          },
        });
        // Make the wait visible on the workstream with a real waiting_on_ref (#25's
        // approval case): only from `active` — if it's already waiting, keep that ref.
        if (opts.store.workstreams.get(job.workstreamId)?.state === "active") {
          opts.store.commands.transitionWorkstreamState({
            id: job.workstreamId,
            to: "waiting",
            actorId: null,
            waitingOnRef: formatRef("approval", approval.id),
          });
        }
        return;
      }
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
