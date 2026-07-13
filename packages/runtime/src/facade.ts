/**
 * The `Runtime` facade from contracts.md — assembles queue + supervisor + workspace
 * manager + reconciliation into the one interface the server (E5) consumes:
 *
 *   enqueue({ workstreamId, trigger })   — resolves everything else itself (#22)
 *   cancelRun(runId)                     — queued or live
 *   reconcileOnStartup()                 — F3/F7
 *
 * Workspace wiring (#26): acquired before `adapter.start()` from the workstream's
 * `workspace_ref` (git worktree / plain dir / scratch fallback); a refused acquisition
 * cancels the run outright. Worktrees persist across runs and are released on
 * `releaseWorkspace` (doc-05 retention: workspaces are removed on workstream archive,
 * not per-run).
 *
 * Context composition is the server's (L3, E5.6) — injected as the `composeContext`
 * callback so this package stays free of composition/policy concerns.
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Agent, Run, RunId, RunTrigger, Workstream, WorkstreamId } from "@foundry/core";
import type { Store } from "@foundry/store";
import type { ExecutionAdapter, RunHandle } from "@foundry/adapter-api";
import { createRunQueue, type RunQueue, type RunQueueJob, type RunQueueLimits } from "./scheduler/queue.js";
import { createRunSupervisor } from "./supervisor/supervisor.js";
import { createWorkspaceManager, type WorkspaceManager } from "./workspace/manager.js";
import { createPidRegistry, reconcileOnStartup, type ReconcileResult } from "./reconcile/reconcile.js";

export type AdapterRegistry = Record<string, ExecutionAdapter>;

export interface RuntimeOptions {
  store: Store;
  adapters: AdapterRegistry;
  /** `.foundry` data dir — pid registry lives at `<dataDir>/pids`, workspaces at `<dataDir>/workspaces`. */
  dataDir: string;
  /**
   * E5.6 hook: writes the composed context for a run about to start and returns its
   * absolute path. Called at execute time (not enqueue time) so the context reflects
   * the world when the run actually starts, e.g. after queue delay.
   */
  composeContext(args: { run: Run; workstream: Workstream; agent: Agent }): string | Promise<string>;
  /**
   * E6.1 hook: mint the per-run org-tools credential (server owns the token registry;
   * this layer only threads it into the RunSpec). Revoked when the run's execute
   * settles, however it ends — run end is credential expiry.
   */
  mintRunCredential?(args: { run: Run; agent: Agent }): { mcpConfig?: object; cliEnv?: Record<string, string> };
  revokeRunCredential?(run: Run): void;
  /** Post-run hook (E11.1: memory auto-commit). Called after the run settles, best-effort. */
  afterRun?(args: { run: Run; workstream: Workstream; agent: Agent }): void;
  limits?: RunQueueLimits;
  defaultWallClockMs?: number;
  defaultStallMs?: number;
  budgetCaps?: { tokensIn?: number; tokensOut?: number; costUsd?: number };
}

export interface Runtime {
  enqueue(job: {
    workstreamId: WorkstreamId;
    trigger: RunTrigger;
    triggerMessageMd?: string;
    allowResume?: boolean;
  }): Run;
  cancelRun(runId: RunId, reason?: string): Promise<void>;
  reconcileOnStartup(): Promise<ReconcileResult>;
  /** Doc-05 retention: drop the workstream's worktree/scratch dir (on close/archive). */
  releaseWorkspace(workstreamId: WorkstreamId): void;
  pendingCount(): number;
  activeCount(): number;
}

