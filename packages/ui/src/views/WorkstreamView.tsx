/**
 * Workstream conversations: runs group into conversations by shared engine_session_id
 * (a resumed run continues the same engine session — see the runtime's supervisor.ts —
 * so consecutive runs sharing one are, from the engine's point of view, one continuous
 * conversation, not separate "Run #N" cards). Only the most recent conversation is
 * "current" — it gets the composer (POSTs resume:true, continuing that session, unless a
 * drop-in session is attached, in which case the same box streams over the live
 * WebSocket). "+ New conversation" always starts fresh (resume:false). Every conversation
 * can be renamed (PATCH /api/runs/:id/title on its last run).
 *
 * Live streaming: while a run is in flight, its output_delta text streams in over the SSE
 * feed (GET /api/events) into a local buffer and renders like a terminal.
 */
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Markdown from "react-markdown";
import { apiClient } from "../api/client.js";
import { connectFeed } from "../api/sse.js";
import { useInteractiveSession, type InteractiveSession } from "../api/interactive.js";
import type { FeedEvent, TimelineRunEntry } from "../api/types.js";
import {
  Button,
  EmptyState,
  ErrorState,
  ErrorText,
  Icon,
  IdChip,
  Loading,
  PageHeader,
  Panel,
  TextArea,
  cx,
} from "../components/ui.js";

const RUN_TERMINAL_EVENT_TYPES = new Set(["run_completed", "run_failed", "run_cancelled", "run_interrupted"]);
const RUN_NONTERMINAL_STATES = new Set(["queued", "starting", "running", "awaiting_input", "awaiting_approval"]);

