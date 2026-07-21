/**
 * Org view (doc-06): teams as sections, worst-of roll-up chip, exception-first collapse.
 * Status precedence (doc-02): blocked > degraded > waiting > active > over-committed >
 * idle. Blocked/degraded agents sort first and are emphasized; teams with only idle/active
 * members render collapsed to one calm line — don't make the human hunt for what needs
 * attention.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api/client.js";
import type { AgentStatus, OrgViewAgent, OrgViewTeam } from "../api/types.js";
import {
  Button,
  EmptyState,
  ErrorState,
  ErrorText,
  Icon,
  Label,
  Loading,
  PageHeader,
  Panel,
  Select,
  StatusBadge,
  StatusDot,
  TextArea,
  TextInput,
  STATUS_META,
  cx,
} from "../components/ui.js";

/** Back-compat surface for the status test + AgentPage: classes + precedence rank. */
export const STATUS_BADGE: Record<AgentStatus, { classes: string; rank: number }> = Object.fromEntries(
  (Object.keys(STATUS_META) as AgentStatus[]).map((s) => [s, { classes: STATUS_META[s].badge, rank: STATUS_META[s].rank }])
) as Record<AgentStatus, { classes: string; rank: number }>;

export function statusBadge(status: AgentStatus): { classes: string; rank: number } {
  return STATUS_BADGE[status];
}

export function Badge({ status }: { status: AgentStatus }) {
  return <StatusBadge status={status} />;
}

const isException = (s: AgentStatus) => s === "blocked" || s === "degraded";

function AgentRow({ agent }: { agent: OrgViewAgent }) {
  const emphasized = isException(agent.status);
  const queryClient = useQueryClient();
  const del = useMutation({
    mutationFn: () => apiClient.deleteAgent(agent.id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["org"] }),
  });
  const handleDelete = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (window.confirm(`Delete agent "${agent.name}"? This permanently removes it and all its workstreams, runs, and history. This cannot be undone.`)) {
      del.mutate();
    }
  };
  return (
    <Link
      to={`/agents/${agent.id}`}
      data-testid="agent-row"
      className={cx(
        "group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-gray-800/40",
        emphasized && "border-l-2 border-red-500 bg-red-950/30"
      )}
    >
      <StatusDot status={agent.status} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className={cx("truncate text-sm", emphasized ? "font-semibold text-gray-100" : "text-gray-200")}>
            {agent.name}
          </span>
          <span className="truncate text-xs text-gray-500">{agent.role}</span>
        </div>
        {agent.currently && <div className="truncate text-xs text-gray-400">{agent.currently}</div>}
      </div>
      <Badge status={agent.status} />
      {agent.spend_usd !== undefined && (
        <span className="flex-shrink-0 font-mono text-xs text-gray-500">${agent.spend_usd.toFixed(2)}</span>
      )}
      <button
        type="button"
        aria-label={`Delete agent ${agent.name}`}
        className="flex-shrink-0 rounded border border-transparent px-2 py-0.5 text-xs text-gray-600 opacity-0 transition hover:border-red-500/50 hover:bg-red-950/40 hover:text-red-300 focus:opacity-100 group-hover:opacity-100"
        disabled={del.isPending}
        onClick={handleDelete}
      >
        {del.isPending ? "Deleting…" : "Delete"}
      </button>
    </Link>
  );
}

const sortAgents = (agents: OrgViewAgent[]): OrgViewAgent[] =>
  [...agents].sort((a, b) => statusBadge(a.status).rank - statusBadge(b.status).rank);

/** Exception-first collapse: only idle/active members ⇒ one calm line (doc-06). */
const isCalm = (agents: OrgViewAgent[]) =>
  agents.every((a) => a.status === "idle" || a.status === "active");

/** Inline rename, only rendered for real teams (the synthetic "Unassigned" bucket has no
 * `id` and isn't renameable/deletable). */
function TeamRenameControl({
  teamId,
  currentName,
  onDone,
}: {
  teamId: string;
  currentName: string;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(currentName);
  const rename = useMutation({
    mutationFn: (name: string) => apiClient.patchTeam(teamId, { name }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["org"] });
      onDone();
    },
  });

  return (
    <span className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
      <input
        aria-label="Team name"
        className="rounded border border-gray-700 bg-gray-950 px-2 py-0.5 text-sm font-semibold text-gray-200 focus:border-green-600 focus:outline-none"
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={rename.isPending}
        autoFocus
      />
      <button
        type="button"
        className="text-xs text-green-400 hover:underline"
        disabled={rename.isPending || !name.trim()}
        onClick={() => name.trim() && rename.mutate(name.trim())}
      >
        Save
      </button>
      <button type="button" className="text-xs text-gray-500" onClick={onDone}>
        Cancel
      </button>
      {rename.error && <ErrorText error={rename.error} />}
    </span>
  );
}

