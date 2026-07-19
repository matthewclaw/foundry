/**
 * E7.4 — Workstream conversations: runs group into conversations by shared
 * engine_session_id (a resumed run continues the same engine session — see the
 * runtime's supervisor.ts — so consecutive runs sharing one are, from the engine's
 * point of view, one continuous conversation, not separate "Run #N" cards). Only the
 * most recent conversation is "current" — it gets a message box (POSTs resume:true,
 * continuing that session, unless a drop-in session is attached, in which case the
 * same box sends over the live WebSocket instead — see MessageComposer). "+ New
 * conversation" always starts fresh (resume:false)
 * even though a resumable session exists, becoming the new current conversation.
 * Every conversation can be renamed (PATCH /api/runs/:id/title on its last run).
 *
 * Live streaming: while a run is in flight, its output_delta text streams in over the
 * SSE feed (GET /api/events) into a local buffer and renders like a terminal.
 */
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Markdown from "react-markdown";
import { apiClient } from "../api/client.js";
import { connectFeed } from "../api/sse.js";
import { useInteractiveSession, type InteractiveSession } from "../api/interactive.js";
import type { FeedEvent, TimelineRunEntry } from "../api/types.js";

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

/** The message that triggered this run, if the run_queued event carried one (it does
 * for human_message/redirect — not for e.g. a schedule or approval-decided trigger). */
function triggerMessageText(events: TimelineRunEntry["events"]): string | undefined {
  const queued = events.find((e) => e.type === "run_queued");
  return (queued?.payload as { message_md?: string } | null)?.message_md;
}

/** Consecutive runs sharing a non-null engine_session_id are one conversation (a
 * resume chain); anything else (no session, or a different one — e.g. a deliberate
 * "new conversation" cold start) begins the next group. */
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

/** Formatted view keeps the tool calls (their start) and the usage/cost updates — the
 * rest of the operational events (queued/started/etc.) are already in the header. */
function formattedEvents(events: TimelineRunEntry["events"]): TimelineRunEntry["events"] {
  return events.filter(
    (e) =>
      (e.type === "run_tool_call" && (e.payload as { phase?: string } | null)?.phase === "start") ||
      e.type === "run_usage_updated"
  );
}

function formatToolArgs(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  return Object.entries(input as Record<string, unknown>)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join(", ");
}

function FormattedEventLine({ event, allEvents }: { event: TimelineRunEntry["events"][number], allEvents: TimelineRunEntry["events"] }) {
  if (event.type === "run_usage_updated") {
    const u = event.payload as { tokens_in?: number; tokens_out?: number; cost_usd?: number } | null;
    return (
      <li className="text-xs text-gray-500">
        {u?.tokens_in ?? 0} in / {u?.tokens_out ?? 0} out
        {u?.cost_usd !== undefined && ` — $${u.cost_usd.toFixed(4)}`}
      </li>
    );
  }
  return FormatToolEventLine(event, allEvents.filter(e => e.type === "run_tool_call"));
}
function mapToolEventPayload(payload: unknown) {
  return (payload as {
    name: string,
    phase: "start",
    detail: { id: string, input: unknown }
  } | {
    name: string,
    phase: "end",
    detail: { id: string, is_error: boolean }
  } | {
    name: string,
    phase: string,
    detail: Record<string, unknown> & { id: string }
  })
}
function FormatToolEventLine(event: TimelineRunEntry["events"][number], toolEvents: TimelineRunEntry["events"]) {
  let toolState: '⏳' | '✅' | '❌' | '❗' = '⏳';
  const mainEventPayload = mapToolEventPayload(event.payload);
  const toolPayloads = (toolEvents.map(e => mapToolEventPayload(e.payload)))
    .filter(p => p.detail.id === mainEventPayload.detail.id);
  const endIdx = toolPayloads.findIndex(p => p.phase === 'end');
  if (endIdx > -1) {
    toolState = toolPayloads[endIdx]?.phase === 'end' && toolPayloads[endIdx]?.detail.is_error ? '❌' : '✅';
  }
  const args = mainEventPayload.phase == 'start' && mainEventPayload?.detail?.input ? mainEventPayload.detail.input : {};
  return (
    <li className="text-xs text-gray-500">
      <details><summary>{toolState} <span className="font-medium text-gray-300">{mainEventPayload?.name ?? "tool"}</span></summary>
        {args && <pre><code className="text-gray-500">{JSON.stringify(args, null, 2)}</code></pre>}</details>
    </li>
  );
}
/** One turn within a conversation: the message that started it, its tool activity, and
 * its response. Not independently collapsible — the whole conversation expands as one. */
