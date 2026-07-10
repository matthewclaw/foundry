import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentId, WorkstreamId } from "@foundry/core";
import { createStore, type Store } from "@foundry/store";
import { createFakeAdapter, loadScenario } from "@foundry/adapter-fake";
import { createRunSupervisor } from "./supervisor.js";

const ZERO_BUDGET = { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 };

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function testStore(): Store {
  dir = mkdtempSync(join(tmpdir(), "foundry-runtime-supervisor-"));
  return createStore({ dataDir: dir, dbPath: ":memory:" });
}

function bootstrapAgent(store: Store): AgentId {
  const team = store.commands.createTeam({ name: "Platform", description: "infra", default_policy: {} });
  const { agentId } = store.commands.createAgent({
    name: "Orbit",
    role: "Backend Engineer",
    team_id: team.id,
    engine_id: "fake",
    memory_ref: "agents/orbit/memory",
    charter_body_md: "# Orbit",
  });
  return agentId;
}

function makeWorkstream(store: Store, agentId: AgentId, title: string): WorkstreamId {
  return store.commands.createWorkstream({
    agent_id: agentId,
    title,
    goal_md: "test goal",
    origin: "human",
    budget: ZERO_BUDGET,
  }).id;
}

describe("createRunSupervisor — E4.2", () => {
  it("drives the happy-path scenario end to end: run rows, events, workstream state all correct", async () => {
    const store = testStore();
    const agentId = bootstrapAgent(store);
    const ws = makeWorkstream(store, agentId, "Bug #482");
    expect(store.workstreams.get(ws)?.state).toBe("open");

    const supervisor = createRunSupervisor({
      store,
      adapters: { fake: createFakeAdapter(loadScenario("happy-path")) },
    });

    const run = store.commands.createRun({
      workstream_id: ws,
      trigger: "human_message",
      input_context_ref: "runs/1/context.md",
      engine_id: "fake",
    });

    await supervisor.execute(run, {
      workstreamId: ws,
      trigger: "human_message",
      inputContextRef: "runs/1/context.md",
      engineId: "fake",
      agentName: "Orbit",
      workspaceDir: dir!,
      engineConfig: { scenarioName: "happy-path" },
    });

    const finished = store.runs.get(run.id);
    expect(finished?.state).toBe("completed");
    expect(finished?.result?.outcome).toBe("completed");
    expect(finished?.result?.final_text).toBe("Task complete.");
    expect(finished?.engine_session_id).toBe("sess-happy-path");

    expect(store.workstreams.get(ws)?.state).toBe("active");

    const events = store.events.after(0).filter((e) => e.run_id === run.id);
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "run_queued",
      "run_started", // queued -> starting
      "run_running", // starting -> running (adapter's run_started EngineEvent)
      "run_output_delta",
      "run_output_delta",
      "run_completed",
    ]);
  });

  it("folds a needs_input outcome into run awaiting_input + workstream waiting", async () => {
    const store = testStore();
    const agentId = bootstrapAgent(store);
    const ws = makeWorkstream(store, agentId, "Needs a repo name");
    store.commands.transitionWorkstreamState({ id: ws, to: "active", actorId: null });

    const supervisor = createRunSupervisor({
      store,
      adapters: { fake: createFakeAdapter(loadScenario("awaiting-input")) },
    });

    const run = store.commands.createRun({
      workstream_id: ws,
      trigger: "human_message",
      input_context_ref: "runs/2/context.md",
      engine_id: "fake",
    });

    await supervisor.execute(run, {
      workstreamId: ws,
      trigger: "human_message",
      inputContextRef: "runs/2/context.md",
      engineId: "fake",
    });

    expect(store.runs.get(run.id)?.state).toBe("awaiting_input");
    expect(store.workstreams.get(ws)?.state).toBe("waiting");
  });

  it("throws when asked to run a workstream that isn't runnable (closed)", async () => {
    const store = testStore();
    const agentId = bootstrapAgent(store);
    const ws = makeWorkstream(store, agentId, "Already closed");
    store.commands.transitionWorkstreamState({ id: ws, to: "closed", actorId: null });

    const supervisor = createRunSupervisor({
      store,
      adapters: { fake: createFakeAdapter(loadScenario("happy-path")) },
    });

    const run = store.commands.createRun({
      workstream_id: ws,
      trigger: "human_message",
      input_context_ref: "runs/3/context.md",
      engine_id: "fake",
    });

    await expect(
      supervisor.execute(run, {
        workstreamId: ws,
        trigger: "human_message",
        inputContextRef: "runs/3/context.md",
        engineId: "fake",
      })
    ).rejects.toThrow(/not runnable/);
  });
});
