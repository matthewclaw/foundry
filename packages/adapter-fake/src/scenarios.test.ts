/**
 * Validates the shipped scenario library (E3.3 AC: "ships >=12 canned scenarios").
 * Scenarios that deliberately violate the well-formed-stream contract (crash, hang, and
 * malformed-event, per their own descriptions) are exercised for their documented
 * behaviour instead of asserted well-formed.
 */
import { describe, expect, it } from "vitest";
import { newRunId } from "@foundry/core";
import type { EngineEvent, RunSpec } from "@foundry/adapter-api";
import { assertWellFormedStream } from "@foundry/adapter-api/conformance";
import { FakeExecutionAdapter } from "./adapter.js";
import { listScenarioNames, loadScenario } from "./scenarios-registry.js";

const MIN_SCENARIOS = 12;

// These deliberately don't end in a well-formed stream — see their `description` field.
const DELIBERATELY_NOT_WELL_FORMED = new Set([
  "engine-crash",
  "hang-stall",
  "malformed-event",
  "resume-after-interrupt-initial",
]);

// These reach a well-formed end only once cancel() unblocks their `hang` step — tested
// separately below rather than via the generic "just consume it" loop.
const REQUIRES_CANCEL_TO_COMPLETE = new Set(["cancel-mid-run", "budget-burn-cutoff"]);

function spec(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    runId: newRunId(),
    agentName: "scenario-fixture-agent",
    contextFile: "/test/context.md",
    workspaceDir: "/test/workspace",
    orgTools: {},
    engineConfig: {},
    limits: { wallClockMs: 30_000 },
    ...overrides,
  };
}

describe("shipped scenario library", () => {
  const names = listScenarioNames();

  it(`ships at least ${MIN_SCENARIOS} canned scenarios`, () => {
    expect(names.length).toBeGreaterThanOrEqual(MIN_SCENARIOS);
  });

  it("every scenario file parses against ScenarioSchema", () => {
    for (const name of names) {
      expect(() => loadScenario(name), name).not.toThrow();
    }
  });

  for (const name of names) {
    if (DELIBERATELY_NOT_WELL_FORMED.has(name) || REQUIRES_CANCEL_TO_COMPLETE.has(name)) continue;

    it(`"${name}" produces a well-formed event stream`, async () => {
      const scenario = loadScenario(name);
      const adapter = new FakeExecutionAdapter(scenario);
      const handle = await adapter.start(spec());
      const events: EngineEvent[] = [];
      for await (const event of adapter.events(handle)) {
        events.push(event);
      }
      assertWellFormedStream(events);
    });
  }

  for (const name of REQUIRES_CANCEL_TO_COMPLETE) {
    it(`"${name}" reaches a well-formed end once cancel() unblocks its hang`, async () => {
      const scenario = loadScenario(name);
      const adapter = new FakeExecutionAdapter(scenario);
      const handle = await adapter.start(spec());
      const events: EngineEvent[] = [];
      let cancelled = false;
      for await (const event of adapter.events(handle)) {
        events.push(event);
        if (!cancelled) {
          cancelled = true;
          await adapter.cancel(handle);
        }
      }
      assertWellFormedStream(events);
    });
  }

  it('"engine-crash" ends the stream abnormally (F1) instead of yielding run_ended', async () => {
    const scenario = loadScenario("engine-crash");
    const adapter = new FakeExecutionAdapter(scenario);
    const handle = await adapter.start(spec());
    const consume = async () => {
      for await (const _event of adapter.events(handle)) {
        // drain
      }
    };
    await expect(consume()).rejects.toThrow();
  });

  it('"hang-stall" never yields a run_ended, even after a forced cancel (F2)', async () => {
    const scenario = loadScenario("hang-stall");
    const adapter = new FakeExecutionAdapter(scenario);
    const handle = await adapter.start(spec());
    const iterator = adapter.events(handle)[Symbol.asyncIterator]();

    const events: EngineEvent[] = [];
    let next = await iterator.next();
    while (!next.done && next.value.t !== "output_delta") {
      events.push(next.value);
      next = await iterator.next();
    }
    if (!next.done) events.push(next.value);

    await adapter.cancel(handle);
    const afterCancel = await iterator.next();
    expect(afterCancel.done).toBe(true);
    expect(events.some((e) => e.t === "run_ended")).toBe(false);
  });

  it('"malformed-event" yields a payload that fails EngineEventSchema, by design (F15)', async () => {
    const scenario = loadScenario("malformed-event");
    const adapter = new FakeExecutionAdapter(scenario);
    const handle = await adapter.start(spec());
    const events: EngineEvent[] = [];
    for await (const event of adapter.events(handle)) {
      events.push(event);
    }
    const last = events[events.length - 1];
    expect(last?.t).toBe("output_delta");
    expect(typeof (last as { text?: unknown } | undefined)?.text).not.toBe("string");
  });

  it("the resume-after-interrupt pair shares a sessionRef across the crash boundary", async () => {
    const initial = loadScenario("resume-after-interrupt-initial");
    const continuation = loadScenario("resume-after-interrupt-continuation");
    const initialSessionRef = initial.steps
      .map((s) => (s.type === "event" ? s.event : null))
      .find((e): e is Extract<EngineEvent, { t: "run_started" }> => e?.t === "run_started")
      ?.sessionRef;
    const continuationSessionRef = continuation.steps
      .map((s) => (s.type === "event" ? s.event : null))
      .find((e): e is Extract<EngineEvent, { t: "run_started" }> => e?.t === "run_started")
      ?.sessionRef;
    expect(initialSessionRef).toBeTruthy();
    expect(initialSessionRef).toBe(continuationSessionRef);
  });
});
