/**
 * Read-only browser for Claude Code's own on-disk chat sessions (GET /api/claude-sessions),
 * laid out like a file explorer: a folder/chat tree on the left, the selected chat's
 * transcript on the right. The server returns a flat list of groups keyed by full repo
 * path; this view reconstructs the folder hierarchy from those paths and, like VSCode's
 * "compact folders", collapses single-child folder chains into one combined segment.
 */
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client.js";
import type { ClaudeSessionGroupDto, ClaudeSessionSummaryDto } from "../api/types.js";
import { EmptyState, ErrorState, Icon, Loading, PageHeader, cx } from "../components/ui.js";
import { TranscriptTurn } from "../components/transcript.js";

/* --------------------------------------------------------------------- filtering */

type DateOp = "on" | "before" | "after";
export interface SessionFilter {
  startedOp: DateOp;
  startedDate: string; // YYYY-MM-DD; empty means no constraint
  activeOp: DateOp;
  activeDate: string;
}
export const EMPTY_FILTER: SessionFilter = { startedOp: "after", startedDate: "", activeOp: "after", activeDate: "" };

/** sv-SE renders a local Date as YYYY-MM-DD, which compares chronologically as a string. */
function localYMD(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toLocaleDateString("sv-SE");
}
function opMatches(ymd: string | null, op: DateOp, value: string): boolean {
  if (!value) return true; // empty date = no constraint
  if (ymd === null) return false; // a session with no date can't satisfy a date criterion
  if (op === "on") return ymd === value;
  if (op === "before") return ymd < value;
  return ymd > value; // after
}
export function sessionMatchesFilter(session: ClaudeSessionSummaryDto, f: SessionFilter): boolean {
  return (
    opMatches(localYMD(session.startedAtMs), f.startedOp, f.startedDate) &&
    opMatches(localYMD(session.mtimeMs), f.activeOp, f.activeDate)
  );
}
const filterActive = (f: SessionFilter) => f.startedDate !== "" || f.activeDate !== "";

const FILTER_FIELD =
  "rounded border border-gray-700 bg-gray-950/60 px-1.5 py-1 text-xs text-gray-200 focus:border-green-600 focus:outline-none disabled:opacity-40";

function FilterGroup({
  label,
  op,
  date,
  onOp,
  onDate,
}: {
  label: string;
  op: DateOp;
  date: string;
  onOp: (op: DateOp) => void;
  onDate: (date: string) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-gray-400">{label}</span>
      <select aria-label={`${label} filter`} value={op} onChange={(e) => onOp(e.target.value as DateOp)} className={cx(FILTER_FIELD, "cursor-pointer")}>
        <option value="on">on</option>
        <option value="before">before</option>
        <option value="after">after</option>
      </select>
      <input aria-label={`${label} date`} type="date" value={date} onChange={(e) => onDate(e.target.value)} className={cx(FILTER_FIELD, "w-[8.5rem]")} />
    </div>
  );
}

