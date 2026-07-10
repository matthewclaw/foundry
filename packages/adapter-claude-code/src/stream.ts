/**
 * E9.1 — stream-json → EngineEvent mapping. `claude -p --output-format stream-json
 * --verbose` emits NDJSON; each line is one message. This module is pure (line in,
 * events out) so the mapping is testable without a process, and the adapter replays
 * recorded fixtures through the exact same code path as live output.
 *
 * Tolerance rule: unknown message types and unknown fields are IGNORED, never fatal —
 * the CLI's schema grows over time and an adapter that crashes on a new field would
 * violate "degrade, don't gate" (ADR-003).
 */
import type { EngineEvent } from "@foundry/adapter-api";

/** Per-run mapping state: tool_use id → name (tool_result lines don't repeat the name). */
export interface StreamMapperState {
  toolNames: Map<string, string>;
  sessionRef?: string;
  sawResult: boolean;
}

export function newMapperState(): StreamMapperState {
  return { toolNames: new Map(), sawResult: false };
}

/** Maps one NDJSON line to zero or more EngineEvents. Malformed JSON lines are skipped. */
export function mapLine(state: StreamMapperState, line: string): EngineEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return []; // not JSON (stray CLI noise) — ignore
  }

  switch (msg.type) {
    case "system":
      if (msg.subtype === "init" && typeof msg.session_id === "string") {
        state.sessionRef = msg.session_id;
        return [{ t: "run_started", sessionRef: msg.session_id }];
      }
      return [];

    case "assistant":
      return contentBlocks(msg).flatMap((block): EngineEvent[] => {
        if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
          return [{ t: "output_delta", text: block.text }];
        }
        if (block.type === "tool_use" && typeof block.name === "string") {
          const id = typeof block.id === "string" ? block.id : "";
          if (id) state.toolNames.set(id, block.name);
          return [{ t: "tool_call", phase: "start", name: block.name, detail: { id, input: block.input } }];
        }
        return [];
      });

    case "user":
      return contentBlocks(msg).flatMap((block): EngineEvent[] => {
        if (block.type === "tool_result") {
          const id = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
          const name = state.toolNames.get(id) ?? "unknown";
          return [{ t: "tool_call", phase: "end", name, detail: { id, is_error: block.is_error === true } }];
        }
        return [];
      });

    case "result": {
      state.sawResult = true;
      const events: EngineEvent[] = [];
      const usage = (msg.usage ?? {}) as Record<string, unknown>;
      const tokensIn = typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
      const tokensOut = typeof usage.output_tokens === "number" ? usage.output_tokens : undefined;
      const costUsd = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : undefined;
      if (tokensIn !== undefined || tokensOut !== undefined || costUsd !== undefined) {
        events.push({ t: "usage_delta", tokensIn, tokensOut, costUsd });
      }
      const sessionRef = typeof msg.session_id === "string" ? msg.session_id : state.sessionRef;
      const subtype = typeof msg.subtype === "string" ? msg.subtype : "";
      // Error identity moved between CLI versions: legacy `subtype: "error_max_turns"`
      // vs current `subtype: "error"` + `error_details.code` — accept both.
      const errorCode = ((msg.error_details as Record<string, unknown> | undefined)?.code as string | undefined) ?? subtype;
      if (errorCode === "error_max_turns") {
        // The engine stopped mid-work at its turn cap — not a failure, a pause that a
        // resume (same session) continues. Mapped to the awaiting_input/needs_input
        // pair the run supervisor expects.
        events.push({ t: "awaiting_input", prompt: "Engine reached its max-turns cap; resume to continue." });
        events.push({ t: "run_ended", outcome: "needs_input", sessionRef });
        return events;
      }
      const failed = msg.is_error === true || subtype.startsWith("error");
      events.push(
        failed
          ? {
              t: "run_ended",
              outcome: "failed",
              error:
                ((msg.error_details as Record<string, unknown> | undefined)?.message as string | undefined) ??
                (typeof msg.result === "string" ? msg.result : subtype || "error"),
              sessionRef,
            }
          : {
              t: "run_ended",
              outcome: "completed",
              finalText: typeof msg.result === "string" ? msg.result : undefined,
              sessionRef,
            }
      );
      return events;
    }

    default:
      return []; // unknown type — tolerated by contract
  }
}

function contentBlocks(msg: Record<string, unknown>): Record<string, unknown>[] {
  // Docs show content directly on the message line; some CLI versions nest the full API
  // message under `message`. Accept both.
  const message = msg.message as Record<string, unknown> | undefined;
  const content = message?.content ?? msg.content;
  return Array.isArray(content) ? (content as Record<string, unknown>[]) : [];
}
