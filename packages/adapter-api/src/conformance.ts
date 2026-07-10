/**
 * E3.2 — the shared adapter conformance suite (contracts.md: "Also exports the
 * conformance suite: `describeAdapterContract(makeAdapter)`").
 *
 * contracts.md names this export but doesn't pin a signature (OPEN_ISSUES.md #13) — the
 * gap is real: a generic suite can't script an arbitrary adapter's engine-specific
 * behaviour (F1 crash, F2 hang, capability exercise) through `RunSpec.engineConfig` alone,
 * since that field is "adapter-specific, zod-validated by the adapter" and opaque to this
 * package. The chosen shape asks the *adapter package under test* to translate an
 * abstract `ConformanceBehavior` into whatever its own engine needs: the fake adapter
 * (E3.3) does this by synthesising a scenario inline; a fixture-backed adapter (E9) would
 * map each behavior to a specific recorded fixture. Either way `describeAdapterContract`
 * itself never needs to know how.
 *
 * Assertions are exported as plain functions (not buried in `it()` blocks) so this
 * package's own tests can prove the suite actually has teeth — that it fails a
 * deliberately-broken adapter, not just that it passes a well-behaved one.
 */
import { describe, expect, it } from "vitest";
import { newRunId } from "@foundry/core";
import type { CapabilitySet, EngineEvent, EngineEventType, ExecutionAdapter, RunHandle, RunOutcome, RunSpec } from "./types.js";

// --- capability -> event-type honesty map ---
//
// `resume` is honesty-checked via method presence, not an event type (see the dedicated
// resume() test below). `stream_events` and `mcp` have no dedicated EngineEvent type to
// gate on — flagged in OPEN_ISSUES.md #13 rather than silently asserting nothing.
const CAPABILITY_EVENT_TYPES: Partial<Record<keyof CapabilitySet, readonly EngineEventType[]>> = {
  tool_events: ["tool_call"],
  usage: ["usage_delta"],
  reasoning_summaries: ["reasoning_summary"],
  permission_hooks: ["permission_request"],
};

/** Full lifecycle + event-ordering + exactly-one-`run_ended` invariant, in one shot. */
export function assertWellFormedStream(events: readonly EngineEvent[]): void {
  expect(events.length, "expected at least one event").toBeGreaterThan(0);
  expect(events[0]?.t, "first event must be run_started").toBe("run_started");
  const endedIndexes: number[] = [];
  events.forEach((e, i) => {
    if (e.t === "run_ended") endedIndexes.push(i);
  });
  expect(endedIndexes.length, "expected exactly one run_ended event").toBe(1);
  expect(endedIndexes[0], "run_ended must be the last event (no events after it)").toBe(
    events.length - 1
  );
}

/** An undeclared capability must never emit its event type(s), in any collected stream. */
export function assertCapabilityHonesty(
  capabilities: CapabilitySet,
  events: readonly EngineEvent[]
): void {
  for (const [cap, types] of Object.entries(CAPABILITY_EVENT_TYPES) as [
    keyof CapabilitySet,
    readonly EngineEventType[],
  ][]) {
    if (capabilities[cap]) continue;
    for (const e of events) {
      expect(
        types.includes(e.t),
        `capability "${cap}" is not declared but a "${e.t}" event was emitted`
      ).toBe(false);
    }
  }
}

/** Every declared (true) capability must be exercised at least once in the stream. */
export function assertDeclaredCapabilitiesExercised(
  capabilities: CapabilitySet,
  events: readonly EngineEvent[]
): void {
  for (const [cap, types] of Object.entries(CAPABILITY_EVENT_TYPES) as [
    keyof CapabilitySet,
    readonly EngineEventType[],
  ][]) {
    if (!capabilities[cap]) continue;
    const exercised = events.some((e) => types.includes(e.t));
    expect(exercised, `capability "${cap}" is declared but never exercised`).toBe(true);
  }
}

// --- driving an adapter under test ---

export interface ConformanceBehavior {
  /** The outcome `run_ended` should terminate with. */
  outcome: RunOutcome;
  /** Ask the adapter to emit at least one event for every capability it declares true. */
  exerciseDeclaredCapabilities?: boolean;
  /** Ask the adapter to never end on its own — used to drive the cancel-semantics test. */
  neverEnds?: boolean;
}

export type ConformanceAdapterFactory = (
  behavior: ConformanceBehavior
) => ExecutionAdapter | Promise<ExecutionAdapter>;