function FilterBar({ filter, setFilter }: { filter: SessionFilter; setFilter: Dispatch<SetStateAction<SessionFilter>> }) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
      <FilterGroup label="Started" op={filter.startedOp} date={filter.startedDate} onOp={(op) => setFilter((f) => ({ ...f, startedOp: op }))} onDate={(d) => setFilter((f) => ({ ...f, startedDate: d }))} />
      <span className="h-4 w-px bg-gray-700" aria-hidden />
      <FilterGroup label="Last active" op={filter.activeOp} date={filter.activeDate} onOp={(op) => setFilter((f) => ({ ...f, activeOp: op }))} onDate={(d) => setFilter((f) => ({ ...f, activeDate: d }))} />
      {filterActive(filter) && (
        <button type="button" onClick={() => setFilter(EMPTY_FILTER)} className="text-xs text-gray-500 hover:text-green-400">
          Clear
        </button>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- tree building */

export interface FolderNode {
  /** Display label — one segment, or several joined when a single-child chain is compacted. */
  name: string;
  /** Full path to this folder (stable key). */
  path: string;
  folders: FolderNode[];
  /** The session group whose repo path ends here (its chats live in this folder). */
  group?: ClaudeSessionGroupDto;
}

/** Build the folder forest from the flat group list, then compact single-child chains. */
export function buildSessionTree(groups: ClaudeSessionGroupDto[], sep = "\\"): FolderNode[] {
  const root: FolderNode = { name: "", path: "", folders: [] };
  for (const group of groups) {
    const segments = group.repoPath.split(/[\\/]+/).filter(Boolean);
    let node = root;
    let acc = "";
    for (const segment of segments) {
      acc = acc ? acc + sep + segment : segment;
      // Windows paths are case-insensitive, so `C:\repos` and `c:\repos` are the same
      // folder — match on lowercase but keep the first-seen casing for display.
      let child = node.folders.find((f) => f.name.toLowerCase() === segment.toLowerCase());
      if (!child) {
        child = { name: segment, path: acc, folders: [] };
        node.folders.push(child);
      }
      node = child;
    }
    node.group = group;
  }
  return compact(root.folders, sep);
}

function compact(nodes: FolderNode[], sep: string): FolderNode[] {
  return nodes.map((node) => {
    let current = node;
    // Merge a folder into its only child while it has no chats of its own — a chain of
    // pass-through directories reads as one path segment.
    while (current.folders.length === 1 && !current.group) {
      const child = current.folders[0]!;
      current = { name: current.name + sep + child.name, path: child.path, folders: child.folders, group: child.group };
    }
    return { ...current, folders: compact(current.folders, sep) };
  });
}

/* ----------------------------------------------------------------- explorer tree */

interface Selection {
  projectDir: string;
  session: ClaudeSessionSummaryDto;
}

function RevealChip({ id, filePath, projectDir }: { id: string; filePath: string; projectDir: string }) {
  const reveal = useMutation({ mutationFn: () => apiClient.revealClaudeSession(projectDir, id) });
  return (
    <button
      type="button"
      title={filePath}
      onClick={(e) => {
        e.stopPropagation();
        reveal.mutate();
      }}
      className="flex-shrink-0 rounded bg-gray-800 px-1.5 py-0.5 font-mono text-[10px] text-gray-500 opacity-0 transition-opacity hover:bg-gray-700 hover:text-gray-200 group-hover:opacity-100"
    >
      {id.slice(0, 8)}
    </button>
  );
}

function ChatRow({
  projectDir,
  session,
  depth,
  selected,
  onSelect,
}: {
  projectDir: string;
  session: ClaudeSessionSummaryDto;
  depth: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onSelect();
      }}
      style={{ paddingLeft: `${depth * 14 + 8}px` }}
      className={cx(
        "group flex cursor-pointer items-center gap-2 py-1 pr-2 text-sm",
        selected ? "bg-green-900/30 text-green-200" : "text-gray-300 hover:bg-gray-800/60"
      )}
    >
      <Icon name="message" size={13} className="flex-shrink-0 text-gray-600" />
      <span className="min-w-0 flex-1 truncate">{session.preview ?? "(no readable text)"}</span>
      <RevealChip id={session.id} filePath={session.filePath} projectDir={projectDir} />
    </div>
  );
}

