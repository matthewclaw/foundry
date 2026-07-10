import { describe, expect, it } from "vitest";
import { CapabilitySetSchema, EngineEventSchema } from "./types.js";

describe("EngineEventSchema", () => {
  const validCases: unknown[] = [
    { t: "run_started" },
    { t: "run_started", sessionRef: "sess-1" },
    { t: "output_delta", text: "hello" },
    { t: "reasoning_summary", text: "because" },
    { t: "tool_call", phase: "start", name: "delegate_task" },
    { t: "tool_call", phase: "end", name: "delegate_task", detail: { task_id: "01J..." } },
    { t: "usage_delta", tokensIn: 10, tokensOut: 5, costUsd: 0.01 },
    { t: "usage_delta" },
    { t: "awaiting_input", prompt: "which repo?" },
    { t: "permission_request", requestId: "perm-1", description: "run `rm`?" },
    { t: "run_ended", outcome: "completed", finalText: "done" },
    { t: "run_ended", outcome: "needs_input" },
    { t: "run_ended", outcome: "failed", error: "boom" },
    { t: "run_ended", outcome: "cancelled" },
  ];

  for (const value of validCases) {
    it(`accepts ${JSON.stringify(value)}`, () => {
      expect(() => EngineEventSchema.parse(value)).not.toThrow();
    });
  }

  const invalidCases: unknown[] = [
    { t: "run_started", sessionRef: 42 },
    { t: "output_delta" }, // missing required text
    { t: "tool_call", phase: "middle", name: "x" }, // phase not in enum
    { t: "run_ended" }, // missing required outcome
    { t: "run_ended", outcome: "done" }, // outcome not in the reused core enum
    { t: "nonexistent_type" },
    {},
  ];

  for (const value of invalidCases) {
    it(`rejects ${JSON.stringify(value)}`, () => {
      expect(() => EngineEventSchema.parse(value)).toThrow();
    });
  }
});

describe("CapabilitySetSchema", () => {
  it("round-trips a fully-declared capability set", () => {
    const caps = {
      resume: true,
      stream_events: true,
      tool_events: false,
      usage: true,
      reasoning_summaries: false,
      permission_hooks: true,
      mcp: true,
    };
    expect(CapabilitySetSchema.parse(caps)).toEqual(caps);
  });

  it("rejects a missing field", () => {
    const { mcp: _mcp, ...missingMcp } = {
      resume: true,
      stream_events: true,
      tool_events: true,
      usage: true,
      reasoning_summaries: true,
      permission_hooks: true,
      mcp: true,
    };
    expect(() => CapabilitySetSchema.parse(missingMcp)).toThrow();
  });
});
