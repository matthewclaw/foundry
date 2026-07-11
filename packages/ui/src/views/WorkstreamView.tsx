/**
 * E7.4 — Workstream run timeline (doc-06): runs as collapsed cards expanding to
 * the event stream + transcript, with the ADR-003 capability-degradation tag
 * (transcriptSource live/file/none) rendered explicitly — engines that report
 * less show "limited engine detail", never fake detail. Redirect composer POSTs
 * to /api/workstreams/:id/messages.
 */
import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api/client.js";
import type { TimelineRunEntry } from "../api/types.js";

function payloadSummary(payload: unknown): string {
  const s = JSON.stringify(payload);
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

function RunCard({ entry }: { entry: TimelineRunEntry }) {
  const [expanded, setExpanded] = useState(false);
  const { run } = entry;
  const cost = run.usage?.cost_usd;

  return (
    <div data-testid="run-card" className="bg-white border border-gray-200 rounded-lg mb-2 overflow-hidden">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full px-4 py-2 flex items-center gap-3 text-left hover:bg-gray-50"
      >
        <span className="font-semibold text-gray-800 text-sm">Run #{run.seq}</span>
        <span className="text-xs text-gray-500">{run.trigger}</span>
        <span className="text-xs text-gray-700">{run.state}</span>
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
          {entry.transcriptText !== null ? (
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

export default function WorkstreamView() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useQuery({
    queryKey: ["timeline", id],
    queryFn: () => apiClient.getTimeline(id!),
    enabled: !!id,
  });

  if (isLoading) return <div className="p-6 text-gray-500">Loading timeline…</div>;
  if (error)
    return <div className="p-6 text-red-600">Error: {error instanceof Error ? error.message : String(error)}</div>;
  if (!data) return null;

  return (
    <div className="p-6 max-w-3xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-4">Workstream {data.workstreamId}</h1>
      {data.runs.length === 0 ? (
        <p className="text-sm text-gray-500">No runs yet.</p>
      ) : (
        data.runs.map((entry) => <RunCard key={entry.run.id} entry={entry} />)
      )}
      <RedirectComposer workstreamId={id!} />
    </div>
  );
}
