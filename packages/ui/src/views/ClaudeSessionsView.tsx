/**
 * Read-only browser for Claude Code's own on-disk chat sessions, grouped by the repo
 * folder they belong to — whether Foundry started the session or a human ran `claude`
 * directly in a terminal (GET /api/claude-sessions, packages/server/src/claudeSessions).
 */
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import Markdown from "react-markdown";
import { apiClient } from "../api/client.js";
import type { ClaudeSessionGroupDto, ClaudeSessionSummaryDto } from "../api/types.js";

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

/** git-style short-hash chip: first 8 chars, full file path on hover via the native
 * `title` tooltip, click reveals the file in the OS file browser (packages/server's
 * revealInFileExplorer). A real `<button>` so it can sit inside the row's clickable
 * area without triggering the row's own expand/collapse (stopPropagation). */
function IdChip({ id, filePath, projectDir }: { id: string; filePath: string; projectDir: string }) {
  const reveal = useMutation({
    mutationFn: () => apiClient.revealClaudeSession(projectDir, id),
  });

  return (
    <button
      type="button"
      title={filePath}
      onClick={(e) => {
        e.stopPropagation();
        reveal.mutate();
      }}
      className="font-mono text-xs bg-gray-800 text-gray-300 px-1.5 py-0.5 rounded-full flex-shrink-0 hover:bg-gray-700"
    >
      {id.slice(0, 8)}
    </button>
  );
}

function SessionRow({ projectDir, session }: { projectDir: string; session: ClaudeSessionSummaryDto }) {
  const [expanded, setExpanded] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ["claude-session", projectDir, session.id],
    queryFn: () => apiClient.getClaudeSessionDetail(projectDir, session.id),
    enabled: expanded,
  });

  return (
    <div className="px-4 py-2">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded((e) => !e)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") setExpanded((v) => !v);
        }}
        className="w-full flex items-center gap-3 text-left hover:bg-gray-800/50 cursor-pointer"
      >
        <IdChip id={session.id} filePath={session.filePath} projectDir={projectDir} />
        <span className="text-sm text-gray-100 truncate flex-1">{session.preview ?? "(no readable text)"}</span>
        <span className="text-xs text-gray-500 flex-shrink-0">
          {session.startedAtMs !== null && <>started {formatTime(session.startedAtMs)} · </>}
          last active {formatTime(session.mtimeMs)}
        </span>
        <span className="text-gray-400 flex-shrink-0">{expanded ? "−" : "+"}</span>
      </div>
      {expanded && (
        <div className="mt-2 space-y-2 max-h-[32rem] overflow-y-auto">
          {isLoading && <p className="text-xs text-gray-500">Loading transcript…</p>}
          {error && (
            <p className="text-xs text-red-400">{error instanceof Error ? error.message : String(error)}</p>
          )}
          {data?.turns.map((turn, i) => (
            <div
              key={i}
              className={`text-sm rounded p-2 prose prose-sm max-w-none ${
                turn.role === "user"
                  ? "bg-gray-900 border border-gray-800 text-gray-100"
                  : "bg-gray-900 border border-gray-800 text-gray-100"
              }`}
            >
              <Markdown>{turn.text}</Markdown>
            </div>
          ))}
          {data?.turns.length === 0 && <p className="text-xs text-gray-500">(no readable turns)</p>}
        </div>
      )}
    </div>
  );
}

function ProjectGroupSection({ group }: { group: ClaudeSessionGroupDto }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <section className="bg-gray-900 border border-gray-800 rounded-lg mb-3 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="w-full px-4 py-2 flex items-center gap-3 bg-gray-800/50 hover:bg-gray-700 text-left"
      >
        <span className="font-semibold text-gray-100 text-sm truncate">{group.repoPath}</span>
        {!group.repoPathResolved && (
          <span className="text-xs text-amber-400 bg-amber-900/40 px-1.5 py-0.5 rounded flex-shrink-0">
            path not found on disk
          </span>
        )}
        <span className="text-xs text-gray-500 flex-shrink-0">
          {group.sessions.length} chat{group.sessions.length === 1 ? "" : "s"}
        </span>
        <span className="ml-auto text-gray-400 flex-shrink-0">{expanded ? "−" : "+"}</span>
      </button>
      {expanded && (
        <div className="divide-y divide-gray-800">
          {group.sessions.map((session) => (
            <SessionRow key={session.id} projectDir={group.projectDir} session={session} />
          ))}
        </div>
      )}
    </section>
  );
}

export default function ClaudeSessionsView() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["claude-sessions"],
    queryFn: apiClient.getClaudeSessions,
  });

  if (isLoading) return <div className="p-6 text-gray-500">Loading Claude sessions…</div>;
  if (error)
    return <div className="p-6 text-red-400">Error: {error instanceof Error ? error.message : String(error)}</div>;
  if (!data) return null;

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold text-gray-100 mb-1"><span className="text-green-500">$</span> Claude Sessions</h1>
      <p className="text-sm text-gray-500 mb-4">
        Every Claude Code chat on this machine, grouped by repo folder.
      </p>
      {data.groups.length === 0 && <p className="text-sm text-gray-500">No sessions found.</p>}
      {data.groups.map((group) => (
        <ProjectGroupSection key={group.projectDir} group={group} />
      ))}
    </div>
  );
}
