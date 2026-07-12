import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentId, WorkstreamId } from "@foundry/core";
import { createStore, type Store } from "@foundry/store";
import { createFakeAdapter, loadScenario } from "@foundry/adapter-fake";
import type { ExecutionAdapter, RunSpec } from "@foundry/adapter-api";
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

/** Wraps an adapter to observe whether start() or resume() was actually called — the
 * fake adapter's resume() just delegates to start(), so a plain execution-outcome
 * assertion can't distinguish "cold-started" from "resumed the prior session." */
function spyOnStartResume(inner: ExecutionAdapter): {
  adapter: ExecutionAdapter;
  startCalls: () => number;
  resumeCalls: () => (RunSpec & { sessionRef: string })[];
} {
  let startCalls = 0;
  const resumeCalls: (RunSpec & { sessionRef: string })[] = [];
  return {
    startCalls: () => startCalls,
    resumeCalls: () => resumeCalls,
    adapter: {
      id: inner.id,
      capabilities: () => inner.capabilities(),
      start: (spec) => {
        startCalls++;
        return inner.start(spec);
      },
      resume: inner.resume
        ? (spec) => {
            resumeCalls.push(spec);
            return inner.resume!(spec);
          }
        : undefined,
      cancel: (handle) => inner.cancel(handle),
      events: (handle) => inner.events(handle),
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

  it("conversation continuity: a second message on the same workstream resumes the prior session instead of cold-starting", async () => {
    const store = testStore();
    const agentId = bootstrapAgent(store);
    const ws = makeWorkstream(store, agentId, "Chat");

    const spy = spyOnStartResume(createFakeAdapter(loadScenario("happy-path")));
    const supervisor = createRunSupervisor({ store, adapters: { fake: spy.adapter } });

    const run1 = store.commands.createRun({
      workstream_id: ws,
      trigger: "human_message",
      input_context_ref: "runs/1/context.md",
      engine_id: "fake",
    });
    await supervisor.execute(run1, {
      workstreamId: ws,
      trigger: "human_message",
      inputContextRef: "runs/1/context.md",
      engineId: "fake",
      agentName: "Orbit",
      workspaceDir: dir!,
      engineConfig: { scenarioName: "happy-path" },
    });
    expect(store.runs.get(run1.id)?.engine_session_id).toBe("sess-happy-path");
    expect(spy.startCalls()).toBe(1);
    expect(spy.resumeCalls()).toHaveLength(0);

    const run2 = store.commands.createRun({
      workstream_id: ws,
      trigger: "human_message",
      input_context_ref: "runs/2/context.md",
      engine_id: "fake",
    });
    await supervisor.execute(run2, {
      workstreamId: ws,
      trigger: "human_message",
      inputContextRef: "runs/2/context.md",
      engineId: "fake",
      agentName: "Orbit",
      workspaceDir: dir!,
      engineConfig: { scenarioName: "happy-path" },
    });

    // Second run resumed the first run's session — start() was never called again.
    expect(spy.startCalls()).toBe(1);
    expect(spy.resumeCalls()).toHaveLength(1);
    expect(spy.resumeCalls()[0]!.sessionRef).toBe("sess-happy-path");
    expect(store.runs.get(run2.id)?.state).toBe("completed");
  });

  it("conversation continuity: skips past a sessionless run (e.g. a workspace refusal) to the last real session", async () => {
    const store = testStore();
    const agentId = bootstrapAgent(store);
    const ws = makeWorkstream(store, agentId, "Chat with a blip");

    const spy = spyOnStartResume(createFakeAdapter(loadScenario("happy-path")));
    const supervisor = createRunSupervisor({ store, adapters: { fake: spy.adapter } });

    const run1 = store.commands.createRun({
      workstream_id: ws,
      trigger: "human_message",
      input_context_ref: "runs/1/context.md",
      engine_id: "fake",
    });
    await supervisor.execute(run1, {
      workstreamId: ws,
      trigger: "human_message",
      inputContextRef: "runs/1/context.md",
      engineId: "fake",
      agentName: "Orbit",
      workspaceDir: dir!,
      engineConfig: { scenarioName: "happy-path" },
    });
    expect(store.runs.get(run1.id)?.engine_session_id).toBe("sess-happy-path");

    // A run that never got a session — e.g. workspace acquisition refused it before
    // the engine ever started (the exact shape a real "worktree already exists" bug
    // produced live).
    const blip = store.commands.createRun({
      workstream_id: ws,
      trigger: "human_message",
      input_context_ref: "runs/2/context.md",
      engine_id: "fake",
    });
    store.commands.transitionRunState({ id: blip.id, workstreamId: ws, to: "cancelled", actorId: null, reason: "workspace acquisition refused" });
    expect(store.runs.get(blip.id)?.engine_session_id).toBeNull();

    const run3 = store.commands.createRun({
      workstream_id: ws,
      trigger: "human_message",
      input_context_ref: "runs/3/context.md",
      engine_id: "fake",
    });
    await supervisor.execute(run3, {
      workstreamId: ws,
      trigger: "human_message",
      inputContextRef: "runs/3/context.md",
      engineId: "fake",
      agentName: "Orbit",
      workspaceDir: dir!,
      engineConfig: { scenarioName: "happy-path" },
    });

    // Resumed run1's session, not blocked or fooled by the sessionless blip in between.
    expect(spy.startCalls()).toBe(1);
    expect(spy.resumeCalls()).toHaveLength(1);
    expect(spy.resumeCalls()[0]!.sessionRef).toBe("sess-happy-path");
  });

  it("allowResume: false forces a cold start into a new conversation even though a resumable session exists", async () => {
    const store = testStore();
    const agentId = bootstrapAgent(store);
    const ws = makeWorkstream(store, agentId, "New conversation on the same workstream");

    const spy = spyOnStartResume(createFakeAdapter(loadScenario("happy-path")));
    const supervisor = createRunSupervisor({ store, adapters: { fake: spy.adapter } });

    const run1 = store.commands.createRun({
      workstream_id: ws,
      trigger: "human_message",
      input_context_ref: "runs/1/context.md",
      engine_id: "fake",
    });
    await supervisor.execute(run1, {
      workstreamId: ws,
      trigger: "human_message",
      inputContextRef: "runs/1/context.md",
      engineId: "fake",
      agentName: "Orbit",
      workspaceDir: dir!,
      engineConfig: { scenarioName: "happy-path" },
    });
    expect(store.runs.get(run1.id)?.engine_session_id).toBe("sess-happy-path");

    const run2 = store.commands.createRun({
      workstream_id: ws,
      trigger: "human_message",
      input_context_ref: "runs/2/context.md",
      engine_id: "fake",
    });
    await supervisor.execute(run2, {
      workstreamId: ws,
      trigger: "human_message",
      inputContextRef: "runs/2/context.md",
      engineId: "fake",
      agentName: "Orbit",
      workspaceDir: dir!,
      engineConfig: { scenarioName: "happy-path" },
      allowResume: false,
    });

    // Cold-started again — resume() never called despite run1's session being available.
    expect(spy.startCalls()).toBe(2);
    expect(spy.resumeCalls()).toHaveLength(0);
  });

  it("F15: a malformed EngineEvent from a buggy adapter fails the run safely, not the org state", async () => {
    const store = testStore();
    const agentId = bootstrapAgent(store);
    const ws = makeWorkstream(store, agentId, "Buggy adapter");

    // A hand-rolled adapter that yields one valid run_started, then garbage that
    // doesn't match any EngineEvent variant — simulating a real bug in a real adapter,
    // not something the fake adapter's own type-checked scenario DSL could construct.
    const buggyAdapter: ExecutionAdapter = {
      id: "buggy",
      capabilities: () => ({
        resume: false,
        stream_events: true,
        tool_events: false,
        usage: false,
        reasoning_summaries: false,
        permission_hooks: false,
        mcp: false,
      }),
      start: async (spec) => ({ runId: spec.runId, adapterId: "buggy" }),
      cancel: async () => {},
      events: async function* () {
        yield { t: "run_started", sessionRef: "sess-buggy" };
        yield { t: "not_a_real_event", surprise: true } as never;
      },
    };

    const supervisor = createRunSupervisor({ store, adapters: { buggy: buggyAdapter } });
    const run = store.commands.createRun({
      workstream_id: ws,
      trigger: "human_message",
      input_context_ref: "runs/malformed/context.md",
      engine_id: "buggy",
    });

    await supervisor.execute(run, {
      workstreamId: ws,
      trigger: "human_message",
      inputContextRef: "runs/malformed/context.md",
      engineId: "buggy",
      agentName: "Orbit",
      workspaceDir: dir!,
      engineConfig: {},
    });

    // Folds via the same abnormal-termination path as F1/F2 (was "running" when the
    // malformed event arrived) — resumable, not a corrupted/stuck state, and the
    // engine is blamed (the reason names the adapter), not the org state.
    const finished = store.runs.get(run.id);
    expect(finished?.state).toBe("interrupted");
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

describe("resume flow — E4.6", () => {
  it("happy resume: initial scenario crashes, resume completes, run ends completed with final_text from resume", async () => {
    const store = testStore();
    const agentId = bootstrapAgent(store);
    const ws = makeWorkstream(store, agentId, "Resume happy path");

    // Wrapper adapter: start() uses initial (crashes), resume() uses continuation (completes)
    let resumeSpec: any = undefined;
    const initialAdapter = createFakeAdapter(loadScenario("resume-after-interrupt-initial"));
    const continuationAdapter = createFakeAdapter(loadScenario("resume-after-interrupt-continuation"));

    // Mark handles to track which adapter they came from
    const handlerMap = new Map<any, "initial" | "continuation">();

    const continuationScenario = loadScenario("resume-after-interrupt-continuation");

    const wrapperAdapter: ExecutionAdapter = {
      id: "fake",
      capabilities: () => initialAdapter.capabilities(),
      start: async (spec) => {
        const handle = await initialAdapter.start(spec);
        handlerMap.set(handle, "initial");
        return handle;
      },
      resume: async (spec) => {
        resumeSpec = spec;
        // Update engineConfig to use the continuation scenario for the resumed attempt
        const resumeSpecWithContinuation: RunSpec & { sessionRef: string } = {
          ...spec,
          engineConfig: { scenario: continuationScenario },
        };
        const handle = await continuationAdapter.start(resumeSpecWithContinuation);
        handlerMap.set(handle, "continuation");
        return handle;
      },
      cancel: (handle) => {
        const type = handlerMap.get(handle) ?? "initial";
        if (type === "continuation") {
          return continuationAdapter.cancel(handle);
        }
        return initialAdapter.cancel(handle);
      },
      events: (handle) => {
        const type = handlerMap.get(handle) ?? "initial";
        if (type === "continuation") {
          return continuationAdapter.events(handle);
        }
        return initialAdapter.events(handle);
      },
    };

    const supervisor = createRunSupervisor({
      store,
      adapters: { fake: wrapperAdapter },
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
      engineConfig: { scenarioName: "resume-after-interrupt-initial" },
    });

    // Verify resume was called exactly once with sessionRef
    expect(resumeSpec).toBeDefined();
    expect(resumeSpec?.sessionRef).toBe("sess-resume-demo");

    // Final run state should be completed
    const finished = store.runs.get(run.id);
    expect(finished?.state).toBe("completed");
    expect(finished?.result?.final_text).toBe("Completed after resume.");

    // Only one run row for the workstream
    const runs = store.runs.list({ workstream_id: ws });
    expect(runs.length).toBe(1);

    // Check event sequence: must have interrupted, resumed, and completed in order
    const events = store.events.after(0).filter((e) => e.run_id === run.id);
    const types = events.map((e) => e.type);
    expect(types).toContain("run_interrupted");
    expect(types).toContain("run_resumed");
    expect(types).toContain("run_running");
    expect(types).toContain("run_completed");

    const interruptedIdx = types.indexOf("run_interrupted");
    const resumedIdx = types.indexOf("run_resumed");
    const completedIdx = types.indexOf("run_completed");

    // Verify ordering: interrupted -> resumed -> completed (run_running can appear twice: before interrupt and after resume)
    expect(interruptedIdx).toBeLessThan(resumedIdx);
    expect(resumedIdx).toBeLessThan(completedIdx);
  });

  it("resume also dies: resume() returns crashing scenario, run stays interrupted, resume called once", async () => {
    const store = testStore();
    const agentId = bootstrapAgent(store);
    const ws = makeWorkstream(store, agentId, "Resume failure path");

    let resumeCallCount = 0;
    const crashingAdapter = createFakeAdapter(loadScenario("resume-after-interrupt-initial"));
    const wrapperAdapter: ExecutionAdapter = {
      id: "fake",
      capabilities: () => crashingAdapter.capabilities(),
      start: (spec) => crashingAdapter.start(spec),
      resume: async (spec) => {
        resumeCallCount++;
        return crashingAdapter.start(spec);
      },
      cancel: (handle) => crashingAdapter.cancel(handle),
      events: (handle) => crashingAdapter.events(handle),
    };

    const supervisor = createRunSupervisor({
      store,
      adapters: { fake: wrapperAdapter },
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
      agentName: "Orbit",
      workspaceDir: dir!,
      engineConfig: { scenarioName: "resume-after-interrupt-initial" },
    });

    // Resume was called exactly once
    expect(resumeCallCount).toBe(1);

    // Final state interrupted
    const finished = store.runs.get(run.id);
    expect(finished?.state).toBe("interrupted");

    // Exactly one run_resumed event
    const events = store.events.after(0).filter((e) => e.run_id === run.id && e.type === "run_resumed");
    expect(events.length).toBe(1);
  });

  it("resume stream dies before its run_started: folds to failed (no starting→interrupted edge), never throws", async () => {
    const store = testStore();
    const agentId = bootstrapAgent(store);
    const ws = makeWorkstream(store, agentId, "Resume crashes at startup");

    // The resumed engine dies instantly — before emitting run_started — so the run is
    // still `starting` when its stream ends; the only legal fold from there is `failed`.
    const instantCrash = {
      name: "instant-crash",
      description: "dies before run_started",
      steps: [{ type: "crash" as const, message: "died on the launchpad" }],
    };
    let resumeCallCount = 0;
    const initialAdapter = createFakeAdapter(loadScenario("resume-after-interrupt-initial"));
    const crashAdapter = createFakeAdapter(instantCrash);
    // Fake handles carry their scenario, so events()/cancel() can route on it.
    const issuedByCrash = (handle: unknown) =>
      (handle as { scenario?: { name?: string } }).scenario?.name === "instant-crash";
    const wrapperAdapter: ExecutionAdapter = {
      id: "fake",
      capabilities: () => initialAdapter.capabilities(),
      start: (spec) => initialAdapter.start(spec),
      resume: async (spec) => {
        resumeCallCount++;
        return crashAdapter.start({ ...spec, engineConfig: { scenario: instantCrash } });
      },
      cancel: (handle) => (issuedByCrash(handle) ? crashAdapter.cancel(handle) : initialAdapter.cancel(handle)),
      events: (handle) => (issuedByCrash(handle) ? crashAdapter.events(handle) : initialAdapter.events(handle)),
    };

    const supervisor = createRunSupervisor({ store, adapters: { fake: wrapperAdapter } });
    const run = store.commands.createRun({
      workstream_id: ws,
      trigger: "human_message",
      input_context_ref: "runs/9/context.md",
      engine_id: "fake",
    });

    await supervisor.execute(run, {
      workstreamId: ws,
      trigger: "human_message",
      inputContextRef: "runs/9/context.md",
      engineId: "fake",
      agentName: "Orbit",
      workspaceDir: dir!,
      engineConfig: { scenarioName: "resume-after-interrupt-initial" },
    });

    expect(resumeCallCount).toBe(1);
    const finished = store.runs.get(run.id);
    expect(finished?.state).toBe("failed");
    const failedEvent = store.events.after(0).find((e) => e.run_id === run.id && e.type === "run_failed");
    expect((failedEvent?.payload as { error?: string })?.error).toContain("(after resume)");
  });

  it("no resume capability: adapter lacks resume capability, run stays interrupted, no resume attempted", async () => {
    const store = testStore();
    const agentId = bootstrapAgent(store);
    const ws = makeWorkstream(store, agentId, "No resume capability");

    const crashingAdapter = createFakeAdapter(loadScenario("resume-after-interrupt-initial"));
    const wrapperAdapter: ExecutionAdapter = {
      id: "fake",
      capabilities: () => ({ ...crashingAdapter.capabilities(), resume: false }),
      start: (spec) => crashingAdapter.start(spec),
      resume: undefined, // Not provided
      cancel: (handle) => crashingAdapter.cancel(handle),
      events: (handle) => crashingAdapter.events(handle),
    };

    const supervisor = createRunSupervisor({
      store,
      adapters: { fake: wrapperAdapter },
    });

    const run = store.commands.createRun({
      workstream_id: ws,
      trigger: "human_message",
      input_context_ref: "runs/3/context.md",
      engine_id: "fake",
    });

    await supervisor.execute(run, {
      workstreamId: ws,
      trigger: "human_message",
      inputContextRef: "runs/3/context.md",
      engineId: "fake",
      agentName: "Orbit",
      workspaceDir: dir!,
      engineConfig: { scenarioName: "resume-after-interrupt-initial" },
    });

    // Final state interrupted (no resume)
    const finished = store.runs.get(run.id);
    expect(finished?.state).toBe("interrupted");

    // Zero run_resumed events
    const resumedEvents = store.events.after(0).filter((e) => e.run_id === run.id && e.type === "run_resumed");
    expect(resumedEvents.length).toBe(0);
  });

  it("no sessionRef: inline scenario without sessionRef crashes, no resume attempted, engine_session_id null", async () => {
    const store = testStore();
    const agentId = bootstrapAgent(store);
    const ws = makeWorkstream(store, agentId, "No session ref");

    const crashingScenario = {
      name: "no-sessionref-crash",
      description: "Crashes without emitting a sessionRef",
      steps: [
        { type: "event" as const, event: { t: "run_started" as const } },
        { type: "event" as const, event: { t: "output_delta" as const, text: "Starting..." } },
        { type: "crash" as const, message: "no session" },
      ],
    };

    let resumeCalled = false;
    const crashingAdapter = createFakeAdapter(crashingScenario);
    const wrapperAdapter: ExecutionAdapter = {
      id: "fake",
      capabilities: () => crashingAdapter.capabilities(),
      start: (spec) => crashingAdapter.start(spec),
      resume: async () => {
        resumeCalled = true;
        throw new Error("resume should not be called");
      },
      cancel: (handle) => crashingAdapter.cancel(handle),
      events: (handle) => crashingAdapter.events(handle),
    };

    const supervisor = createRunSupervisor({
      store,
      adapters: { fake: wrapperAdapter },
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
      agentName: "Orbit",
      workspaceDir: dir!,
      engineConfig: { scenario: crashingScenario },
    });

    // Resume was not called
    expect(resumeCalled).toBe(false);

    // engine_session_id should be null
    const finished = store.runs.get(run.id);
    expect(finished?.engine_session_id).toBeNull();

    // Zero run_resumed events
    const resumedEvents = store.events.after(0).filter((e) => e.run_id === run.id && e.type === "run_resumed");
    expect(resumedEvents.length).toBe(0);
  });

  it("degraded status: two consecutive failed runs on same workstream result in degraded agent status", async () => {
    const store = testStore();
    const agentId = bootstrapAgent(store);

    // Agent must be in "active" state for status derivation
    store.commands.transitionAgentState({ id: agentId, to: "active", actorId: null });

    const ws = makeWorkstream(store, agentId, "Degraded test");

    // Scenario that completes with a failed outcome (not interrupted)
    const failedScenario = {
      name: "graceful-failure",
      description: "Completes gracefully but with failed outcome",
      steps: [
        { type: "event" as const, event: { t: "run_started" as const, sessionRef: "sess-fail-1" } },
        {
          type: "event" as const,
          event: {
            t: "run_ended" as const,
            outcome: "failed" as const,
            error: "boom",
            sessionRef: "sess-fail-1",
          },
        },
      ],
    };

    const supervisor = createRunSupervisor({
      store,
      adapters: { fake: createFakeAdapter(failedScenario) },
    });

    // First failed run
    const run1 = store.commands.createRun({
      workstream_id: ws,
      trigger: "human_message",
      input_context_ref: "runs/5/context.md",
      engine_id: "fake",
    });

    await supervisor.execute(run1, {
      workstreamId: ws,
      trigger: "human_message",
      inputContextRef: "runs/5/context.md",
      engineId: "fake",
      agentName: "Orbit",
      workspaceDir: dir!,
      engineConfig: { scenario: failedScenario },
    });

    expect(store.runs.get(run1.id)?.state).toBe("failed");

    // Second failed run
    const run2 = store.commands.createRun({
      workstream_id: ws,
      trigger: "human_message",
      input_context_ref: "runs/6/context.md",
      engine_id: "fake",
    });

    await supervisor.execute(run2, {
      workstreamId: ws,
      trigger: "human_message",
      inputContextRef: "runs/6/context.md",
      engineId: "fake",
      agentName: "Orbit",
      workspaceDir: dir!,
      engineConfig: { scenario: failedScenario },
    });

    expect(store.runs.get(run2.id)?.state).toBe("failed");

    // Agent status should be degraded (two consecutive failures)
    const page = store.projections.agentPage(agentId);
    expect(page?.status).toBe("degraded");
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
