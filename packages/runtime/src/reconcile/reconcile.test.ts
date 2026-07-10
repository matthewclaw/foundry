/**
 * E4.5 — startup reconciliation + pid sweep. The doc-01 success-test #1 automation:
 * "kill" the control plane mid-run (a file-backed store abandoned with runs in
 * non-terminal states — exactly what a killed process leaves in SQLite), restart
 * (fresh Store on the same file), reconcile, and assert every run folded correctly,
 * queued work requeued, and a real orphaned OS process killed.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentId, Run, RunId, WorkstreamId } from "@foundry/core";
import { createStore, type Store } from "@foundry/store";
import { createPidRegistry, reconcileOnStartup } from "./reconcile.js";

const ZERO_BUDGET = { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 };

let dir: string | undefined;
const openStores: Store[] = [];
afterEach(() => {
  for (const s of openStores.splice(0)) {
    try {
      s.close();
    } catch {
      // already closed by the test itself
    }
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** File-backed store — reconciliation is about what survives a process death. */
function fileStore(): Store {
  dir ??= mkdtempSync(join(tmpdir(), "foundry-runtime-reconcile-"));
  const store = createStore({ dataDir: dir });
  openStores.push(store);
  return store;
}

function bootstrapWorkstream(store: Store): WorkstreamId {
  const team = store.commands.createTeam({ name: "Platform", description: "infra", default_policy: {} });
  const { agentId } = store.commands.createAgent({
    name: "Orbit",
    role: "Backend Engineer",
    team_id: team.id,
    engine_id: "fake",
    memory_ref: "agents/orbit/memory",
    charter_body_md: "# Orbit",
  }) as { agentId: AgentId };
  return store.commands.createWorkstream({
    agent_id: agentId,
    title: "Reconcile me",
    goal_md: "test goal",
    origin: "human",
    budget: ZERO_BUDGET,
  }).id;
}

function queuedRun(store: Store, ws: WorkstreamId): Run {
  return store.commands.createRun({
    workstream_id: ws,
    trigger: "agent_message",
    input_context_ref: "runs/x/context.md",
    engine_id: "fake",
  });
}

/** Drive a fresh run to the given mid-flight state via the real transition commands. */
function runInState(store: Store, ws: WorkstreamId, state: "starting" | "running" | "awaiting_input"): Run {
  const run = queuedRun(store, ws);
  store.commands.transitionRunState({ id: run.id, workstreamId: ws, to: "starting", actorId: null });
  if (state === "starting") return run;
  store.commands.transitionRunState({ id: run.id, workstreamId: ws, to: "running", actorId: null, engineSessionId: "sess-1" });
  if (state === "running") return run;
  store.commands.transitionRunState({ id: run.id, workstreamId: ws, to: "awaiting_input", actorId: null, prompt: "which repo?" });
  return run;
}

describe("reconcileOnStartup — E4.5 (F3)", () => {
  it("folds every non-terminal run and requeues queued work after a restart", async () => {
    // Session 1: the control plane that will "die", leaving runs mid-flight on disk.
    const before = fileStore();
    const ws = bootstrapWorkstream(before);
    const starting = runInState(before, ws, "starting");
    const running = runInState(before, ws, "running");
    const awaiting = runInState(before, ws, "awaiting_input");
    const completedId = (() => {
      const r = runInState(before, ws, "running");
      before.commands.transitionRunState({
        id: r.id,
        workstreamId: ws,
        to: "completed",
        actorId: null,
        result: { outcome: "completed", final_text: "done", artifact_refs: [] },
      });
      return r.id;
    })();
    const queued = queuedRun(before, ws);
    before.close(); // kill -9: nothing in memory survives, only SQLite state

    // Session 2: restart on the same data dir.
    const store = fileStore();
    const requeued: Run[] = [];
    const result = await reconcileOnStartup({ store, requeue: (r) => requeued.push(r) });

    expect(result).toEqual({ orphansKilled: 0, runsInterrupted: 2, runsFailed: 1, jobsRequeued: 1 });
    expect(store.runs.get(starting.id)?.state).toBe("failed");
    expect(store.runs.get(running.id)?.state).toBe("interrupted");
    expect(store.runs.get(awaiting.id)?.state).toBe("interrupted");
    expect(store.runs.get(completedId)?.state).toBe("completed"); // terminal: untouched
    expect(store.runs.get(queued.id)?.state).toBe("queued");
    expect(requeued.map((r) => r.id)).toEqual([queued.id]);

    // Every fold is on the event log, plus the reconciliation summary itself.
    const types = store.events.after(0).map((e) => e.type);
    expect(types.filter((t) => t === "run_interrupted")).toHaveLength(2);
    const summary = store.events.after(0).find((e) => e.type === "system_reconciled");
    expect(summary?.payload).toEqual({ runs_interrupted: 2, jobs_requeued: 1 });
    store.close();
  });

  it("interrupted runs keep their engine_session_id — E4.6's resume needs it", async () => {
    const before = fileStore();
    const ws = bootstrapWorkstream(before);
    const running = runInState(before, ws, "running");
    before.close();

    const store = fileStore();
    await reconcileOnStartup({ store, requeue: () => {} });
    const after = store.runs.get(running.id);
    expect(after?.state).toBe("interrupted");
    expect(after?.engine_session_id).toBe("sess-1");
    store.close();
  });
});

describe("pid sweep — E4.5 (F7)", () => {
  it("kills a real orphaned process, records it, and clears the registry", async () => {
    const store = fileStore();
    const ws = bootstrapWorkstream(store);
    const run = runInState(store, ws, "running");

    // A real orphan: a node child that would idle forever if not swept.
    const orphan = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      detached: true,
    });
    orphan.unref();
    const pids = createPidRegistry(join(dir!, "pids"));
    pids.register(run.id, orphan.pid!);

    const result = await reconcileOnStartup({ store, pids, requeue: () => {} });

    expect(result.orphansKilled).toBe(1);
    expect(pids.entries()).toEqual([]);
    const killed = store.events.after(0).find((e) => e.type === "system_orphan_process_killed");
    expect(killed?.payload).toEqual({ pid: orphan.pid, run_id: run.id });
    // The process is actually gone (give SIGTERM a beat to land, then probe).
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(orphan.pid!, 0)).toThrow();
    store.close();
  });

  it("silently clears a registry entry whose process is already dead", async () => {
    const store = fileStore();
    const pids = createPidRegistry(join(dir!, "pids"));
    // Spawn-and-wait so the pid is real but guaranteed dead.
    const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise((resolve) => dead.on("exit", resolve));
    pids.register("run_dead" as RunId, dead.pid!);

    const result = await reconcileOnStartup({ store, pids, requeue: () => {} });

    expect(result.orphansKilled).toBe(0);
    expect(pids.entries()).toEqual([]);
    expect(store.events.after(0).some((e) => e.type === "system_orphan_process_killed")).toBe(false);
    store.close();
  });
});
