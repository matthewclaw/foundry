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
  const { run } = entry;
  const cost = run.usage?.cost_usd;
  const isLive = liveText !== undefined && RUN_NONTERMINAL_STATES.has(run.state);

  // A run that goes live after mount (e.g. a redirect just enqueued one) should pop
  // open on its own — don't make the user know to click it.
  useEffect(() => {
    if (isLive) setExpanded(true);
  }, [isLive]);

  return (
    <div data-testid="run-card" className="bg-white border border-gray-200 rounded-lg mb-2 overflow-hidden">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full px-4 py-2 flex items-center gap-3 text-left hover:bg-gray-50"
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
        <span className="ml-auto text-gray-400">{expanded ? "−" : "+"}</span>
      </button>
      {expanded && (
        <div className="px-4 py-3 border-t border-gray-100">
          {entry.events.length > 0 && (
            <ul className="mb-3 space-y-1">
              {entry.events.map((e) => (
                <li key={e.seq} className="text-xs text-gray-700 font-mono">
                  <span className="text-gray-500">{e.type}</span> {payloadSummary(e.payload)}
                </li>
              ))}
            </ul>
          )}
          {isLive ? (
            <div>
              <div className="text-xs text-green-700 mb-1">live output</div>
              <pre className="whitespace-pre-wrap text-xs bg-gray-900 text-green-400 border border-gray-800 rounded p-2 overflow-x-auto font-mono">
                {liveText || "…"}
                <span className="animate-pulse">▊</span>
              </pre>
            </div>
          ) : entry.transcriptText !== null ? (
            <div>
              <div className="text-xs text-gray-500 mb-1">transcript ({entry.transcriptSource})</div>
              <pre className="whitespace-pre-wrap text-xs bg-gray-50 border border-gray-100 rounded p-2 overflow-x-auto">
                {entry.transcriptText}
              </pre>
            </div>
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

function RedirectComposer({ workstreamId }: { workstreamId: string }) {
  const queryClient = useQueryClient();
  const [body, setBody] = useState("");
  const send = useMutation({
    mutationFn: (body_md: string) => apiClient.postWorkstreamMessage(workstreamId, { kind: "redirect", body_md }),
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
      <h2 className="font-semibold text-gray-800 mb-2 text-sm">Redirect</h2>
      <textarea
        aria-label="Redirect message"
        className="w-full h-20 border border-gray-300 rounded p-2 text-sm"
        placeholder="Course-correct this workstream…"
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
          {send.isPending ? "Sending…" : "Send redirect"}
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
      <RedirectComposer workstreamId={id!} />
    </div>
  );
}