export function createRuntime(opts: RuntimeOptions): Runtime {
  const { store, adapters } = opts;
  const pids = createPidRegistry(join(opts.dataDir, "pids"));
  const liveHandles = new Map<string, { adapter: ExecutionAdapter; handle: RunHandle }>();
  const workspaces: WorkspaceManager = createWorkspaceManager({
    store,
    worktreesRoot: join(opts.dataDir, "workspaces"),
  });
  const supervisor = createRunSupervisor({
    store,
    adapters,
    pids,
    liveHandles,
    defaultWallClockMs: opts.defaultWallClockMs,
    defaultStallMs: opts.defaultStallMs,
    budgetCaps: opts.budgetCaps,
  });

  function resolve(workstreamId: WorkstreamId): { workstream: Workstream; agent: Agent } {
    const workstream = store.workstreams.get(workstreamId);
    if (!workstream) throw new Error(`workstream not found: ${workstreamId}`);
    const agent = store.agents.get(workstream.agent_id);
    if (!agent) throw new Error(`agent not found: ${workstream.agent_id}`);
    return { workstream, agent };
  }

  function acquireWorkspace(workstream: Workstream): { ok: boolean; workspaceDir?: string; refusalReason?: string } {
    const ref = workstream.workspace_ref;
    if (ref?.kind === "git_worktree") return workspaces.acquireGitWorktree(workstream.id, ref.repo_path);
    if (ref?.kind === "plain_dir") {
      // The point of plain_dir is running directly in an existing folder, no
      // isolation — unlike git_worktree, there's no separate copy to fall back to,
      // so a missing path is a clear refusal rather than silently using a scratch
      // dir instead (that would work but silently ignore what the user asked for).
      if (!existsSync(ref.path)) {
        return { ok: false, refusalReason: `plain_dir path does not exist: ${ref.path}` };
      }
      return { ok: true, workspaceDir: ref.path };
    }
    // No workspace_ref (non-code workstream): scratch covers it so every run has
    // *some* isolated cwd.
    return workspaces.acquireScratchDir(workstream.id);
  }

  async function execute(run: Run, job: RunQueueJob): Promise<void> {
    try {
      const { workstream, agent } = resolve(job.workstreamId);

      const acquired = acquireWorkspace(workstream);
      if (!acquired.ok) {
        // Refuse the run outright (#26). The workspace manager already blocked the
        // workstream if the cause was a dirty worktree (F8).
        store.commands.transitionRunState({
          id: run.id,
          workstreamId: job.workstreamId,
          to: "cancelled",
          actorId: null,
          reason: `workspace acquisition refused: ${acquired.refusalReason ?? "unknown"}`,
        });
        return;
      }

      const contextFile = await opts.composeContext({ run, workstream, agent });
      try {
        await supervisor.execute(run, {
          ...job,
          inputContextRef: contextFile,
          workspaceDir: acquired.workspaceDir,
          orgTools: opts.mintRunCredential?.({ run, agent }) ?? job.orgTools,
        });
      } finally {
        opts.revokeRunCredential?.(run);
        try {
          opts.afterRun?.({ run, workstream, agent });
        } catch {
          // post-run hooks are best-effort by contract
        }
      }
    } catch (err) {
      // The queue fires execute() and forgets it — a throw here would otherwise be an
      // unhandled rejection AND a run stranded in a non-terminal state. Fold instead.
      try {
        const current = store.runs.get(run.id);
        if (current?.state === "queued") {
          store.commands.transitionRunState({
            id: run.id,
            workstreamId: job.workstreamId,
            to: "cancelled",
            actorId: null,
            reason: `run setup failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        } else if (current?.state === "starting") {
          store.commands.transitionRunState({
            id: run.id,
            workstreamId: job.workstreamId,
            to: "failed",
            actorId: null,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        // Anything past `starting` already has the supervisor's own terminal folds.
      } catch {
        // Fold failed too (e.g. the store is already closed on shutdown) — nothing
        // safer to do from a fire-and-forget callback; reconciliation (F3) covers it.
      }
    }
  }

  const queue: RunQueue = createRunQueue({ store, limits: opts.limits, execute });

  function toJob(run: Run, workstream: Workstream, agent: Agent): RunQueueJob {
    return {
      workstreamId: workstream.id,
      trigger: run.trigger,
      inputContextRef: run.input_context_ref,
      engineId: agent.engine.id,
      engineConfig: agent.engine.config,
      agentId: agent.id,
      teamId: agent.team_id ?? undefined,
      agentName: agent.name,
      // workspaceDir/orgTools resolved at execute time (workspace manager / E6 org-tools)
    };
  }

  return {
    enqueue({ workstreamId, trigger, triggerMessageMd, allowResume }) {
      const { workstream, agent } = resolve(workstreamId);
      if (agent.state !== "active") {
        throw new Error(`agent ${agent.id} is ${agent.state}, not runnable`);
      }
      const run = queue.enqueue({
        workstreamId,
        trigger,
        // {run_id} is substituted by the store's createRun (OPEN_ISSUES #29) so the
        // recorded ref matches doc-05's `runs/<run-id>/context.md` layout exactly.
        inputContextRef: join("runs", "{run_id}", "context.md"),
        engineId: agent.engine.id,
        engineConfig: agent.engine.config,
        agentId: agent.id,
        teamId: agent.team_id ?? undefined,
        agentName: agent.name,
        triggerMessageMd,
        allowResume,
      });
      return run;
    },

    async cancelRun(runId, reason) {
      if (queue.cancelPending(runId, reason)) return;
      // Not pending: it's live, mid-setup (left the queue, adapter not started yet), or
      // already terminal. Wait briefly for a mid-setup run's handle to appear.
      const deadline = Date.now() + 3000;
      for (;;) {
        const live = liveHandles.get(runId);
        if (live) {
          await live.adapter.cancel(live.handle);
          return; // graceful run_ended{cancelled} or the abnormal fold takes it from here
        }
        const state = store.runs.get(runId)?.state;
        if (!state) throw new Error(`run not found: ${runId}`);
        if (["completed", "failed", "interrupted", "cancelled"].includes(state)) return; // already over
        if (Date.now() > deadline) throw new Error(`run ${runId} is ${state} but never became cancellable`);
        await new Promise((r) => setTimeout(r, 10));
      }
    },

    async reconcileOnStartup() {
      return reconcileOnStartup({
        store,
        pids,
        requeue: (run) => {
          const { workstream, agent } = resolve(run.workstream_id);
          queue.restore(run, toJob(run, workstream, agent));
        },
      });
    },

    releaseWorkspace: (workstreamId) => workspaces.release(workstreamId),
    pendingCount: () => queue.pendingCount(),
    activeCount: () => queue.activeCount(),
  };
}
