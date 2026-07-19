import { describe, expect, it } from "vitest";
import { newRunId } from "@foundry/core";
import type { EngineEvent, RunSpec } from "@foundry/adapter-api";
import { createFakeAdapter, FakeExecutionAdapter } from "./adapter.js";
import type { Scenario } from "./scenario.js";

function spec(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    runId: newRunId(),
    agentName: "test-agent",
    contextFile: "/test/context.md",
    workspaceDir: "/test/workspace",
    orgTools: {},
    engineConfig: {},
    limits: { wallClockMs: 30_000 },
    ...overrides,
  };
}

async function collect(adapter: FakeExecutionAdapter, handle: Awaited<ReturnType<FakeExecutionAdapter["start"]>>) {
  const events: EngineEvent[] = [];
  for await (const event of adapter.events(handle)) {
    events.push(event);
  }
  return events;
}

const happyScenario: Scenario = {
  name: "happy",
  description: "test fixture",
  steps: [
    { type: "event", event: { t: "run_started" } },
    { type: "event", event: { t: "output_delta", text: "hi" } },
    { type: "event", event: { t: "run_ended", outcome: "completed", finalText: "done" } },
  ],
};

describe("FakeExecutionAdapter", () => {
  it("declares every optional capability (ADR-010), except interactive (no scripted attach yet)", () => {
    const adapter = createFakeAdapter(happyScenario);
    expect(adapter.capabilities()).toEqual({
      resume: true,
      stream_events: true,
      tool_events: true,
      usage: true,
      reasoning_summaries: true,
      permission_hooks: true,
      mcp: true,
      interactive: false,
    });
  });

  it("replays its default scenario's steps as events", async () => {
    const adapter = new FakeExecutionAdapter(happyScenario);
    const handle = await adapter.start(spec());
    const events = await collect(adapter, handle);
    expect(events.map((e) => e.t)).toEqual(["run_started", "output_delta", "run_ended"]);
  });

  it("a crash step makes events() throw instead of yielding run_ended (F1)", async () => {
    const crashScenario: Scenario = {
      name: "crash",
      description: "test fixture",
      steps: [
        { type: "event", event: { t: "run_started" } },
        { type: "crash", message: "engine died" },
      ],
    };
    const adapter = new FakeExecutionAdapter(crashScenario);
    const handle = await adapter.start(spec());
    await expect(collect(adapter, handle)).rejects.toThrow("engine died");
  });

  it("a hang step blocks until cancel(), then the scenario proceeds to its next step", async () => {
    const hangThenEnd: Scenario = {
      name: "hang-then-cancel",
      description: "test fixture",
      steps: [
        { type: "event", event: { t: "run_started" } },
        { type: "hang" },
        { type: "event", event: { t: "run_ended", outcome: "cancelled" } },
      ],
    };
    const adapter = new FakeExecutionAdapter(hangThenEnd);
    const handle = await adapter.start(spec());

    const events: EngineEvent[] = [];
    const consuming = (async () => {
      for await (const event of adapter.events(handle)) {
        events.push(event);
        if (event.t === "run_started") {
          await adapter.cancel(handle);
        }
      }
    })();

    await consuming;
    expect(events.map((e) => e.t)).toEqual(["run_started", "run_ended"]);
    const last = events[events.length - 1];
    expect(last?.t === "run_ended" && last.outcome).toBe("cancelled");
  }, 10_000);

  it("a true hang (no step after it) never yields again, even after cancel", async () => {
    const trueHang: Scenario = {
      name: "true-hang",
      description: "test fixture",
      steps: [{ type: "event", event: { t: "run_started" } }, { type: "hang" }],
    };
    const adapter = new FakeExecutionAdapter(trueHang);
    const handle = await adapter.start(spec());

    const events: EngineEvent[] = [];
    const iterator = adapter.events(handle)[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    if (!first.done) events.push(first.value);

    await adapter.cancel(handle);
    const second = await iterator.next();
    expect(second.done).toBe(true);
    expect(events.map((e) => e.t)).toEqual(["run_started"]);
  });

  it("a malformed_event step yields its raw payload unvalidated (F15)", async () => {
    const malformed: Scenario = {
      name: "malformed",
      description: "test fixture",
      steps: [
        { type: "event", event: { t: "run_started" } },
        { type: "malformed_event", payload: { t: "not_a_real_event_type", oops: true } },
      ],
    };
    const adapter = new FakeExecutionAdapter(malformed);
    const handle = await adapter.start(spec());
    const events = await collect(adapter, handle);
    expect(events).toEqual([{ t: "run_started" }, { t: "not_a_real_event_type", oops: true }]);
  });

  it("engineConfig.scenarioName overrides the default scenario for that call", async () => {
    const otherScenario: Scenario = {
      name: "other",
      description: "test fixture",
      steps: [{ type: "event", event: { t: "run_ended", outcome: "failed", error: "nope" } }],
    };
    // scenarios-registry loads from disk by name; use an inline override instead so this
    // test doesn't depend on the shipped scenario library's contents.
    const adapter = new FakeExecutionAdapter(happyScenario);
    const handle = await adapter.start(spec({ engineConfig: { scenario: otherScenario } }));
    const events = await collect(adapter, handle);
    expect(events).toEqual(otherScenario.steps.map((s) => (s.type === "event" ? s.event : null)));
  });

  it("resume() can be given a different scenario than start() (resume-after-interrupt)", async () => {
    const crashesOnFirstAttempt: Scenario = {
      name: "crashes",
      description: "test fixture",
      steps: [
        { type: "event", event: { t: "run_started", sessionRef: "sess-1" } },
        { type: "crash", message: "simulated interrupt" },
      ],
    };
    const completesOnResume: Scenario = {
      name: "completes",
      description: "test fixture",
      steps: [
        { type: "event", event: { t: "run_started", sessionRef: "sess-1" } },
        { type: "event", event: { t: "run_ended", outcome: "completed", sessionRef: "sess-1" } },
      ],
    };

    const adapter = new FakeExecutionAdapter(happyScenario);
    const firstHandle = await adapter.start(spec({ engineConfig: { scenario: crashesOnFirstAttempt } }));
    await expect(collect(adapter, firstHandle)).rejects.toThrow("simulated interrupt");

    const resumeHandle = await adapter.resume({
      ...spec({ engineConfig: { scenario: completesOnResume } }),
      sessionRef: "sess-1",
    });
    const resumedEvents = await collect(adapter, resumeHandle);
    expect(resumedEvents.map((e) => e.t)).toEqual(["run_started", "run_ended"]);
  });
});
