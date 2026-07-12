/** E9.1 — stream-json → EngineEvent mapping unit tests (pure, no process). */
import { describe, expect, it } from "vitest";
import { mapLine, newMapperState } from "./stream.js";

function mapAll(lines: string[]) {
  const state = newMapperState();
  return { events: lines.flatMap((l) => mapLine(state, l)), state };
}

describe("mapLine — E9.1", () => {
  it("system/init → run_started with sessionRef", () => {
    const { events } = mapAll(['{"type":"system","subtype":"init","session_id":"s1"}']);
    expect(events).toEqual([{ t: "run_started", sessionRef: "s1" }]);
  });

  it("assistant text and tool_use blocks → output_delta + tool_call start (both content locations)", () => {
    const nested = '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"},{"type":"tool_use","id":"t1","name":"Read","input":{"f":1}}]}}';
    const flat = '{"type":"assistant","content":[{"type":"text","text":"hi"}]}';
    const { events } = mapAll([nested, flat]);
    expect(events).toEqual([
      { t: "output_delta", text: "hi" },
      { t: "tool_call", phase: "start", name: "Read", detail: { id: "t1", input: { f: 1 } } },
      { t: "output_delta", text: "hi" },
    ]);
  });

  it("tool_result resolves the name recorded at tool_use time", () => {
    const { events } = mapAll([
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t9","name":"Edit","input":{}}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t9","content":"ok"}]}}',
    ]);
    expect(events[1]).toEqual({ t: "tool_call", phase: "end", name: "Edit", detail: { id: "t9", is_error: false } });
  });

  it("result success → usage_delta then run_ended completed with finalText + sessionRef", () => {
    const { events, state } = mapAll([
      '{"type":"result","subtype":"success","result":"done","session_id":"s2","total_cost_usd":0.5,"usage":{"input_tokens":10,"output_tokens":4},"is_error":false}',
    ]);
    expect(events).toEqual([
      { t: "usage_delta", tokensIn: 10, tokensOut: 4, costUsd: 0.5 },
      { t: "run_ended", outcome: "completed", finalText: "done", sessionRef: "s2" },
    ]);
    expect(state.sawResult).toBe(true);
  });

  it("result error → run_ended failed, preferring error_details.message", () => {
    const { events } = mapAll([
      '{"type":"result","subtype":"error","result":"r","error_details":{"message":"boom","code":"error_api"},"is_error":true,"session_id":"s3"}',
    ]);
    expect(events.at(-1)).toEqual({ t: "run_ended", outcome: "failed", error: "boom", sessionRef: "s3" });
  });

  it("max-turns (legacy subtype or error_details.code) → awaiting_input + run_ended needs_input", () => {
    for (const line of [
      '{"type":"result","subtype":"error_max_turns","is_error":true,"session_id":"s4"}',
      '{"type":"result","subtype":"error","error_details":{"message":"cap","code":"error_max_turns"},"is_error":true,"session_id":"s4"}',
    ]) {
      const { events } = mapAll([line]);
      expect(events.at(-2)?.t).toBe("awaiting_input");
      expect(events.at(-1)).toMatchObject({ t: "run_ended", outcome: "needs_input", sessionRef: "s4" });
    }
  });

  it("tolerates unknown types, unknown fields, and non-JSON noise", () => {
    const { events } = mapAll([
      '{"type":"stream_event","event":{"type":"content_block_delta"}}',
      '{"type":"system","subtype":"api_retry","attempt":1}',
      "not json at all",
      "",
      '{"type":"future_thing","x":1}',
    ]);
    expect(events).toEqual([]);
  });
});
