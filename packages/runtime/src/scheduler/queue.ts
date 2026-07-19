/**
 * E4.1 — run queue: per-workstream serialization, concurrency caps, human-first priority
 * (03-system-architecture.md "The Agent Runtime" — Scheduler: "FIFO with human-triggered
 * runs prioritized over agent-triggered ones. Nothing fancier until proven necessary.").
 *
 * Enqueueing creates the `Run` row via the store's existing `createRun` mutation (which
 * emits `run_queued`) rather than reinventing event emission here. Actually invoking the
 * adapter is the run supervisor's job (E4.2) — this queue only decides *when* a queued
 * run is allowed to start, via the `execute` callback the caller supplies.
 */
import type { AgentId, Run, RunTrigger, TeamId, WorkstreamId } from "@foundry/core";
import type { Store } from "@foundry/store";

export interface RunQueueJob {
  workstreamId: WorkstreamId;
  trigger: RunTrigger;
  inputContextRef: string;
  engineId: string;
  agentId?: AgentId;
  teamId?: TeamId;
  /** Passed through untouched to whatever `execute` does with the job (e.g. the E4.2 run supervisor builds a RunSpec from these). */
  agentName?: string;
  workspaceDir?: string;
  engineConfig?: unknown;
  orgTools?: { mcpConfig?: object; cliEnv?: Record<string, string> };
  wallClockMs?: number;
  /** The message body that triggered this run, if any (see CreateRunInput). */
  triggerMessageMd?: string;
  /** Explicit resume control (default true — existing auto-resume-if-possible
   * behavior): a Reply continues the current conversation; a deliberate "new
   * conversation" action sets this false to force a cold start even though a
   * resumable session exists. */
  allowResume?: boolean;
}

export interface RunQueueLimits {
  maxConcurrentOrg?: number;
  maxConcurrentPerAgent?: number;
  maxConcurrentPerTeam?: number;
}

export interface RunQueueOptions {
  store: Pick<Store, "commands">;
  limits?: RunQueueLimits;
  /** Invoked when a queued job is allowed to start; runtime's next slot opens once this settles. */
  execute(run: Run, job: RunQueueJob): Promise<void>;
}

export interface RunQueue {
  /** Persists the run (`run_queued` event included) and queues it for execution. */
  enqueue(job: RunQueueJob): Run;
  /**
   * Queues an already-persisted `queued` run without creating a new row — startup
   * reconciliation's re-queue path (E4.5/F3). Same scheduling rules as `enqueue`.
   */
  restore(run: Run, job: RunQueueJob): void;
  /**
   * Cancels a run that is still waiting in this queue (state `queued`): removes it and
   * transitions it to `cancelled`. Returns false if the run isn't pending here (already
   * started or unknown) — cancelling a *live* run is the supervisor's job (E5 facade).
   */
  cancelPending(runId: string, reason?: string): boolean;
  pendingCount(): number;
  activeCount(): number;
  /**
   * E13 "drop in": reserves a workstream's serialization slot for something that
   * isn't a queued job at all — a live interactive session. Any headless run enqueued
   * for this workstream while reserved sits `queued` exactly as it would behind any
   * other in-flight run for the same workstream; nothing new to reject or special-case.
   * Returns false if the workstream is already occupied (a run already active, or
   * already reserved) — the caller must not double-reserve.
   */
  reserveWorkstream(workstreamId: WorkstreamId): boolean;
  /** Releases a reservation taken via `reserveWorkstream` and drains anything that
   * queued behind it. A no-op if the workstream wasn't reserved. */
  releaseWorkstream(workstreamId: WorkstreamId): void;
}

interface Entry {
  run: Run;
  job: RunQueueJob;
}

export function createRunQueue(opts: RunQueueOptions): RunQueue {
  const limits = opts.limits ?? {};
  const pending: Entry[] = [];
  const activeWorkstreams = new Set<WorkstreamId>();
  const activePerAgent = new Map<AgentId, number>();
  const activePerTeam = new Map<TeamId, number>();
  let activeTotal = 0;

  function canStart(job: RunQueueJob): boolean {
    if (activeWorkstreams.has(job.workstreamId)) return false;
    if (limits.maxConcurrentOrg !== undefined && activeTotal >= limits.maxConcurrentOrg) return false;
    if (
      job.agentId &&
      limits.maxConcurrentPerAgent !== undefined &&
      (activePerAgent.get(job.agentId) ?? 0) >= limits.maxConcurrentPerAgent
    )
      return false;
    if (
      job.teamId &&
      limits.maxConcurrentPerTeam !== undefined &&
      (activePerTeam.get(job.teamId) ?? 0) >= limits.maxConcurrentPerTeam
    )
      return false;
    return true;
  }

  /** First runnable human-triggered job, else the first runnable job — both in FIFO order. */
  function pickNext(): number {
    let firstRunnable = -1;
    for (let i = 0; i < pending.length; i++) {
      const entry = pending[i]!;
      if (!canStart(entry.job)) continue;
      if (entry.job.trigger === "human_message") return i;
      if (firstRunnable === -1) firstRunnable = i;
    }
    return firstRunnable;
  }

  function start(entry: Entry): void {
    activeWorkstreams.add(entry.job.workstreamId);
    activeTotal++;
    if (entry.job.agentId) activePerAgent.set(entry.job.agentId, (activePerAgent.get(entry.job.agentId) ?? 0) + 1);
    if (entry.job.teamId) activePerTeam.set(entry.job.teamId, (activePerTeam.get(entry.job.teamId) ?? 0) + 1);

    void opts.execute(entry.run, entry.job).finally(() => {
      activeWorkstreams.delete(entry.job.workstreamId);
      activeTotal--;
      if (entry.job.agentId)
        activePerAgent.set(entry.job.agentId, Math.max(0, (activePerAgent.get(entry.job.agentId) ?? 1) - 1));
      if (entry.job.teamId)
        activePerTeam.set(entry.job.teamId, Math.max(0, (activePerTeam.get(entry.job.teamId) ?? 1) - 1));
      drain();
    });
  }

  function drain(): void {
    for (;;) {
      const idx = pickNext();
      if (idx === -1) return;
      const [entry] = pending.splice(idx, 1);
      start(entry!);
    }
  }

  return {
    enqueue(job) {
      const run = opts.store.commands.createRun({
        workstream_id: job.workstreamId,
        trigger: job.trigger,
        input_context_ref: job.inputContextRef,
        engine_id: job.engineId,
        trigger_message_md: job.triggerMessageMd,
      });
      pending.push({ run, job });
      drain();
      return run;
    },
    restore(run, job) {
      pending.push({ run, job });
      drain();
    },
    cancelPending(runId, reason) {
      const idx = pending.findIndex((e) => e.run.id === runId);
      if (idx === -1) return false;
      const [entry] = pending.splice(idx, 1);
      opts.store.commands.transitionRunState({
        id: entry!.run.id,
        workstreamId: entry!.job.workstreamId,
        to: "cancelled",
        actorId: null,
        reason: reason ?? "cancelled while queued",
      });
      return true;
    },
    pendingCount: () => pending.length,
    activeCount: () => activeTotal,
    reserveWorkstream(workstreamId) {
      if (activeWorkstreams.has(workstreamId)) return false;
      activeWorkstreams.add(workstreamId);
      return true;
    },
    releaseWorkstream(workstreamId) {
      if (!activeWorkstreams.delete(workstreamId)) return;
      drain();
    },
  };
}