function payloadSummary(payload: unknown): string {
  const s = JSON.stringify(payload);
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

function truncate(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? `${oneLine.slice(0, n)}…` : oneLine;
}

/** The message that triggered this run, if the run_queued event carried one (it does for
 * human_message/redirect — not for e.g. a schedule or approval-decided trigger). */
function triggerMessageText(events: TimelineRunEntry["events"]): string | undefined {
  const queued = events.find((e) => e.type === "run_queued");
  return (queued?.payload as { message_md?: string } | null)?.message_md;
}

/** Consecutive runs sharing a non-null engine_session_id are one conversation (a resume
 * chain); anything else (no session, or a different one — a deliberate "new conversation"
 * cold start) begins the next group. */
function groupIntoConversations(runs: TimelineRunEntry[]): TimelineRunEntry[][] {
  const groups: TimelineRunEntry[][] = [];
  for (const entry of runs) {
    const sessionId = entry.run.engine_session_id;
    const prevGroup = groups[groups.length - 1];
    const prevEntry = prevGroup?.[prevGroup.length - 1];
    if (prevEntry && sessionId && prevEntry.run.engine_session_id === sessionId) {
      prevGroup.push(entry);
    } else {
      groups.push([entry]);
    }
  }
  return groups;
}

/* --------------------------------------------------------------------- tool calls */

type ToolStatus = "running" | "ok" | "error";
interface ToolCallView {
  key: string;
  name: string;
  status: ToolStatus;
  input: unknown;
}

/** Fold a run's `run_tool_call` events (start/end pairs) into one row per call, pairing
 * by `detail.id` when present and falling back to positional pairing otherwise — engines
 * vary in how much tool detail they report (ADR-003), so this stays defensive rather than
 * assuming a fixed payload shape. */
function toolCalls(events: TimelineRunEntry["events"]): ToolCallView[] {
  const calls: ToolCallView[] = [];
  const byId = new Map<string, number>();
  for (const e of events) {
    if (e.type !== "run_tool_call") continue;
    const p = e.payload as {
      name?: string;
      phase?: string;
      detail?: { id?: string; input?: unknown; is_error?: boolean };
    } | null;
    if (!p) continue;
    const id = p.detail?.id;
    if (p.phase === "start") {
      const idx = calls.length;
      calls.push({ key: id ?? `seq-${e.seq}`, name: p.name ?? "tool", status: "running", input: p.detail?.input });
      if (id) byId.set(id, idx);
    } else if (p.phase === "end") {
      const idx = id !== undefined ? byId.get(id) : calls.length - 1;
      const call = idx !== undefined ? calls[idx] : undefined;
      if (call) call.status = p.detail?.is_error ? "error" : "ok";
    }
  }
  return calls;
}

const TOOL_ICON: Record<ToolStatus, { glyph: string; className: string }> = {
  running: { glyph: "○", className: "text-amber-400" },
  ok: { glyph: "✓", className: "text-green-400" },
  error: { glyph: "✕", className: "text-red-400" },
};

function ToolCallRow({ call }: { call: ToolCallView }) {
  const icon = TOOL_ICON[call.status];
  const hasArgs = call.input !== undefined && call.input !== null;
  return (
    <details className="group text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-2 py-0.5 text-gray-500 hover:text-gray-300">
        <span className={cx("font-mono", icon.className)}>{icon.glyph}</span>
        <span className="font-medium text-gray-300">{call.name}</span>
        {hasArgs && <Icon name="chevron-right" size={11} className="text-gray-600 transition-transform group-open:rotate-90" />}
      </summary>
      {hasArgs && (
        <pre className="mt-1 ml-5 overflow-x-auto rounded bg-gray-950/70 p-2 text-[11px] text-gray-400">
          <code>{JSON.stringify(call.input, null, 2)}</code>
        </pre>
      )}
    </details>
  );
}

function usageLine(events: TimelineRunEntry["events"]): { tokens_in: number; tokens_out: number; cost_usd?: number } | null {
  const usage = events.filter((e) => e.type === "run_usage_updated").pop();
  if (!usage) return null;
  const u = usage.payload as { tokens_in?: number; tokens_out?: number; cost_usd?: number } | null;
  return { tokens_in: u?.tokens_in ?? 0, tokens_out: u?.tokens_out ?? 0, cost_usd: u?.cost_usd };
}

/* -------------------------------------------------------------------------- turns */

/** One turn within a conversation: the message that started it, its tool activity, and
 * its response. Not independently collapsible — the whole conversation expands as one. */
function TurnBlock({
  entry,
  view,
  liveText,
}: {
  entry: TimelineRunEntry;
  view: "formatted" | "raw";
  liveText: string | undefined;
}) {
  const { run } = entry;
  const isLive = liveText !== undefined && RUN_NONTERMINAL_STATES.has(run.state);
  const text = isLive ? liveText : entry.transcriptText;
  const message = triggerMessageText(entry.events);
  const calls = toolCalls(entry.events);
  const usage = usageLine(entry.events);
  const cost = run.usage?.cost_usd;

  return (
    <div className="border-t border-gray-800/60 pt-4 first:border-t-0 first:pt-0">
      {message && (
        <div className="mb-3 flex justify-end">
          <div className="max-w-[85%] rounded-lg rounded-br-sm border border-green-800/40 bg-green-950/30 px-3 py-2 text-sm text-gray-100">
            <div className="mb-0.5 text-[11px] font-medium uppercase tracking-wide text-green-500/80">You</div>
            <div className="prose prose-sm prose-invert max-w-none">
              <Markdown>{message}</Markdown>
            </div>
          </div>
        </div>
      )}

      {view === "raw" ? (
        entry.events.length > 0 && (
          <ul className="mb-2 space-y-1">
            {entry.events.map((e) => (
              <li key={e.seq} className="font-mono text-[11px] text-gray-400">
                <span className="text-gray-600">{e.type}</span> {payloadSummary(e.payload)}
              </li>
            ))}
          </ul>
        )
      ) : (
        (calls.length > 0 || usage) && (
          <div className="mb-3 rounded-md border border-gray-800 bg-gray-950/40 px-3 py-2">
            {calls.map((c) => (
              <ToolCallRow key={c.key} call={c} />
            ))}
            {usage && (
              <div className="mt-1 border-t border-gray-800/60 pt-1 text-[11px] text-gray-500">
                {usage.tokens_in} in / {usage.tokens_out} out
                {usage.cost_usd !== undefined && ` — $${usage.cost_usd.toFixed(4)}`}
              </div>
            )}
          </div>
        )
      )}

      {text !== null && text !== undefined ? (
        view === "raw" ? (
          <div>
            <div className={cx("mb-1 text-xs", isLive ? "text-green-500" : "text-gray-600")}>
              {isLive ? "live output" : `transcript (${entry.transcriptSource})`}
            </div>
            <pre
              className={cx(
                "overflow-x-auto whitespace-pre-wrap rounded-md border p-3 text-xs",
                isLive ? "border-green-900/50 bg-black text-green-300" : "border-gray-800 bg-gray-950/60 text-gray-300"
              )}
            >
              {text || "…"}
              {isLive && <span className="animate-pulse">▊</span>}
            </pre>
          </div>
        ) : (
          <div className="prose prose-sm prose-invert max-w-none text-gray-200">
            {text ? <Markdown>{text}</Markdown> : <span className="text-gray-500">…</span>}
            {isLive && <span className="animate-pulse text-green-400">▊</span>}
          </div>
        )
      ) : (
        run.ended_at && (
          <p className="text-xs text-amber-500/90">
            No transcript available — this engine reported limited detail for this run (capability degradation,
            ADR-003).
          </p>
        )
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-gray-600">
        <span className="font-mono">{run.trigger}</span>
        <span aria-hidden>·</span>
        <span>{run.state}</span>
        {isLive && (
          <span className="animate-pulse rounded bg-green-900/40 px-1.5 py-0.5 text-green-400">● live</span>
        )}
        {run.ended_at && <span>ended {new Date(run.ended_at).toLocaleString()}</span>}
        {cost !== undefined && <span>${cost.toFixed(4)}</span>}
        {entry.transcriptSource === "none" && (
          <span className="rounded bg-amber-900/40 px-1.5 py-0.5 text-amber-400">limited engine detail</span>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ composer */

const LIVE_STATUS: Record<string, { label: string; className: string }> = {
  connecting: { label: "connecting…", className: "text-gray-400" },
  attached: { label: "attached", className: "text-green-400" },
  busy: { label: "busy — the agent is mid-turn", className: "text-amber-400" },
  error: { label: "connection error", className: "text-red-400" },
  closed: { label: "disconnected", className: "text-gray-500" },
};

/** The one composer for a conversation — same textarea whether it queues a headless run
 * (resume:true POST) or streams over the live WebSocket (`live` non-null). The mode is
 * made explicit above the box so the difference is legible, not invisible. */
function MessageComposer({ workstreamId, live }: { workstreamId: string; live: InteractiveSession | null }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const send = useMutation({
    mutationFn: (body_md: string) =>
      apiClient.postWorkstreamMessage(workstreamId, { kind: "message", body_md, resume: true }),
    onSuccess: () => {
      setText("");
      void queryClient.invalidateQueries({ queryKey: ["timeline", workstreamId] });
    },
  });
  const liveDisconnected = live !== null && (live.status === "error" || live.status === "closed");
  const disabled = live !== null ? liveDisconnected : send.isPending;

  const submit = () => {
    if (!text.trim()) return;
    if (live !== null) {
      live.send(text.trim());
      setText("");
    } else {
      send.mutate(text.trim());
    }
  };

  const status = live ? LIVE_STATUS[live.status] : null;

  return (
    <div className="mt-4 border-t border-gray-800 pt-3" onClick={(e) => e.stopPropagation()}>
      <div className="mb-1.5 flex items-center gap-2 text-[11px]">
        {live ? (
          <>
            <span className={cx("h-1.5 w-1.5 rounded-full", live.status === "attached" ? "bg-green-400" : live.status === "busy" ? "bg-amber-400" : "bg-gray-600")} />
            <span className={status?.className}>
              {live.status === "attached" && live.engineSessionId
                ? `Live session · attached (session ${live.engineSessionId.slice(0, 8)}) — interject any time, even mid-turn`
                : live.status === "error" && live.errorMessage
                  ? live.errorMessage
                  : `Live session · ${status?.label ?? live.status}`}
            </span>
          </>
        ) : (
          <span className="text-gray-500">Queues a headless run — fire-and-forget; you can close the tab.</span>
        )}
      </div>
      <TextArea
        aria-label="Reply"
        className="h-20"
        placeholder={live ? "Message the live session…" : "Reply to this conversation…"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
        }}
        disabled={disabled}
      />
      <div className="mt-2 flex items-center gap-3">
        <Button variant="primary" size="sm" disabled={disabled || !text.trim()} onClick={submit}>
          {!live && send.isPending ? "Sending…" : "Send"}
          <span className="ml-1 text-[10px] opacity-60">⌘↵</span>
        </Button>
        {send.error && <ErrorText error={send.error} />}
      </div>
    </div>
  );
}

function RenameControl({
  workstreamId,
  targetRunId,
  currentTitle,
  onDone,
}: {
  workstreamId: string;
  targetRunId: string;
  currentTitle: string;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(currentTitle);
  const rename = useMutation({
    mutationFn: (title: string) => apiClient.setRunTitle(targetRunId, title),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["timeline", workstreamId] });
      onDone();
    },
  });

  return (
    <span className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
      <input
        aria-label="Conversation title"
        className="rounded border border-gray-700 bg-gray-950 px-2 py-0.5 text-sm font-semibold text-gray-200 focus:border-green-600 focus:outline-none"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        disabled={rename.isPending}
        autoFocus
      />
      <button
        type="button"
        className="text-xs text-green-400 hover:underline"
        disabled={rename.isPending || !title.trim()}
        onClick={() => title.trim() && rename.mutate(title.trim())}
      >
        Save
      </button>
      <button type="button" className="text-xs text-gray-500" onClick={onDone}>
        Cancel
      </button>
    </span>
  );
}

/* ------------------------------------------------------------- conversation card */

function ConversationCard({
  workstreamId,
  runs,
  liveText,
  isCurrent,
}: {
  workstreamId: string;
  runs: TimelineRunEntry[];
  liveText: Record<string, string>;
  isCurrent: boolean;
}) {
  const [expanded, setExpanded] = useState(isCurrent);
  const [view, setView] = useState<"formatted" | "raw">("formatted");
  const [renaming, setRenaming] = useState(false);
  const [droppedIn, setDroppedIn] = useState(false);
  const live = useInteractiveSession(workstreamId, droppedIn);

  const lastRun = runs[runs.length - 1]!;
  const customTitle = runs.map((r) => r.run.title).find((t): t is string => !!t);
  const firstMessage = triggerMessageText(runs[0]!.events);
  const title = customTitle ?? (firstMessage ? firstMessage : "Conversation");
  const displayTitle = customTitle ?? truncate(title, 80);

  const anyLive = runs.some(
    (r) => liveText[r.run.id] !== undefined && RUN_NONTERMINAL_STATES.has(r.run.state)
  );
  const totalCost = runs.reduce((sum, r) => sum + (r.run.usage?.cost_usd ?? 0), 0);
  const anyLimited = runs.some((r) => r.transcriptSource === "none");
  const resumable = !!lastRun.run.engine_session_id;

  useEffect(() => {
    if (anyLive) setExpanded(true);
  }, [anyLive]);

  return (
    <Panel
      testId="conversation-card"
      className={cx(
        "mb-3 overflow-hidden transition-colors",
        isCurrent && "border-gray-700",
        anyLive && "border-green-800/60"
      )}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded((e) => !e)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") setExpanded((v) => !v);
        }}
        className="flex w-full cursor-pointer items-center gap-2.5 px-4 py-2.5 text-left hover:bg-gray-800/40"
      >
        <Icon name={expanded ? "chevron-down" : "chevron-right"} size={14} className="flex-shrink-0 text-gray-500" />
        {renaming ? (
          <RenameControl
            workstreamId={workstreamId}
            targetRunId={lastRun.run.id}
            currentTitle={customTitle ?? displayTitle}
            onDone={() => setRenaming(false)}
          />
        ) : (
          <>
            <span title={title} className="truncate text-sm font-semibold text-gray-200">
              {displayTitle}
            </span>
            <button
              type="button"
              aria-label="Rename conversation"
              className="flex-shrink-0 text-gray-600 hover:text-green-400"
              onClick={(e) => {
                e.stopPropagation();
                setRenaming(true);
              }}
            >
              <Icon name="pencil" size={12} />
            </button>
          </>
        )}
        {isCurrent && !renaming && (
          <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-400">
            current
          </span>
        )}
        <span className="ml-auto flex flex-shrink-0 items-center gap-2 text-[11px] text-gray-500">
          <span>{runs.length} turn{runs.length === 1 ? "" : "s"}</span>
          {anyLive && (
            <span className="animate-pulse rounded bg-green-900/40 px-1.5 py-0.5 text-green-400">● live</span>
          )}
          {totalCost > 0 && <span className="font-mono">${totalCost.toFixed(4)}</span>}
          {anyLimited && (
            <span className="rounded bg-amber-900/40 px-1.5 py-0.5 text-amber-400">limited detail</span>
          )}
        </span>
      </div>

      {expanded && (
        <div className="border-t border-gray-800 px-4 py-4">
          <div className="mb-3 flex items-center justify-end">
            <div className="inline-flex overflow-hidden rounded-md border border-gray-700 text-[11px]">
              {(["formatted", "raw"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setView(v);
                  }}
                  className={cx(
                    "px-2.5 py-1",
                    view === v ? "bg-gray-700 text-white" : "bg-transparent text-gray-500 hover:text-gray-300"
                  )}
                >
                  {v === "formatted" ? "Formatted" : "Raw"}
                </button>
              ))}
            </div>
          </div>
          <div className="max-h-[36rem] space-y-4 overflow-y-auto pr-1">
            {runs.map((entry) => (
              <TurnBlock key={entry.run.id} entry={entry} view={view} liveText={liveText[entry.run.id]} />
            ))}
          </div>

          {resumable && (
            <div className="mt-3">
              <button
                type="button"
                title={droppedIn ? "Disconnect from the live process" : "Attach to a warm, live process for this session"}
                onClick={(e) => {
                  e.stopPropagation();
                  setDroppedIn((d) => !d);
                  setExpanded(true);
                }}
                className={cx(
                  "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  droppedIn
                    ? "bg-green-600 text-white hover:bg-green-500"
                    : "border border-gray-700 text-gray-300 hover:bg-gray-800"
                )}
              >
                <Icon name="terminal" size={12} />
                {droppedIn ? "Exit live" : "Drop in"}
              </button>
            </div>
          )}

          {droppedIn && <MessageComposer workstreamId={workstreamId} live={live} />}
          {isCurrent && !droppedIn && <MessageComposer workstreamId={workstreamId} live={null} />}
        </div>
      )}
    </Panel>
  );
}

