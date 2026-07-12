/**
 * E7.4 — Workstream run timeline (doc-06): runs as cards expanding to the event
 * stream + transcript, with the ADR-003 capability-degradation tag (transcriptSource
 * live/file/none) rendered explicitly — engines that report less show "limited engine
 * detail", never fake detail. Redirect composer POSTs to /api/workstreams/:id/messages.
 *
 * Live streaming: while a run is in flight, its output_delta text streams in over the
 * SSE feed (GET /api/events) into a local buffer and renders like a terminal, instead
 * of only a collapsed summary card you'd have to know to click open.
 */
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api/client.js";
import { connectFeed } from "../api/sse.js";
import type { FeedEvent, TimelineRunEntry } from "../api/types.js";

const RUN_TERMINAL_EVENT_TYPES = new Set(["run_completed", "run_failed", "run_cancelled", "run_interrupted"]);
const RUN_NONTERMINAL_STATES = new Set(["queued", "starting", "running", "awaiting_input", "awaiting_approval"]);

function payloadSummary(payload: unknown): string {
  const s = JSON.stringify(payload);
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

/** Formatted view keeps only the tool calls (their start) — the operational events
 * (queued/started/usage-delta/etc.) are already reflected in the header badges. */
function formattedToolCalls(events: TimelineRunEntry["events"]): TimelineRunEntry["events"] {
  return events.filter((e) => e.type === "run_tool_call" && (e.payload as { phase?: string } | null)?.phase === "start");
}

function formatToolArgs(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  return Object.entries(input as Record<string, unknown>)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join(", ");
}

function RunCard({
  entry,
  liveText,
  defaultExpanded,
}: {
  entry: TimelineRunEntry;
  liveText: string | undefined;
  defaultExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [view, setView] = useState<"raw" | "formatted">("raw");
  const { run } = entry;
  const cost = run.usage?.cost_usd;
  const isLive = liveText !== undefined && RUN_NONTERMINAL_STATES.has(run.state);
  const text = isLive ? liveText : entry.transcriptText;

  // A run that goes live after mount (e.g. a message just enqueued one) should pop
  // open on its own — don't make the user know to click it.
  useEffect(() => {
    if (isLive) setExpanded(true);
  }, [isLive]);

  return (
    <div data-testid="run-card" className="bg-white border border-gray-200 rounded-lg mb-2 overflow-hidden">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded((e) => !e)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") setExpanded((v) => !v);
        }}
        className="w-full px-4 py-2 flex items-center gap-3 text-left hover:bg-gray-50 cursor-pointer"
      >
        <span className="font-semibold text-gray-800 text-sm">Run #{run.seq}</span>
        <span className="text-xs text-gray-500">{run.trigger}</span>
        <span className="text-xs text-gray-700">{run.state}</span>
        {isLive && (
          <span className="text-xs text-green-700 bg-green-50 px-1.5 py-0.5 rounded animate-pulse">● live</span>
        )}
        {run.ended_at && <span className="text-xs text-gray-500">ended {run.ended_at}</span>}
        {cost !== undefined && <span className="text-xs text-gray-500">${cost.toFixed(4)}</span>}
        {entry.transcriptSource === "none" && (
          <span className="text-xs text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded">limited engine detail</span>
        )}
        <div className="ml-auto inline-flex rounded border border-gray-300 overflow-hidden text-xs">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setView("raw");
            }}
            className={`px-2 py-0.5 ${view === "raw" ? "bg-gray-800 text-white" : "bg-white text-gray-600"}`}
          >
            Raw
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setView("formatted");
            }}
            className={`px-2 py-0.5 ${view === "formatted" ? "bg-gray-800 text-white" : "bg-white text-gray-600"}`}
          >
            Formatted
          </button>
        </div>
        <span className="text-gray-400">{expanded ? "−" : "+"}</span>
      </div>
      {expanded && (
        <div className="px-4 py-3 border-t border-gray-100">
          {view === "raw" && entry.events.length > 0 && (
            <ul className="mb-3 space-y-1">
              {entry.events.map((e) => (
                <li key={e.seq} className="text-xs text-gray-700 font-mono">
                  <span className="text-gray-500">{e.type}</span> {payloadSummary(e.payload)}
                </li>
              ))}
            </ul>
          )}
          {view === "formatted" && formattedToolCalls(entry.events).length > 0 && (
            <ul className="mb-3 space-y-1">
              {formattedToolCalls(entry.events).map((e) => {
                const p = e.payload as { name?: string; detail?: { input?: unknown } } | null;
                const argSummary = p?.detail?.input ? formatToolArgs(p.detail.input) : "";
                return (
                  <li key={e.seq} className="text-xs text-gray-600">
                    🔧 <span className="font-medium text-gray-800">{p?.name ?? "tool"}</span>
                    {argSummary && <span className="text-gray-400"> — {argSummary}</span>}
                  </li>
                );
              })}
            </ul>
          )}
          {text !== null && text !== undefined ? (
            view === "raw" ? (
              <div>
                <div className={`text-xs mb-1 ${isLive ? "text-green-700" : "text-gray-500"}`}>
                  {isLive ? "live output" : `transcript (${entry.transcriptSource})`}
                </div>
                <pre
                  className={
                    isLive
                      ? "whitespace-pre-wrap text-xs bg-gray-900 text-green-400 border border-gray-800 rounded p-2 overflow-x-auto font-mono"
                      : "whitespace-pre-wrap text-xs bg-gray-50 border border-gray-100 rounded p-2 overflow-x-auto"
                  }
                >
                  {text || "…"}
                  {isLive && <span className="animate-pulse">▊</span>}
                </pre>
              </div>
            ) : (
              <div className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed bg-blue-50 border border-blue-100 rounded p-3">
                {text || "…"}
                {isLive && <span className="animate-pulse">▊</span>}
              </div>
            )
          ) : (
            <p className="text-xs text-amber-700">
              No transcript available — this engine reported limited detail for this run (capability degradation, ADR-003).
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Send a message on this workstream — the first one starts the conversation, an
 * intermediate one course-corrects a run already in flight; both just enqueue a run. */
function MessageComposer({ workstreamId }: { workstreamId: string }) {
  const queryClient = useQueryClient();
  const [body, setBody] = useState("");
  const send = useMutation({
    mutationFn: (body_md: string) => apiClient.postWorkstreamMessage(workstreamId, { kind: "message", body_md }),
    onSuccess: () => {
      setBody("");
      void queryClient.invalidateQueries({ queryKey: ["timeline", workstreamId] });
    },
  });

  return (
    <form
      className="mt-4 bg-white border border-gray-200 rounded-lg p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (body.trim()) send.mutate(body);
      }}
    >
      <h2 className="font-semibold text-gray-800 mb-2 text-sm">Message</h2>
      <textarea
        aria-label="Message"
        className="w-full h-20 border border-gray-300 rounded p-2 text-sm"
        placeholder="Say something to this agent — this starts or continues the conversation…"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        disabled={send.isPending}
      />
      <div className="mt-2 flex items-center gap-3">
        <button
          type="submit"
          className="px-3 py-1 rounded bg-blue-600 text-white text-sm disabled:opacity-50"
          disabled={send.isPending || !body.trim()}
        >
          {send.isPending ? "Sending…" : "Send message"}
        </button>
        {send.data && <span className="text-xs text-gray-600">run enqueued: {send.data.run_id}</span>}
        {send.error && (
          <span className="text-xs text-red-600">
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
    return <div className="p-6 text-red-600">Error: {error instanceof Error ? error.message : String(error)}</div>;
  if (!data) return null;

  const lastRunId = data.runs.length > 0 ? data.runs[data.runs.length - 1]!.run.id : undefined;

  return (
    <div className="p-6 max-w-3xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-4">Workstream {data.workstreamId}</h1>
      {data.runs.length === 0 ? (
        <p className="text-sm text-gray-500">No runs yet.</p>
      ) : (
        data.runs.map((entry) => (
          <RunCard
            key={entry.run.id}
            entry={entry}
            liveText={liveText[entry.run.id]}
            defaultExpanded={entry.run.id === lastRunId}
          />
        ))
      )}
      <MessageComposer workstreamId={id!} />
    </div>
  );
}
