/**
 * Read-only browser for Claude Code's own on-disk chat sessions, grouped by the repo
 * folder they belong to — whether Foundry started the session or a human ran `claude`
 * directly (GET /api/claude-sessions). Entirely separate from Foundry's own runs.
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import Markdown from "react-markdown";
import { apiClient } from "../api/client.js";
import type { ClaudeSessionGroupDto, ClaudeSessionSummaryDto } from "../api/types.js";
import { EmptyState, ErrorState, Icon, Loading, PageHeader, Panel, cx } from "../components/ui.js";

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

/** git-style short-hash chip: first 8 chars, full path on hover, click reveals the file
 * in the OS browser. A real <button> so it can sit inside the row's clickable area
 * without triggering the row's own expand/collapse (stopPropagation). */
function IdChip({ id, filePath, projectDir }: { id: string; filePath: string; projectDir: string }) {
  const reveal = useMutation({ mutationFn: () => apiClient.revealClaudeSession(projectDir, id) });
  return (
    <button
      type="button"
      title={filePath}
      onClick={(e) => {
        e.stopPropagation();
        reveal.mutate();
      }}
      className="flex-shrink-0 rounded bg-gray-800 px-1.5 py-0.5 font-mono text-[11px] text-gray-400 hover:bg-gray-700 hover:text-gray-200"
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

  // Open a chat at its last message — that's where the interesting part usually is.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (data && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [data]);

  return (
    <div className="px-4 py-2.5">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded((e) => !e)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") setExpanded((v) => !v);
        }}
        className="flex w-full cursor-pointer items-center gap-2.5 text-left"
      >
        <Icon name={expanded ? "chevron-down" : "chevron-right"} size={13} className="flex-shrink-0 text-gray-600" />
        <IdChip id={session.id} filePath={session.filePath} projectDir={projectDir} />
        <span className="min-w-0 flex-1 truncate text-sm text-gray-100">{session.preview ?? "(no readable text)"}</span>
        <span className="flex-shrink-0 text-xs text-gray-500">
          {session.startedAtMs !== null && <>started {formatTime(session.startedAtMs)} · </>}
          last active {formatTime(session.mtimeMs)}
        </span>
      </div>
      {expanded && (
        <div ref={scrollRef} className="mt-2 max-h-[32rem] space-y-2 overflow-y-auto pl-6">
          {isLoading && <p className="text-xs text-gray-500">Loading transcript…</p>}
          {error && <p className="text-xs text-red-400">{error instanceof Error ? error.message : String(error)}</p>}
          {data?.turns.map((turn, i) => (
            <div
              key={i}
              className={cx(
                "rounded-md border px-3 py-2 text-sm",
                turn.role === "user"
                  ? "border-green-800/40 bg-green-950/20 text-gray-100"
                  : "border-gray-800 bg-gray-950/40 text-gray-200"
              )}
            >
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-gray-500">{turn.role}</div>
              <div className="prose prose-sm prose-invert max-w-none">
                <Markdown>{turn.text}</Markdown>
              </div>
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
    <Panel className="mb-3 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left hover:bg-gray-800/40"
      >
        <Icon name={expanded ? "chevron-down" : "chevron-right"} size={14} className="flex-shrink-0 text-gray-500" />
        <Icon name="terminal" size={14} className="flex-shrink-0 text-gray-600" />
        <span className="min-w-0 truncate text-sm font-semibold text-gray-100">{group.repoPath}</span>
        {!group.repoPathResolved && (
          <span className="flex-shrink-0 rounded bg-amber-900/40 px-1.5 py-0.5 text-xs text-amber-300 ring-1 ring-amber-500/30">
            path not found on disk
          </span>
        )}
        <span className="ml-auto flex-shrink-0 text-xs text-gray-500">
          {group.sessions.length} chat{group.sessions.length === 1 ? "" : "s"}
        </span>
      </button>
      {expanded && <div className="divide-y divide-gray-800/70 border-t border-gray-800">{group.sessions.map((s) => <SessionRow key={s.id} projectDir={group.projectDir} session={s} />)}</div>}
    </Panel>
  );
}

export default function ClaudeSessionsView() {
  const { data, isLoading, error } = useQuery({ queryKey: ["claude-sessions"], queryFn: apiClient.getClaudeSessions });

  if (isLoading) return <Loading label="Loading Claude sessions…" />;
  if (error) return <ErrorState error={error} />;
  if (!data) return null;

  return (
    <div className="mx-auto max-w-4xl p-6">
      <PageHeader title="Claude Sessions" subtitle="Every Claude Code chat on this machine, grouped by repo folder." />
      {data.groups.length === 0 ? (
        <Panel>
          <EmptyState
            icon={<Icon name="terminal" size={28} />}
            title="No sessions found."
            hint="Claude Code sessions from anywhere on this machine will appear here once they exist."
          />
        </Panel>
      ) : (
        data.groups.map((group) => <ProjectGroupSection key={group.projectDir} group={group} />)
      )}
    </div>
  );
}