function TurnBlock({
  entry,
  view,
  liveText,
}: {
  entry: TimelineRunEntry;
  view: "raw" | "formatted";
  liveText: string | undefined;
}) {
  const { run } = entry;
  const cost = run.usage?.cost_usd;
  const isLive = liveText !== undefined && RUN_NONTERMINAL_STATES.has(run.state);
  const text = isLive ? liveText : entry.transcriptText;
  const message = triggerMessageText(entry.events);

  return (
    <div className="mb-4">
      {message && (
        <div className="mb-2 text-sm text-gray-200 bg-gray-800/50 border border-gray-700 rounded p-2 prose prose-sm prose-invert max-w-none">
          <span className="text-xs text-gray-500 mr-1">💬 message:</span>
          <Markdown>{message}</Markdown>
        </div>
      )}
      {view === "raw" && entry.events.length > 0 && (
        <ul className="mb-2 space-y-1">
          {entry.events.map((e) => (
            <li key={e.seq} className="text-xs text-gray-400">
              <span className="text-gray-600">{e.type}</span> {payloadSummary(e.payload)}
            </li>
          ))}
        </ul>
      )}
      {view === "formatted" && formattedEvents(entry.events).length > 0 && (
        <ul className="mb-2 space-y-1">
          {formattedEvents(entry.events).map((e) => (
            <FormattedEventLine key={e.seq} event={e} allEvents={entry.events} />
          ))}
        </ul>
      )}
      {text !== null && text !== undefined ? (
        view === "raw" ? (
          <div>
            <div className={`text-xs mb-1 ${isLive ? "text-green-500" : "text-gray-600"}`}>
              {isLive ? "live output" : `transcript (${entry.transcriptSource})`}
            </div>
            <pre
              className={
                isLive
                  ? "whitespace-pre-wrap text-xs bg-black text-green-400 border border-gray-800 rounded p-2 overflow-x-auto"
                  : "whitespace-pre-wrap text-xs bg-gray-900 text-gray-300 border border-gray-800 rounded p-2 overflow-x-auto"
              }
            >
              {text || "…"}
              {isLive && <span className="animate-pulse">▊</span>}
            </pre>
          </div>
        ) : (
          <div className="text-sm text-gray-200 leading-relaxed bg-gray-900 border border-gray-800 rounded p-3 prose prose-sm prose-invert max-w-none">
            {text ? <Markdown>{text}</Markdown> : "…"}
            {isLive && <span className="animate-pulse">▊</span>}
          </div>
        )
      ) : (run.ended_at &&
        <p className="text-xs text-amber-500">
          No transcript available — this engine reported limited detail for this run (capability degradation, ADR-003).
        </p>
      )}
      <div className="flex items-center gap-2 mb-2 text-xs text-gray-500">
        <span>{run.trigger}</span>
        <span>{run.state}</span>
        {isLive && (
          <span className="text-green-400 bg-green-900/40 px-1.5 py-0.5 rounded animate-pulse">● live</span>
        )}
        {run.ended_at && <span>ended {run.ended_at}</span>}
        {cost !== undefined && <span>${cost.toFixed(4)}</span>}
        {entry.transcriptSource === "none" && (
          <span className="text-amber-400 bg-amber-900/40 px-1.5 py-0.5 rounded">limited engine detail</span>
        )}
      </div>
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  connecting: "connecting…",
  attached: "attached",
  busy: "busy — previous turn still running",
  error: "error",
  closed: "disconnected",
};
const STATUS_CLASS: Record<string, string> = {
  connecting: "text-gray-400",
  attached: "text-green-400",
  busy: "text-amber-400",
  error: "text-red-400",
  closed: "text-gray-500",
};

/** The one message box for a conversation — replaces the old separate "Reply"
 * affordance now that drop-in exists: same textarea either way, it just sends over the
 * live WebSocket (`live` non-null) when attached, or POSTs a headless resume:true
 * message otherwise. Turn CONTENT (text, tool calls) isn't rendered here at all: it
 * arrives through the same SSE-driven timeline every other turn does (this
 * workstream's `useLiveRunText`/refetch above), since an interactive turn is just an
 * ordinary Run folded through the same event catalogue. */
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

  return (
    <div
      className={`mt-3 pt-3 border-t border-gray-800`}
      onClick={(e) => e.stopPropagation()}
    >
      {live && (
        <div className="flex items-center gap-2 mb-2 text-xs">
          <span className="text-green-500">$</span>
          <span className={STATUS_CLASS[live.status]}>
            {live.status === "attached" && live.engineSessionId
              ? `attached (session ${live.engineSessionId.slice(0, 8)})`
              : live.status === "error" && live.errorMessage
                ? live.errorMessage
                : STATUS_LABEL[live.status]}
          </span>
        </div>
      )}
      <textarea
        aria-label="Reply"
        className="w-full h-16 border border-gray-700 bg-gray-900 text-gray-200 text-sm rounded p-2 focus:outline-none focus:border-green-600"
        placeholder={live ? "Type to the live session…" : "Reply…"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={disabled}
      />
      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          className="px-3 py-1 rounded bg-green-700 hover:bg-green-600 text-white text-sm disabled:opacity-50"
          disabled={disabled || !text.trim()}
          onClick={submit}
        >
          {!live && send.isPending ? "Sending…" : "Send"}
        </button>
        {send.error && (
          <span className="text-xs text-red-400">
            {send.error instanceof Error ? send.error.message : String(send.error)}
          </span>
        )}
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
        className="border border-gray-700 bg-gray-900 rounded px-2 py-0.5 text-sm font-semibold text-gray-200 focus:outline-none focus:border-green-600"
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
  const [view, setView] = useState<"raw" | "formatted">("formatted");
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

  useEffect(() => {
    if (anyLive) setExpanded(true);
  }, [anyLive]);

  return (
    <div data-testid="conversation-card" className="bg-gray-900 border border-gray-800 rounded-lg mb-3 overflow-hidden">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded((e) => !e)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") setExpanded((v) => !v);
        }}
        className="w-full px-4 py-2 flex items-center gap-3 text-left hover:bg-gray-800/50 cursor-pointer"
      >
        {renaming ? (
          <RenameControl
            workstreamId={workstreamId}
            targetRunId={lastRun.run.id}
            currentTitle={customTitle ?? displayTitle}
            onDone={() => setRenaming(false)}
          />
        ) : (
          <>
            <span title={title} className="font-semibold text-gray-200 text-sm">{displayTitle}</span>
            <button
              type="button"
              className="text-xs text-gray-500 hover:text-green-400"
              onClick={(e) => {
                e.stopPropagation();
                setRenaming(true);
              }}
            >
              ✎
            </button>
          </>
        )}
        <span className="text-xs text-gray-500">
          {runs.length} turn{runs.length === 1 ? "" : "s"}
        </span>
        {anyLive && (
          <span className="text-xs text-green-400 bg-green-900/40 px-1.5 py-0.5 rounded animate-pulse">● live</span>
        )}
        {totalCost > 0 && <span className="text-xs text-gray-500">${totalCost.toFixed(4)}</span>}
        {anyLimited && (
          <span className="text-xs text-amber-400 bg-amber-900/40 px-1.5 py-0.5 rounded">limited engine detail</span>
        )}
        <div className={`ml-auto inline-flex rounded border border-gray-700 overflow-hidden text-xs`}>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setView("formatted");
            }}
            className={`px-2 py-0.5 ${view === "formatted" ? "bg-gray-700 text-white" : "bg-gray-900 text-gray-500"}`}
          >
            Formatted
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setView("raw");
            }}
            className={`px-2 py-0.5 ${view === "raw" ? "bg-gray-700 text-white" : "bg-gray-900 text-gray-500"}`}
          >
            Raw
          </button>
        </div>
        <span className="text-gray-500">{expanded ? "−" : "+"}</span>
      </div>
      {expanded && (
        <div className="px-4 py-3 border-t border-gray-800">
          <div className="max-h-[32rem] overflow-y-auto">
            {runs.map((entry) => (
              <TurnBlock key={entry.run.id} entry={entry} view={view} liveText={liveText[entry.run.id]} />
            ))}
          </div>
          {lastRun.run.engine_session_id && (
            <button
              type="button"
              title={droppedIn ? "Disconnect from current terminal instance" : "Connect to a terminal instance directly"}
              onClick={(e) => {
                e.stopPropagation();
                setDroppedIn((d) => !d);
                setExpanded(true);
              }}
              className={`mt-2 text-xs px-2 py-0.5 rounded ${droppedIn ? "bg-green-700 text-white" : "border border-gray-700 text-gray-300 hover:bg-gray-800"
                }`}
            >
              {droppedIn ? "Exit live" : "Drop in"}
            </button>
          )}
          {droppedIn && <MessageComposer workstreamId={workstreamId} live={live} />}
          {isCurrent && !droppedIn && <MessageComposer workstreamId={workstreamId} live={null} />}
        </div>
      )}
    </div>
  );
}

