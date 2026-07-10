import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentId, WorkstreamId } from "@foundry/core";
import { createStore, type Store } from "@foundry/store";
import { createFakeAdapter, loadScenario } from "@foundry/adapter-fake";
import type { ExecutionAdapter } from "@foundry/adapter-api";
import { createRunSupervisor } from "./supervisor.js";

/** Wraps an adapter to count cancel() calls — proves a watchdog actually cancels the
 * adapter, not just that the run ends up in the right store state (which can happen even
 * if cancel() is never called, if something else independently folds the terminal state). */
function spyOnCancel(inner: ExecutionAdapter): { adapter: ExecutionAdapter; cancelCalls: () => number } {
  let cancelCalls = 0;
  return {
    cancelCalls: () => cancelCalls,
    adapter: {
      id: inner.id,
      capabilities: () => inner.capabilities(),
      start: (spec) => inner.start(spec),
      resume: inner.resume ? (spec) => inner.resume!(spec) : undefined,
      events: (handle) => inner.events(handle),
      cancel: async (handle) => {
        cancelCalls++;
        await inner.cancel(handle);
      },
    },
  };
}

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

  it("folds an abnormal stream end (engine crash, F1) into run interrupted", async () => {
    const store = testStore();
    const agentId = bootstrapAgent(store);
    const ws = makeWorkstream(store, agentId, "Crashes mid-run");

    const supervisor = createRunSupervisor({
      store,
      adapters: { fake: createFakeAdapter(loadScenario("engine-crash")) },
    });

    const run = store.commands.createRun({
      workstream_id: ws,
      trigger: "human_message",
      input_context_ref: "runs/4/context.md",
      engine_id: "fake",
    });

    await supervisor.execute(run, {
      workstreamId: ws,
      trigger: "human_message",
      inputContextRef: "runs/4/context.md",
      engineId: "fake",
    });

    expect(store.runs.get(run.id)?.state).toBe("interrupted");
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

describe("watchdogs — E4.3", () => {
  it("stall watchdog: hang-stall scenario with short stallMs terminates in interrupted state", async () => {
    const start = Date.now();
    const store = testStore();
    const agentId = bootstrapAgent(store);
    const ws = makeWorkstream(store, agentId, "Hang test");

    const spy = spyOnCancel(createFakeAdapter(loadScenario("hang-stall")));
    const supervisor = createRunSupervisor({
      store,
      adapters: { fake: spy.adapter },
      defaultStallMs: 20, // Short timeout for test speed
    });

    const run = store.commands.createRun({
      workstream_id: ws,
      trigger: "human_message",
      input_context_ref: "runs/5/context.md",
      engine_id: "fake",
    });

    await supervisor.execute(run, {
      workstreamId: ws,
      trigger: "human_message",
      inputContextRef: "runs/5/context.md",
      engineId: "fake",
      agentName: "Orbit",
      workspaceDir: dir!,
    });

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000); // Should be quick, not hang
    expect(store.runs.get(run.id)?.state).toBe("interrupted");
    // The stall watchdog must actually tell the adapter to stop, not just let the
    // supervisor give up on the stream — a real engine process needs to be told to die.
    expect(spy.cancelCalls()).toBeGreaterThanOrEqual(1);
  });

  it("budget cutoff watchdog: budget-burn-cutoff scenario trips at costUsd cap", async () => {
    const store = testStore();
    const agentId = bootstrapAgent(store);
    const ws = makeWorkstream(store, agentId, "Budget test");

    const supervisor = createRunSupervisor({
      store,
      adapters: { fake: createFakeAdapter(loadScenario("budget-burn-cutoff")) },
      defaultStallMs: 5000, // Long stall so wall-clock/budget trip first
      budgetCaps: { costUsd: 3.0 }, // Trip after 3rd usage_delta (cumulative: 3.4 > 3.0)
    });

    const run = store.commands.createRun({
      workstream_id: ws,
      trigger: "human_message",
      input_context_ref: "runs/6/context.md",
      engine_id: "fake",
    });

    await supervisor.execute(run, {
      workstreamId: ws,
      trigger: "human_message",
      inputContextRef: "runs/6/context.md",
      engineId: "fake",
      agentName: "Orbit",
      workspaceDir: dir!,
    });

    const finished = store.runs.get(run.id);
    expect(finished?.state).toBe("failed");

    const failedEvent = store.events.after(0).find((e) => e.run_id === run.id && e.type === "run_failed");
    expect((failedEvent?.payload as { error?: string } | undefined)?.error).toBe("budget_exhausted");
  });

  it("wall-clock watchdog: hang-stall scenario with very short wallClockMs terminates in interrupted state", async () => {
    const start = Date.now();
    const store = testStore();
    const agentId = bootstrapAgent(store);
    const ws = makeWorkstream(store, agentId, "Wall-clock test");

    const spy = spyOnCancel(createFakeAdapter(loadScenario("hang-stall")));
    const supervisor = createRunSupervisor({
      store,
      adapters: { fake: spy.adapter },
      defaultStallMs: 10000, // Long stall so wall-clock trips first
    });

    const run = store.commands.createRun({
      workstream_id: ws,
      trigger: "human_message",
      input_context_ref: "runs/7/context.md",
      engine_id: "fake",
    });

    await supervisor.execute(run, {
      workstreamId: ws,
      trigger: "human_message",
      inputContextRef: "runs/7/context.md",
      engineId: "fake",
      agentName: "Orbit",
      workspaceDir: dir!,
      wallClockMs: 30, // Very short wall-clock timeout
    });

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000); // Should be quick
    expect(spy.cancelCalls()).toBeGreaterThanOrEqual(1);
    expect(store.runs.get(run.id)?.state).toBe("interrupted");
  });

  it("happy-path scenario with generous limits completes normally without false-positive watchdogs", async () => {
    const store = testStore();
    const agentId = bootstrapAgent(store);
    const ws = makeWorkstream(store, agentId, "Happy path watchdog test");

    const supervisor = createRunSupervisor({
      store,
      adapters: { fake: createFakeAdapter(loadScenario("happy-path")) },
      defaultStallMs: 5000,
      defaultWallClockMs: 30000,
      budgetCaps: { costUsd: 1000000 }, // Very high cap
    });

    const run = store.commands.createRun({
      workstream_id: ws,
      trigger: "human_message",
      input_context_ref: "runs/8/context.md",
      engine_id: "fake",
    });

    await supervisor.execute(run, {
      workstreamId: ws,
      trigger: "human_message",
      inputContextRef: "runs/8/context.md",
      engineId: "fake",
      agentName: "Orbit",
      workspaceDir: dir!,
    });

    const finished = store.runs.get(run.id);
    expect(finished?.state).toBe("completed");
    expect(finished?.result?.outcome).toBe("completed");
  });
});
