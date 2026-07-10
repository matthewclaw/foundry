/**
 * E4.5 — startup reconciliation (F3) + pid sweep (F7). 01-executive-summary success
 * test #1: kill the control plane mid-run, restart, and every run is either marked
 * `interrupted` (resumable, E4.6), `failed` (never got going), or requeued (was still
 * `queued`) — plus any orphaned engine OS process is killed and recorded.
 *
 * Called by the server's startup orchestration (E5.1: migrate → reconcile → listen).
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Run, RunId } from "@foundry/core";
import type { Store } from "@foundry/store";

/**
 * F7's "pid-file registry": one JSON file per live engine process, written by the run
 * supervisor when an adapter's handle carries a `pid`, removed when its stream ends.
 * Anything still present at startup is by definition an orphan — the control plane that
 * owned it is gone.
 */
export interface PidRegistry {
  register(runId: RunId, pid: number): void;
  unregister(runId: RunId): void;
  entries(): { runId: RunId; pid: number }[];
}

export function createPidRegistry(dir: string): PidRegistry {
  mkdirSync(dir, { recursive: true });
  const fileFor = (runId: string) => join(dir, `${runId}.json`);
  return {
    register(runId, pid) {
      writeFileSync(fileFor(runId), JSON.stringify({ pid }));
    },
    unregister(runId) {
      rmSync(fileFor(runId), { force: true });
    },
    entries() {
      return readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => {
          const runId = f.slice(0, -".json".length) as RunId;
          const { pid } = JSON.parse(readFileSync(join(dir, f), "utf8")) as { pid: number };
          return { runId, pid };
        });
    },
  };
}

export interface ReconcileResult {
  orphansKilled: number;
  runsInterrupted: number;
  runsFailed: number;
  jobsRequeued: number;
}

export interface ReconcileOptions {
  store: Pick<Store, "mutate" | "runs" | "commands">;
  /** Omit if no pid registry exists yet (no adapter that spawns real processes). */
  pids?: PidRegistry;
  /**
   * Re-inject a still-`queued` run into the scheduler (`RunQueue.restore`). The caller
   * owns rebuilding the full job — agentName/workspaceDir/engineConfig aren't persisted
   * on the run row (OPEN_ISSUES #22); the run itself carries workstream/trigger/
   * context-ref/engine.
   */
  requeue(run: Run): void;
}

export async function reconcileOnStartup(opts: ReconcileOptions): Promise<ReconcileResult> {
  const result: ReconcileResult = { orphansKilled: 0, runsInterrupted: 0, runsFailed: 0, jobsRequeued: 0 };

  // 1. Sweep orphans first, so nothing is still writing to a workspace while we fold
  //    its run's state. Every registered pid is an orphan here: the control plane that
  //    registered it is the one that just restarted.
  if (opts.pids) {
    for (const { runId, pid } of opts.pids.entries()) {
      // ponytail: kill-by-pid with no pid-reuse guard — fine for a local single-user
      // control plane; add process-start-time verification if this ever multi-tenants.
      if (killIfAlive(pid)) {
        result.orphansKilled++;
        opts.store.mutate({
          apply: () => undefined,
          events: [
            {
              actor_id: null,
              entity_type: "system",
              entity_id: "system",
              type: "system_orphan_process_killed",
              payload: { pid, run_id: runId },
              run_id: runId,
            },
          ],
        });
      }
      opts.pids.unregister(runId);
    }
  }

  // 2. Fold every non-terminal run into what a restart means for it (F3).
  for (const run of opts.store.runs.list()) {
    switch (run.state) {
      case "starting":
        // No `starting → interrupted` edge exists — a run that never emitted
        // run_started has no session to resume, so it failed.
        opts.store.commands.transitionRunState({
          id: run.id,
          workstreamId: run.workstream_id,
          to: "failed",
          actorId: null,
          error: "control plane restarted before the run started",
        });
        result.runsFailed++;
        break;
      case "running":
      case "awaiting_input":
      case "awaiting_approval":
        opts.store.commands.transitionRunState({
          id: run.id,
          workstreamId: run.workstream_id,
          to: "interrupted",
          actorId: null,
          reason: "control plane restarted",
        });
        result.runsInterrupted++;
        break;
      case "queued":
        opts.requeue(run);
        result.jobsRequeued++;
        break;
      // completed / failed / interrupted / cancelled: already terminal, nothing to do.
    }
  }

  opts.store.mutate({
    apply: () => undefined,
    events: [
      {
        actor_id: null,
        entity_type: "system",
        entity_id: "system",
        type: "system_reconciled",
        payload: { runs_interrupted: result.runsInterrupted, jobs_requeued: result.jobsRequeued },
      },
    ],
  });

  return result;
}

function killIfAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // aliveness probe, signal 0 sends nothing
  } catch {
    return false; // already gone — nothing to kill, nothing to record
  }
  try {
    process.kill(pid); // SIGTERM; on Windows this terminates the process
    return true;
  } catch {
    return false;
  }
}