function TeamSection({
  id,
  name,
  status,
  agents,
}: {
  id?: string;
  name: string;
  status: AgentStatus;
  agents: OrgViewAgent[];
}) {
  const [expanded, setExpanded] = useState(!isCalm(agents));
  const [renaming, setRenaming] = useState(false);
  const queryClient = useQueryClient();
  const sorted = sortAgents(agents);
  const attention = agents.filter((a) => isException(a.status)).length;

  const deleteTeam = useMutation({
    mutationFn: () => apiClient.deleteTeam(id!),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["org"] });
    },
  });

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    const message =
      agents.length > 0
        ? `Delete "${name}"? Its ${agents.length} agent${agents.length === 1 ? "" : "s"} will become unassigned, not deleted.`
        : `Delete "${name}"?`;
    if (window.confirm(message)) deleteTeam.mutate();
  };

  return (
    <Panel className="mb-3 overflow-hidden">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded((e) => !e)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") setExpanded((v) => !v);
        }}
        className="flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left hover:bg-gray-800/40"
      >
        <Icon name={expanded ? "chevron-down" : "chevron-right"} size={14} className="flex-shrink-0 text-gray-500" />
        <StatusDot status={status} />
        {renaming && id ? (
          <TeamRenameControl teamId={id} currentName={name} onDone={() => setRenaming(false)} />
        ) : (
          <>
            <span className="font-semibold text-gray-200">{name}</span>
            {id && (
              <button
                type="button"
                aria-label="Rename team"
                className="text-gray-600 hover:text-green-400"
                onClick={(e) => {
                  e.stopPropagation();
                  setRenaming(true);
                }}
              >
                <Icon name="pencil" size={12} />
              </button>
            )}
          </>
        )}
        <span className="text-xs text-gray-500">
          {agents.length} agent{agents.length === 1 ? "" : "s"}
        </span>
        {attention > 0 && (
          <span className="rounded-full bg-red-900/40 px-2 py-0.5 text-[11px] font-medium text-red-300 ring-1 ring-red-500/30">
            {attention} need{attention === 1 ? "s" : ""} attention
          </span>
        )}
        {id && (
          <button
            type="button"
            aria-label="Delete team"
            className="ml-auto rounded border border-transparent px-2 py-0.5 text-xs text-gray-600 hover:border-red-500/50 hover:bg-red-950/40 hover:text-red-300"
            disabled={deleteTeam.isPending}
            onClick={handleDelete}
          >
            {deleteTeam.isPending ? "Deleting…" : "Delete"}
          </button>
        )}
      </div>
      {deleteTeam.error && (
        <p className="px-4 pb-2">
          <ErrorText error={deleteTeam.error} />
        </p>
      )}
      {expanded && (
        <div className="divide-y divide-gray-800/70 border-t border-gray-800">
          {sorted.length === 0 ? (
            <div className="px-4 py-3 text-xs text-gray-500">No agents in this team yet.</div>
          ) : (
            sorted.map((agent) => <AgentRow key={agent.id} agent={agent} />)
          )}
        </div>
      )}
    </Panel>
  );
}

function NewTeamForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const create = useMutation({
    mutationFn: () => apiClient.createTeam({ name, description }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["org"] });
      onDone();
    },
  });

  return (
    <Panel className="mb-3 p-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
      >
        <h2 className="mb-3 text-sm font-semibold text-gray-200">New team</h2>
        <div className="mb-3">
          <Label>Name</Label>
          <TextInput aria-label="Team name" placeholder="e.g. Platform" value={name} onChange={(e) => setName(e.target.value)} disabled={create.isPending} />
        </div>
        <div className="mb-3">
          <Label>Description</Label>
          <TextInput aria-label="Team description" placeholder="Optional" value={description} onChange={(e) => setDescription(e.target.value)} disabled={create.isPending} />
        </div>
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" size="sm" disabled={create.isPending || !name.trim()}>
            {create.isPending ? "Creating…" : "Create team"}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onDone}>
            Cancel
          </Button>
          {create.error && <ErrorText error={create.error} />}
        </div>
      </form>
    </Panel>
  );
}