function buildRunSpec(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    runId: newRunId(),
    agentName: "conformance-agent",
    contextFile: "/conformance/context.md",
    workspaceDir: "/conformance/workspace",
    orgTools: {},
    engineConfig: {},
    limits: { wallClockMs: 30_000 },
    ...overrides,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function consumeUntilDone(
  adapter: ExecutionAdapter,
  handle: RunHandle,
  onEvent: (event: EngineEvent, soFar: readonly EngineEvent[]) => void | Promise<void>,
  timeoutMs = 5000
): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  const iterator = adapter.events(handle)[Symbol.asyncIterator]();
  for (;;) {
    const result = await withTimeout(
      iterator.next(),
      timeoutMs,
      `events() did not settle within ${timeoutMs}ms`
    );
    if (result.done) break;
    events.push(result.value);
    await onEvent(result.value, events);
  }
  return events;
}

function collectEvents(
  adapter: ExecutionAdapter,
  handle: RunHandle,
  timeoutMs = 5000
): Promise<EngineEvent[]> {
  return consumeUntilDone(adapter, handle, () => {}, timeoutMs);
}

/**
 * A Vitest suite any adapter package must pass (E3.2 AC): full lifecycle, cancel
 * semantics, event ordering, exactly-one `run_ended`, capability honesty.
 */
export function describeAdapterContract(makeAdapter: ConformanceAdapterFactory): void {
  describe("adapter contract conformance (@foundry/adapter-api)", () => {
    it("full lifecycle: run_started is the first event emitted", async () => {
      const adapter = await makeAdapter({ outcome: "completed" });
      const handle = await adapter.start(buildRunSpec());
      const events = await collectEvents(adapter, handle);
      expect(events[0]?.t).toBe("run_started");
    });

    it.each(["completed", "needs_input", "failed"] as const)(
      "event ordering: exactly one run_ended, last in the stream, outcome=%s",
      async (outcome) => {
        const adapter = await makeAdapter({ outcome });
        const handle = await adapter.start(buildRunSpec());
        const events = await collectEvents(adapter, handle);
        assertWellFormedStream(events);
        const last = events[events.length - 1];
        if (last?.t === "run_ended") {
          expect(last.outcome).toBe(outcome);
        }
      }
    );

    it(
      "cancel semantics: cancel() during an in-flight run settles the stream at exactly one run_ended{outcome:'cancelled'}",
      async () => {
        const adapter = await makeAdapter({ outcome: "cancelled", neverEnds: true });
        const handle = await adapter.start(buildRunSpec());
        let cancelRequested = false;
        const events = await consumeUntilDone(adapter, handle, async (event) => {
          if (!cancelRequested && event.t === "run_started") {
            cancelRequested = true;
            await adapter.cancel(handle);
          }
        });
        expect(cancelRequested, "adapter never emitted run_started to trigger cancel").toBe(true);
        assertWellFormedStream(events);
        const last = events[events.length - 1];
        expect(last?.t).toBe("run_ended");
        if (last?.t === "run_ended") expect(last.outcome).toBe("cancelled");
      },
      10_000
    );

    it("capability honesty: every declared capability is exercised at least once", async () => {
      const adapter = await makeAdapter({ outcome: "completed", exerciseDeclaredCapabilities: true });
      const capabilities = adapter.capabilities();
      const handle = await adapter.start(buildRunSpec());
      const events = await collectEvents(adapter, handle);
      assertWellFormedStream(events);
      assertDeclaredCapabilitiesExercised(capabilities, events);
      if (capabilities.resume) {
        expect(typeof adapter.resume).toBe("function");
      } else {
        expect(adapter.resume).toBeUndefined();
      }
    });

    it("capability honesty: undeclared capabilities never emit their events", async () => {
      const adapter = await makeAdapter({ outcome: "completed", exerciseDeclaredCapabilities: true });
      const capabilities = adapter.capabilities();
      const handle = await adapter.start(buildRunSpec());
      const events = await collectEvents(adapter, handle);
      assertCapabilityHonesty(capabilities, events);
    });

    it("resume(): present iff declared, and produces another well-formed, single-run_ended stream", async () => {
      const adapter = await makeAdapter({ outcome: "completed" });
      const capabilities = adapter.capabilities();
      if (!capabilities.resume) {
        expect(adapter.resume).toBeUndefined();
        return;
      }
      expect(typeof adapter.resume).toBe("function");

      const firstHandle = await adapter.start(buildRunSpec());
      const firstEvents = await collectEvents(adapter, firstHandle);
      const ended = firstEvents[firstEvents.length - 1];
      const sessionRef = ended?.t === "run_ended" ? ended.sessionRef : undefined;
      expect(sessionRef, "an adapter declaring `resume` must return a sessionRef on run_ended").toBeTruthy();

      const resumeHandle = await adapter.resume!({ ...buildRunSpec(), sessionRef: sessionRef! });
      const resumedEvents = await collectEvents(adapter, resumeHandle);
      assertWellFormedStream(resumedEvents);
    });
  });
}