/** Always starts a fresh conversation (resume:false) — even if the workstream already has
 * a resumable session, this deliberately doesn't continue it. */
function NewConversationForm({ workstreamId, onDone }: { workstreamId: string; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [body, setBody] = useState("");
  const send = useMutation({
    mutationFn: (body_md: string) =>
      apiClient.postWorkstreamMessage(workstreamId, { kind: "message", body_md, resume: false }),
    onSuccess: () => {
      setBody("");
      void queryClient.invalidateQueries({ queryKey: ["timeline", workstreamId] });
      onDone();
    },
  });

  return (
    <Panel className="mb-4 p-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (body.trim()) send.mutate(body);
        }}
      >
        <h2 className="mb-1 text-sm font-semibold text-gray-200">New conversation</h2>
        <p className="mb-2 text-xs text-gray-500">
          Starts a clean session — this deliberately does not resume the previous one.
        </p>
        <TextArea
          aria-label="Message"
          className="h-24"
          placeholder="Say something to this agent to start a fresh conversation…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={send.isPending}
        />
        <div className="mt-2 flex items-center gap-3">
          <Button type="submit" variant="primary" size="sm" disabled={send.isPending || !body.trim()}>
            {send.isPending ? "Sending…" : "Send message"}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onDone}>
            Cancel
          </Button>
          {send.error && <ErrorText error={send.error} />}
        </div>
      </form>
    </Panel>
  );
}