function NewAgentForm({ teams, onDone }: { teams: OrgViewTeam[]; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [teamId, setTeamId] = useState("");
  const [charter, setCharter] = useState("");
  const [engine, setEngine] = useState("fake");
  const [repoPath, setRepoPath] = useState("");
  const [useWorktree, setUseWorktree] = useState(true);
  const create = useMutation({
    mutationFn: () =>
      apiClient.createAgent({
        name,
        role,
        team_id: teamId || null,
        charter_md: charter || `# ${name}`,
        engine: { id: engine },
        // Default working dir: applied to this agent's runs (incl. delegated tasks) when a
        // workstream doesn't set its own. The runtime only reads repo_path off a worktree
        // ref (worktree_path/branch are schema-required placeholders it ignores).
        default_workspace_ref: !repoPath.trim()
          ? null
          : useWorktree
            ? { kind: "git_worktree", repo_path: repoPath.trim(), worktree_path: repoPath.trim(), branch: "main" }
            : { kind: "plain_dir", path: repoPath.trim() },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["org"] });
      onDone();
    },
  });

  return (
    <Panel className="mb-3 p-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && role.trim()) create.mutate();
        }}
      >
        <h2 className="mb-3 text-sm font-semibold text-gray-200">New agent</h2>
        <div className="mb-3 grid grid-cols-2 gap-3">
          <div>
            <Label>Name</Label>
            <TextInput aria-label="Agent name" placeholder="e.g. Orbit" value={name} onChange={(e) => setName(e.target.value)} disabled={create.isPending} />
          </div>
          <div>
            <Label>Role</Label>
            <TextInput aria-label="Agent role" placeholder="e.g. Backend Engineer" value={role} onChange={(e) => setRole(e.target.value)} disabled={create.isPending} />
          </div>
        </div>
        <div className="mb-3 grid grid-cols-2 gap-3">
          <div>
            <Label>Team</Label>
            <Select aria-label="Team" value={teamId} onChange={(e) => setTeamId(e.target.value)} disabled={create.isPending}>
              <option value="">Unassigned</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Engine</Label>
            <Select aria-label="Engine" value={engine} onChange={(e) => setEngine(e.target.value)} disabled={create.isPending}>
              <option value="fake">Fake — scripted demo, free</option>
              <option value="claude-code">Claude Code — real CLI, real cost</option>
            </Select>
          </div>
        </div>
        <div className="mb-3">
          <Label>Charter (markdown, optional)</Label>
          <TextArea aria-label="Charter" className="h-20" placeholder="Instructions for this agent — defaults to a stub if left blank." value={charter} onChange={(e) => setCharter(e.target.value)} disabled={create.isPending} />
        </div>
        <div className="mb-3">
          <Label>Default working directory (optional)</Label>
          <TextInput aria-label="Default repo path" placeholder="e.g. C:\repos\my-project — where this agent's tasks run" value={repoPath} onChange={(e) => setRepoPath(e.target.value)} disabled={create.isPending} />
        </div>
        {repoPath.trim() && (
          <div className={cx("mb-3 rounded-md border p-3", useWorktree ? "border-gray-800 bg-gray-900/40" : "border-amber-800/50 bg-amber-950/20")}>
            <label className="flex items-center gap-2 text-sm text-gray-300">
              <input type="checkbox" className="accent-green-600" checked={useWorktree} onChange={(e) => setUseWorktree(e.target.checked)} disabled={create.isPending} />
              Use an isolated git worktree per task (recommended)
            </label>
            <p className={cx("mt-1.5 text-xs", useWorktree ? "text-gray-500" : "text-amber-400/90")}>
              {useWorktree ? (
                "Each workstream gets its own worktree copy off this repo — changes stay isolated until you merge."
              ) : (
                <><Icon name="alert" size={11} className="mr-1 inline" />No isolation — this agent's edits land straight on your working tree.</>
              )}
            </p>
          </div>
        )}
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" size="sm" disabled={create.isPending || !name.trim() || !role.trim()}>
            {create.isPending ? "Creating…" : "Create agent"}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onDone}>
            Cancel
          </Button>
          {create.error && <ErrorText error={create.error} />}
        </div>
      </form>
    </Panel>
  );
}

export default function OrgView() {
  const { data: org, isLoading, error } = useQuery({
    queryKey: ["org"],
    queryFn: apiClient.getOrg,
  });
  const [openForm, setOpenForm] = useState<"team" | "agent" | null>(null);

  if (isLoading) return <Loading label="Loading organization…" />;
  if (error) return <ErrorState error={error} />;
  if (!org) return null;

  const isEmpty = org.teams.length === 0 && org.unassignedAgents.length === 0;

  return (
    <div className="mx-auto max-w-3xl p-6">
      <PageHeader
        title="Organization"
        subtitle="Every agent, grouped by team — exceptions surfaced first."
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => setOpenForm(openForm === "team" ? null : "team")}>
              + New team
            </Button>
            <Button variant="primary" size="sm" onClick={() => setOpenForm(openForm === "agent" ? null : "agent")}>
              + New agent
            </Button>
          </>
        }
      />

      {openForm === "team" && <NewTeamForm onDone={() => setOpenForm(null)} />}
      {openForm === "agent" && <NewAgentForm teams={org.teams} onDone={() => setOpenForm(null)} />}

      {isEmpty && openForm === null && (
        <Panel>
          <EmptyState
            icon={<Icon name="users" size={28} />}
            title="No agents yet."
            hint="Create your first agent to start delegating work. Agents are persistent specialists — they outlive any single conversation."
            action={
              <Button variant="primary" size="sm" onClick={() => setOpenForm("agent")}>
                + New agent
              </Button>
            }
          />
        </Panel>
      )}

      {org.teams.map((team: OrgViewTeam) => (
        <TeamSection key={team.id} id={team.id} name={team.name} status={team.status} agents={team.agents} />
      ))}
      {org.unassignedAgents.length > 0 && (
        <TeamSection
          name="Unassigned"
          status={sortAgents(org.unassignedAgents)[0]?.status ?? "idle"}
          agents={org.unassignedAgents}
        />
      )}
    </div>
  );
}
