/**
 * Runtime facade — contracts.md `Runtime` interface (#22/#26 closed): enqueue with only
 * {workstreamId, trigger}, workspace acquisition wiring, cancelRun, reconcile requeue.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentId, WorkstreamId } from "@foundry/core";
import { createStore, type Store } from "@foundry/store";
import { createFakeAdapter, loadScenario } from "@foundry/adapter-fake";
import { createRuntime, type Runtime } from "./facade.js";

const ZERO_BUDGET = { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 };

let dir: string | undefined;
const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) {
    try {
      s.close();
    } catch {
      /* closed by test */
    }
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function setup(scenarioName = "happy-path"): { store: Store; runtime: Runtime; agentId: AgentId; ws: WorkstreamId } {
  dir = mkdtempSync(join(tmpdir(), "foundry-facade-"));
  const store = createStore({ dataDir: dir });
  stores.push(store);
  const team = store.commands.createTeam({ name: "Platform", description: "infra", default_policy: {} });
  const { agentId } = store.commands.createAgent({
    name: "Orbit",
    role: "Backend Engineer",
    team_id: team.id,
    engine_id: "fake",
    engine_config: { scenarioName },
    memory_ref: `agents/orbit/memory`,
    charter_body_md: "# Orbit\nFix backend bugs.",
  });
  store.commands.transitionAgentState({ id: agentId, to: "active", actorId: null });
  const ws = store.commands.createWorkstream({
    agent_id: agentId,
    title: "Bug #7",
    goal_md: "fix it",
    origin: "human",
    budget: ZERO_BUDGET,
  }).id;
  const runtime = createRuntime({
    store,
    adapters: { fake: createFakeAdapter(loadScenario(scenarioName)) },
    dataDir: dir,
    composeContext: ({ run }) => {
      // Stand-in for E5.6 (server's): write something real at the recorded ref.
      const path = join(dir!, run.input_context_ref);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `# context for ${run.id}`, "utf8");
      return path;
    },
  });
  return { store, runtime, agentId, ws };
}

async function idle(runtime: Runtime): Promise<void> {
  while (runtime.pendingCount() > 0 || runtime.activeCount() > 0) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("createRuntime — the contracts.md Runtime facade", () => {
  it("enqueue({workstreamId, trigger}) resolves engine/agent itself and runs to completed", async () => {
    const { store, runtime, ws } = setup();
    const run = runtime.enqueue({ workstreamId: ws, trigger: "human_message" });

    // #29: the recorded ref is the doc-05 conventional path with the real id.
    expect(run.input_context_ref).toBe(join("runs", run.id, "context.md"));

    await idle(runtime);
    const finished = store.runs.get(run.id);
    expect(finished?.state).toBe("completed");
    // Context was composed at the recorded ref before the adapter started (F: auditability).
    expect(readFileSync(join(dir!, run.input_context_ref), "utf8")).toContain(run.id);
    // #26: a scratch workspace was acquired for the ref-less workstream.
    expect(existsSync(join(dir!, "workspaces", `scratch-${ws}`))).toBe(true);
  });

  it("refuses to enqueue for a non-active agent", () => {
    const { store, runtime, agentId, ws } = setup();
    store.commands.transitionAgentState({ id: agentId, to: "suspended", actorId: null });
    expect(() => runtime.enqueue({ workstreamId: ws, trigger: "human_message" })).toThrow(/suspended/);
  });

  it("cancelRun cancels a queued run without executing it", async () => {
    const { store, runtime, ws } = setup("hang-stall");
    // Fill the only per-workstream slot, then queue a second run behind it.
    const first = runtime.enqueue({ workstreamId: ws, trigger: "human_message" });
    const second = runtime.enqueue({ workstreamId: ws, trigger: "agent_message" });
    await runtime.cancelRun(second.id);
    expect(store.runs.get(second.id)?.state).toBe("cancelled");
    // Unblock the first (hang scenario responds to cancel).
    await runtime.cancelRun(first.id);
    await idle(runtime);
    expect(["cancelled", "interrupted"]).toContain(store.runs.get(first.id)?.state);
  });

  it("reconcileOnStartup requeues queued runs through the facade's own job resolution", async () => {
    const { store, runtime, ws } = setup();
    // A queued run left over from a "previous life" (created directly, never scheduled).
    const orphaned = store.commands.createRun({
      workstream_id: ws,
      trigger: "human_message",
      input_context_ref: join("runs", "{run_id}", "context.md"),
      engine_id: "fake",
    });
    const result = await runtime.reconcileOnStartup();
    expect(result.jobsRequeued).toBe(1);
    await idle(runtime);
    expect(store.runs.get(orphaned.id)?.state).toBe("completed");
  });

  it("releaseWorkspace removes the workstream's scratch dir", async () => {
    const { runtime, ws } = setup();
    const run = runtime.enqueue({ workstreamId: ws, trigger: "human_message" });
    await idle(runtime);
    void run;
    const scratch = join(dir!, "workspaces", `scratch-${ws}`);
    expect(existsSync(scratch)).toBe(true);
    runtime.releaseWorkspace(ws);
    expect(existsSync(scratch)).toBe(false);
  });
});