/**
 * Subscribes to the SSE feed for just this workstream's events, starting from the max seq
 * already present in the fetched timeline (so it doesn't replay this workstream's entire
 * history every time the page opens). Returns a live-text buffer keyed by run id,
 * populated from `run_output_delta` events and cleared once that run's terminal event
 * arrives (the timeline query's own refetch becomes authoritative from there).
 */
function useLiveRunText(workstreamId: string | undefined, baselineSeq: number | undefined): Record<string, string> {
  const [liveText, setLiveText] = useState<Record<string, string>>({});
  const queryClient = useQueryClient();
  const invalidateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!workstreamId || baselineSeq === undefined) return;
    setLiveText({});

    const connection = connectFeed({
      after: baselineSeq,
      onEvent: (event: FeedEvent) => {
        if (event.workstream_id !== workstreamId) return;

        if (event.type === "run_output_delta" && event.run_id) {
          const text = (event.payload as { text?: string } | null)?.text;
          if (text) {
            const runId = event.run_id;
            setLiveText((prev) => ({ ...prev, [runId]: (prev[runId] ?? "") + text }));
          }
        } else if (RUN_TERMINAL_EVENT_TYPES.has(event.type) && event.run_id) {
          const runId = event.run_id;
          setLiveText((prev) => {
            if (!(runId in prev)) return prev;
            const next = { ...prev };
            delete next[runId];
            return next;
          });
        }

        // Any event on this workstream should refresh the authoritative timeline (run
        // state badges, final transcript, new run rows) — throttled to avoid a refetch
        // storm during a busy run.
        if (!invalidateTimer.current) {
          invalidateTimer.current = setTimeout(() => {
            invalidateTimer.current = null;
            void queryClient.invalidateQueries({ queryKey: ["timeline", workstreamId] });
          }, 500);
        }
      },
      onError: (error) => console.error("workstream event feed:", error.message),
    });

    return () => {
      if (invalidateTimer.current) clearTimeout(invalidateTimer.current);
      connection.disconnect();
    };
    // baselineSeq starts undefined (query still loading) and is set exactly once by the
    // caller (a ref, frozen after first assignment) — it must be a dependency so this
    // effect fires once the real value becomes available, but since it never changes
    // again, this never causes a second, live-text-dropping resubscribe.
  }, [workstreamId, baselineSeq]);

  return liveText;
}

