/**
 * Meta-tests for the conformance suite's building blocks. `describeAdapterContract`
 * itself only ever runs against well-behaved adapters (fake, later claude-code) — these
 * tests prove the assertion functions it's built from actually reject bad event streams,
 * so a green fake-adapter run is evidence of conformance and not a suite with no teeth.
 */
import { describe, expect, it } from "vitest";
import type { CapabilitySet, EngineEvent } from "./types.js";
import {
  assertCapabilityHonesty,
  assertDeclaredCapabilitiesExercised,
  assertWellFormedStream,
} from "./conformance.js";

const started: EngineEvent = { t: "run_started", sessionRef: "sess-1" };
const ended: EngineEvent = { t: "run_ended", outcome: "completed", finalText: "ok" };
const output: EngineEvent = { t: "output_delta", text: "hi" };

describe("assertWellFormedStream", () => {
  it("passes a minimal valid stream", () => {
    expect(() => assertWellFormedStream([started, output, ended])).not.toThrow();
  });

  it("rejects an empty stream", () => {
    expect(() => assertWellFormedStream([])).toThrow();
  });

  it("rejects a stream that doesn't start with run_started", () => {
    expect(() => assertWellFormedStream([output, ended])).toThrow();
  });

  it("rejects a stream with zero run_ended events", () => {
    expect(() => assertWellFormedStream([started, output])).toThrow();
  });

  it("rejects a stream with two run_ended events", () => {
    expect(() => assertWellFormedStream([started, ended, ended])).toThrow();
  });

  it("rejects events emitted after run_ended", () => {
    expect(() => assertWellFormedStream([started, ended, output])).toThrow();
  });
});

const allTrue: CapabilitySet = {
  resume: true,
  stream_events: true,
  tool_events: true,
  usage: true,
  reasoning_summaries: true,
  permission_hooks: true,
  mcp: true,
};
const allFalse: CapabilitySet = {
  resume: false,
  stream_events: false,
  tool_events: false,
  usage: false,
  reasoning_summaries: false,
  permission_hooks: false,
  mcp: false,
};

describe("assertCapabilityHonesty", () => {
  it("passes when an undeclared capability's event never appears", () => {
    expect(() => assertCapabilityHonesty(allFalse, [started, output, ended])).not.toThrow();
  });

  it("fails when tool_events is undeclared but a tool_call is emitted", () => {
    const toolCall: EngineEvent = { t: "tool_call", phase: "start", name: "x" };
    expect(() => assertCapabilityHonesty(allFalse, [started, toolCall, ended])).toThrow();
  });

  it("fails when usage is undeclared but a usage_delta is emitted", () => {
    const usage: EngineEvent = { t: "usage_delta", tokensIn: 1 };
    expect(() => assertCapabilityHonesty(allFalse, [started, usage, ended])).toThrow();
  });

  it("allows any event when the capability is declared", () => {
    const usage: EngineEvent = { t: "usage_delta", tokensIn: 1 };
    expect(() => assertCapabilityHonesty(allTrue, [started, usage, ended])).not.toThrow();
  });
});

describe("assertDeclaredCapabilitiesExercised", () => {
  it("fails when a declared capability is never exercised", () => {
    expect(() => assertDeclaredCapabilitiesExercised(allTrue, [started, output, ended])).toThrow();
  });

  it("passes when every declared capability's event type appears", () => {
    const events: EngineEvent[] = [
      started,
      { t: "tool_call", phase: "start", name: "x" },
      { t: "tool_call", phase: "end", name: "x" },
      { t: "usage_delta", tokensIn: 1 },
      { t: "reasoning_summary", text: "why" },
      { t: "permission_request", requestId: "p1", description: "ok?" },
      ended,
    ];
    expect(() => assertDeclaredCapabilitiesExercised(allTrue, events)).not.toThrow();
  });

  it("skips capabilities that aren't declared", () => {
    expect(() => assertDeclaredCapabilitiesExercised(allFalse, [started, ended])).not.toThrow();
  });
});