/** Always starts a fresh conversation (resume:false) — even if the workstream already
 * has a resumable session, this deliberately doesn't continue it. */
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
    <form
      className="mb-3 bg-gray-900 border border-gray-800 rounded-lg p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (body.trim()) send.mutate(body);
      }}
    >
      <h2 className="font-semibold text-gray-200 mb-2 text-sm">New conversation</h2>
      <textarea
        aria-label="Message"
        className="w-full h-20 border border-gray-700 bg-black text-gray-200 rounded p-2 text-sm focus:outline-none focus:border-green-600"
        placeholder="Say something to this agent to start a new conversation…"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        disabled={send.isPending}
      />
      <div className="mt-2 flex items-center gap-3">
        <button
          type="submit"
          className="px-3 py-1 rounded bg-green-700 hover:bg-green-600 text-white text-sm disabled:opacity-50"
          disabled={send.isPending || !body.trim()}
        >
          {send.isPending ? "Sending…" : "Send message"}
        </button>
        {send.data && <span className="text-xs text-gray-500">run enqueued: {send.data.run_id}</span>}
        {send.error && (
          <span className="text-xs text-red-400">
            {send.error instanceof Error ? send.error.message : String(send.error)}
          </span>
        )}
      </div>
    </form>
  );
}

/**
 * Subscribes to the SSE feed for just this workstream's events, starting from the max
 * seq already present in the fetched timeline (so it doesn't replay this workstream's
 * entire history every time the page opens). Returns a live-text buffer keyed by run
 * id, populated from `run_output_delta` events and cleared once that run's terminal
 * event arrives (the timeline query's own refetch becomes authoritative from there).
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

        // Any event on this workstream should refresh the authoritative timeline
        // (run state badges, final transcript, new run rows) — throttled to avoid a
        // refetch storm during a busy run.
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
    // baselineSeq starts undefined (query still loading) and is set exactly once by
    // the caller (a ref, frozen after its first assignment — see WorkstreamView
    // below) — it must be a dependency so this effect actually fires once the real
    // value becomes available, but since it never changes again after that, this
    // never causes a second, live-text-dropping resubscribe.
  }, [workstreamId, baselineSeq]);

  return liveText;
}

export default function WorkstreamView() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useQuery({
    queryKey: ["timeline", id],
    queryFn: () => apiClient.getTimeline(id!),
    enabled: !!id,
  });
  const [showNewConversation, setShowNewConversation] = useState(false);

  // Baseline seq is captured once (from the first successful fetch) and intentionally
  // not kept in sync with later refetches — connectFeed's own `after` tracking takes
  // over from there for reconnects; re-deriving it on every render would restart the
  // subscription and drop in-flight live text.
  const baselineSeqRef = useRef<number | undefined>(undefined);
  if (baselineSeqRef.current === undefined && data) {
    const allSeqs = data.runs.flatMap((r) => r.events.map((e) => e.seq));
    baselineSeqRef.current = allSeqs.length > 0 ? Math.max(...allSeqs) : 0;
  }
  const liveText = useLiveRunText(id, baselineSeqRef.current);

  if (isLoading) return <div className="p-6 text-gray-500">Loading timeline…</div>;
  if (error)
    return <div className="p-6 text-red-400">Error: {error instanceof Error ? error.message : String(error)}</div>;
  if (!data) return null;

  const conversations = groupIntoConversations(data.runs);

  return (
    <div className="p-6">
      <div className="flex items-center mb-4">
        <h1 className="text-2xl font-bold text-gray-100">
          <span className="text-green-500">$</span> Workstream {data.workstreamId}
        </h1>
        <button
          className="ml-auto px-3 py-1 rounded border border-gray-700 text-sm text-gray-300 hover:bg-gray-800"
          onClick={() => setShowNewConversation((s) => !s)}
        >
          {showNewConversation ? "Cancel" : "+ New conversation"}
        </button>
      </div>
      {showNewConversation && (
        <NewConversationForm workstreamId={id!} onDone={() => setShowNewConversation(false)} />
      )}
      {conversations.length === 0 && !showNewConversation && (
        <p className="text-sm text-gray-500">No conversations yet.</p>
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