const WS_STATE_CLASS: Record<string, string> = {
  open: "text-gray-400",
  active: "text-green-400",
  waiting: "text-amber-400",
  blocked: "text-red-400",
  review: "text-blue-400",
  closed: "text-gray-500",
};

export default function WorkstreamView() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useQuery({
    queryKey: ["timeline", id],
    queryFn: () => apiClient.getTimeline(id!),
    enabled: !!id,
  });
  const [showNewConversation, setShowNewConversation] = useState(false);

  // Baseline seq is captured once (from the first successful fetch) and intentionally not
  // kept in sync with later refetches — connectFeed's own `after` tracking takes over from
  // there; re-deriving it on every render would restart the subscription and drop
  // in-flight live text.
  const baselineSeqRef = useRef<number | undefined>(undefined);
  if (baselineSeqRef.current === undefined && data) {
    const allSeqs = data.runs.flatMap((r) => r.events.map((e) => e.seq));
    baselineSeqRef.current = allSeqs.length > 0 ? Math.max(...allSeqs) : 0;
  }
  const liveText = useLiveRunText(id, baselineSeqRef.current);

  if (isLoading) return <Loading label="Loading conversation…" />;
  if (error) return <ErrorState error={error} />;
  if (!data) return null;

  const conversations = groupIntoConversations(data.runs);
  const header = data.workstream;
  const agent = header?.agent;

  return (
    <div className="mx-auto max-w-4xl p-6">
      <PageHeader
        breadcrumb={
          agent ? (
            <Link to={`/agents/${agent.id}`} className="inline-flex items-center gap-1 hover:text-gray-300">
              <Icon name="arrow-left" size={12} /> {agent.name}
            </Link>
          ) : (
            <span>Workstream</span>
          )
        }
        title={header?.title ?? "Workstream"}
        subtitle={
          <div className="flex flex-wrap items-center gap-2">
            {header && (
              <span className={cx("font-medium", WS_STATE_CLASS[header.state] ?? "text-gray-400")}>{header.state}</span>
            )}
            {header?.goal_md && (
              <>
                <span className="text-gray-700" aria-hidden>·</span>
                <span className="truncate text-gray-400">{truncate(header.goal_md, 100)}</span>
              </>
            )}
            <IdChip className="ml-1" title={data.workstreamId}>{data.workstreamId.slice(0, 10)}</IdChip>
          </div>
        }
        actions={
          <Button variant="secondary" size="sm" onClick={() => setShowNewConversation((s) => !s)}>
            {showNewConversation ? "Cancel" : "+ New conversation"}
          </Button>
        }
      />

      {showNewConversation && (
        <NewConversationForm workstreamId={id!} onDone={() => setShowNewConversation(false)} />
      )}

      {conversations.length === 0 && !showNewConversation && (
        <Panel className="p-2">
          <EmptyState
            icon={<Icon name="message" size={28} />}
            title="No conversations yet."
            hint="Start the first conversation to give this agent something to work on."
            action={
              <Button variant="primary" size="sm" onClick={() => setShowNewConversation(true)}>
                Start a conversation
              </Button>
            }
          />
        </Panel>
      )}

      {conversations.map((runsInGroup, i) => (
        <ConversationCard
          key={runsInGroup[0]!.run.id}
          workstreamId={id!}
          runs={runsInGroup}
          liveText={liveText}
          isCurrent={i === conversations.length - 1}
        />
      ))}
    </div>
  );
}
