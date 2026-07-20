/**
 * Claude session transcripts embed structured control content as XML-ish tags mixed into
 * message text — slash-command invocations, local command output, and subagent
 * task-notifications (often carrying a long markdown report). Rendered raw it's noise;
 * this splits a message into typed segments and renders each one legibly.
 */
import Markdown from "react-markdown";
import { Icon, cx } from "./ui.js";

export type Segment =
  | { kind: "text"; text: string }
  | { kind: "command"; name: string; args: string }
  | { kind: "stdout"; text: string }
  | { kind: "task"; status: string; summary: string; result: string; tokens?: number; toolUses?: number; durationMs?: number };

// One pass over the three known block shapes. Capture groups:
//   1 command-name · 2 command-args · 3 local-command-stdout · 4 task-notification body
const BLOCK_RE =
  /<command-name>([\s\S]*?)<\/command-name>(?:\s*<command-message>[\s\S]*?<\/command-message>)?(?:\s*<command-args>([\s\S]*?)<\/command-args>)?|<local-command-stdout>([\s\S]*?)<\/local-command-stdout>|<task-notification>([\s\S]*?)<\/task-notification>/g;

function innerTag(body: string, tag: string): string | undefined {
  const m = body.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1]!.trim() : undefined;
}
function innerNum(body: string, tag: string): number | undefined {
  const v = innerTag(body, tag);
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Split a message into text + recognized control blocks, in order. */
export function parseTranscript(raw: string): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  const pushText = (t: string) => {
    const trimmed = t.trim();
    if (trimmed) segments.push({ kind: "text", text: trimmed });
  };

  for (const m of raw.matchAll(BLOCK_RE)) {
    const idx = m.index ?? 0;
    pushText(raw.slice(last, idx));
    last = idx + m[0].length;

    if (m[1] !== undefined) {
      segments.push({ kind: "command", name: m[1].trim(), args: (m[2] ?? "").trim() });
    } else if (m[3] !== undefined) {
      segments.push({ kind: "stdout", text: m[3].trim() });
    } else if (m[4] !== undefined) {
      const body = m[4];
      segments.push({
        kind: "task",
        status: innerTag(body, "status") ?? "completed",
        summary: innerTag(body, "summary") ?? "Task update",
        result: innerTag(body, "result") ?? "",
        tokens: innerNum(body, "subagent_tokens"),
        toolUses: innerNum(body, "tool_uses"),
        durationMs: innerNum(body, "duration_ms"),
      });
    }
  }
  pushText(raw.slice(last));
  return segments;
}

const TASK_STATUS: Record<string, string> = {
  completed: "bg-green-900/40 text-green-300 ring-1 ring-green-500/30",
  failed: "bg-red-900/40 text-red-300 ring-1 ring-red-500/30",
  error: "bg-red-900/40 text-red-300 ring-1 ring-red-500/30",
  cancelled: "bg-gray-800 text-gray-400",
};

function taskMeta(seg: Extract<Segment, { kind: "task" }>): string {
  return [
    seg.tokens !== undefined && `${seg.tokens.toLocaleString("en-US")} tokens`,
    seg.toolUses !== undefined && `${seg.toolUses} tool use${seg.toolUses === 1 ? "" : "s"}`,
    seg.durationMs !== undefined && `${Math.round(seg.durationMs / 1000)}s`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function Prose({ text }: { text: string }) {
  return (
    <div className="prose prose-sm prose-invert max-w-none">
      <Markdown>{text}</Markdown>
    </div>
  );
}

/** Renders one message's parsed segments as a legible stack. */
export function TranscriptBody({ text }: { text: string }) {
  const segments = parseTranscript(text);
  if (segments.length === 0) return null;

  return (
    <div className="space-y-2">
      {segments.map((seg, i) => {
        if (seg.kind === "text") return <Prose key={i} text={seg.text} />;

        if (seg.kind === "command") {
          return (
            <span key={i} className="inline-flex items-center gap-1.5 rounded bg-gray-800 px-2 py-1 font-mono text-xs text-green-300">
              <Icon name="terminal" size={12} />
              {seg.name}
              {seg.args && <span className="text-gray-400">{seg.args}</span>}
            </span>
          );
        }

        if (seg.kind === "stdout") {
          return (
            <div key={i} className="rounded border border-gray-800 bg-gray-950/60 px-3 py-2">
              <div className="mb-1 text-[10px] uppercase tracking-wide text-gray-600">command output</div>
              <pre className="whitespace-pre-wrap font-mono text-xs text-gray-400">{seg.text || "(empty)"}</pre>
            </div>
          );
        }

        // task-notification
        const meta = taskMeta(seg);
        return (
          <details key={i} open className="rounded-md border border-gray-800 bg-gray-950/40">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm">
              <Icon name="users" size={13} className="flex-shrink-0 text-gray-500" />
              <span className={cx("flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium", TASK_STATUS[seg.status] ?? "bg-gray-800 text-gray-400")}>
                {seg.status}
              </span>
              <span className="min-w-0 flex-1 truncate font-medium text-gray-200">{seg.summary}</span>
              {meta && <span className="flex-shrink-0 font-mono text-[11px] text-gray-500">{meta}</span>}
            </summary>
            {seg.result && (
              <div className="border-t border-gray-800 px-3 py-2">
                <Prose text={seg.result} />
              </div>
            )}
          </details>
        );
      })}
    </div>
  );
}