function FolderRow({
  node,
  depth,
  collapsed,
  toggle,
  selection,
  onSelect,
}: {
  node: FolderNode;
  depth: number;
  collapsed: Set<string>;
  toggle: (path: string) => void;
  selection: Selection | null;
  onSelect: (sel: Selection) => void;
}) {
  const isCollapsed = collapsed.has(node.path);
  const unresolved = node.group && !node.group.repoPathResolved;
  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={() => toggle(node.path)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") toggle(node.path);
        }}
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
        className="flex cursor-pointer items-center gap-1.5 py-1 pr-2 text-sm text-gray-200 hover:bg-gray-800/60"
      >
        <Icon name={isCollapsed ? "chevron-right" : "chevron-down"} size={13} className="flex-shrink-0 text-gray-500" />
        <Icon name="folder" size={13} className="flex-shrink-0 text-gray-500" />
        <span className="min-w-0 truncate font-medium">{node.name}</span>
        {unresolved && (
          <span className="flex-shrink-0 rounded bg-amber-900/40 px-1.5 py-0.5 text-[10px] text-amber-300 ring-1 ring-amber-500/30">
            path not found on disk
          </span>
        )}
      </div>
      {!isCollapsed && (
        <div>
          {node.folders.map((child) => (
            <FolderRow key={child.path} node={child} depth={depth + 1} collapsed={collapsed} toggle={toggle} selection={selection} onSelect={onSelect} />
          ))}
          {node.group?.sessions.map((session) => (
            <ChatRow
              key={session.id}
              projectDir={node.group!.projectDir}
              session={session}
              depth={depth + 1}
              selected={selection?.session.id === session.id && selection.projectDir === node.group!.projectDir}
              onSelect={() => onSelect({ projectDir: node.group!.projectDir, session })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------- transcript */

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

function TranscriptPane({ selection, onClose }: { selection: Selection | null; onClose: () => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ["claude-session", selection?.projectDir, selection?.session.id],
    queryFn: () => apiClient.getClaudeSessionDetail(selection!.projectDir, selection!.session.id),
    enabled: !!selection,
  });
  const reveal = useMutation({
    mutationFn: () => apiClient.revealClaudeSession(selection!.projectDir, selection!.session.id),
  });

  // Open a chat at its last message — that's usually where the interesting part is.
  useEffect(() => {
    if (data && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [data]);

  const session = selection?.session;
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-shrink-0 items-start gap-2 border-b border-gray-800 px-4 py-2.5">
        <div className="min-w-0 flex-1">
          {session ? (
            <>
              <div className="truncate font-mono text-xs text-gray-400" title={session.filePath}>{session.filePath}</div>
              <div className="mt-0.5 text-xs text-gray-500">
                {session.startedAtMs !== null && <>started {formatTime(session.startedAtMs)} · </>}
                last active {formatTime(session.mtimeMs)}
              </div>
            </>
          ) : (
            <span className="text-sm text-gray-500">Transcript</span>
          )}
        </div>
        {session && (
          <button
            type="button"
            aria-label="Reveal in file explorer"
            title="Reveal this file in your OS file explorer"
            onClick={() => reveal.mutate()}
            className="flex-shrink-0 rounded p-1 text-gray-500 hover:bg-gray-800 hover:text-gray-200"
          >
            <Icon name="folder" size={15} />
          </button>
        )}
        <button
          type="button"
          aria-label="Close panel"
          title="Close panel — give the explorer full width"
          onClick={onClose}
          className="flex-shrink-0 rounded p-1 text-gray-500 hover:bg-gray-800 hover:text-gray-200"
        >
          <Icon name="x" size={15} />
        </button>
      </div>
      {!selection ? (
        <div className="flex-1">
          <EmptyState
            icon={<Icon name="terminal" size={28} />}
            title="Select a chat"
            hint="Pick a conversation from the explorer to read its transcript."
          />
        </div>
      ) : (
        <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto p-4">
          {isLoading && <p className="text-xs text-gray-500">Loading transcript…</p>}
          {error && <p className="text-xs text-red-400">{error instanceof Error ? error.message : String(error)}</p>}
          {data?.turns.map((turn, i) => (
          <TranscriptTurn key={i} role={turn.role} text={turn.text} />
          ))}
          {data?.turns.length === 0 && <p className="text-xs text-gray-500">(no readable turns)</p>}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- view */

export default function ClaudeSessionsView() {
  const { data, isLoading, error } = useQuery({ queryKey: ["claude-sessions"], queryFn: apiClient.getClaudeSessions });
  const [selection, setSelection] = useState<Selection | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<SessionFilter>(EMPTY_FILTER);

  // Selecting a chat always reveals the transcript, even if the panel was closed.
  const select = (sel: Selection) => {
    setSelection(sel);
    setPanelOpen(true);
  };

  const sep = useMemo(
    () => (data?.groups.some((g) => g.repoPath.includes("\\")) ? "\\" : "/"),
    [data]
  );
  // Apply the date filter to each group's chats, dropping groups left with none.
  const filteredGroups = useMemo(() => {
    if (!data) return [];
    return data.groups
      .map((g) => ({ ...g, sessions: g.sessions.filter((s) => sessionMatchesFilter(s, filter)) }))
      .filter((g) => g.sessions.length > 0);
  }, [data, filter]);
  const tree = useMemo(() => buildSessionTree(filteredGroups, sep), [filteredGroups, sep]);

  // Clear a stale selection if the sessions list changes and no longer contains it.
  useEffect(() => {
    if (!selection || !data) return;
    const stillThere = data.groups.some((g) => g.projectDir === selection.projectDir && g.sessions.some((s) => s.id === selection.session.id));
    if (!stillThere) setSelection(null);
  }, [data, selection]);

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });

  if (isLoading) return <Loading label="Loading Claude sessions…" />;
  if (error) return <ErrorState error={error} />;
  if (!data) return null;

  return (
    <div className="flex h-full flex-col p-6">
      <PageHeader title="Claude Sessions" subtitle="Every Claude Code chat on this machine, browsable like a file tree." />
      {data.groups.length === 0 ? (
        <EmptyState
          icon={<Icon name="terminal" size={28} />}
          title="No sessions found."
          hint="Claude Code sessions from anywhere on this machine will appear here once they exist."
        />
      ) : (
        <>
          <FilterBar filter={filter} setFilter={setFilter} />
          <div className="flex min-h-0 flex-1 gap-4">
            <div
              className={cx(
                "overflow-y-auto rounded-lg border border-gray-800 bg-gray-900/50 py-2",
                panelOpen ? "w-80 flex-shrink-0" : "flex-1"
              )}
            >
              {tree.length === 0 ? (
                <div className="px-3 py-4 text-xs text-gray-500">No chats match the filter.</div>
              ) : (
                tree.map((node) => (
                  <FolderRow key={node.path} node={node} depth={0} collapsed={collapsed} toggle={toggle} selection={selection} onSelect={select} />
                ))
              )}
            </div>
            {panelOpen && (
              <div className="min-w-0 flex-1 overflow-hidden rounded-lg border border-gray-800 bg-gray-900/50">
                <TranscriptPane selection={selection} onClose={() => setPanelOpen(false)} />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
