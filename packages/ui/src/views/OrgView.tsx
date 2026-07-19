/**
 * E7.2 — Org view (doc-06): teams as sections, worst-of roll-up chip, exception-first
 * collapse. Status precedence (doc-02): blocked > degraded > waiting > active >
 * over-committed > idle. Blocked/degraded agents sort first and are emphasized;
 * teams with only idle/active members render collapsed to one calm line.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api/client.js";
import type { AgentStatus, OrgViewAgent, OrgViewTeam } from "../api/types.js";

/** Badge classes + precedence rank per status (rank 0 = worst; doc-02 order). */
export const STATUS_BADGE: Record<AgentStatus, { classes: string; rank: number }> = {
  blocked: { classes: "bg-red-900/40 text-red-400", rank: 0 },
  degraded: { classes: "bg-orange-900/40 text-orange-400", rank: 1 },
  waiting: { classes: "bg-amber-900/40 text-amber-400", rank: 2 },
  active: { classes: "bg-green-900/40 text-green-400", rank: 3 },
  "over-committed": { classes: "bg-purple-900/40 text-purple-400", rank: 4 },
  idle: { classes: "bg-gray-800 text-gray-400", rank: 5 },
};

export function statusBadge(status: AgentStatus): { classes: string; rank: number } {
  return STATUS_BADGE[status];
}

export function Badge({ status }: { status: AgentStatus }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${statusBadge(status).classes}`}
    >
      {status}
    </span>
  );
}

const isException = (s: AgentStatus) => s === "blocked" || s === "degraded";

function AgentRow({ agent }: { agent: OrgViewAgent }) {
  const emphasized = isException(agent.status);
  return (
    <div
      data-testid="agent-row"
      className={`flex items-center gap-3 px-4 py-2 ${
        emphasized ? "bg-red-950/40 border-l-4 border-red-500" : ""
      }`}
    >
      <Badge status={agent.status} />
      <div className="min-w-0 flex-1">
        <span className={`text-sm truncate ${emphasized ? "font-semibold text-gray-100" : "text-gray-200"}`}>
          {agent.name}
        </span>
        <span className="ml-2 text-xs text-gray-500">{agent.role}</span>
        {agent.currently && (
          <div className="text-xs text-gray-400 truncate">currently: {agent.currently}</div>
        )}
      </div>
      {agent.spend_usd !== undefined && (
        <span className="text-xs text-gray-500 flex-shrink-0">${agent.spend_usd.toFixed(2)}</span>
      )}
    </div>
  );
}

const sortAgents = (agents: OrgViewAgent[]): OrgViewAgent[] =>
  [...agents].sort((a, b) => statusBadge(a.status).rank - statusBadge(b.status).rank);

/** Exception-first collapse: only idle/active members ⇒ one calm line (doc-06). */
const isCalm = (agents: OrgViewAgent[]) =>
  agents.every((a) => a.status === "idle" || a.status === "active");

/** Inline rename, only rendered for real teams (the synthetic "Unassigned" bucket has
 * no `id` and isn't renameable/deletable). */
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
        className="border border-gray-700 bg-black rounded px-2 py-0.5 text-sm font-semibold text-gray-200 focus:outline-none focus:border-green-600"
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
      {rename.error && (
        <span className="text-xs text-red-400">
          {rename.error instanceof Error ? rename.error.message : String(rename.error)}
        </span>
      )}
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
    <section className="bg-gray-900 border border-gray-800 rounded-lg mb-3 overflow-hidden">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded((e) => !e)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") setExpanded((v) => !v);
        }}
        className="w-full px-4 py-2 flex items-center gap-3 bg-gray-900 hover:bg-gray-800 text-left cursor-pointer"
      >
        {renaming && id ? (
          <TeamRenameControl teamId={id} currentName={name} onDone={() => setRenaming(false)} />
        ) : (
          <>
            <span className="font-semibold text-gray-200">{name}</span>
            {id && (
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
            )}
          </>
        )}
        <Badge status={status} />
        <span className="text-xs text-gray-500">
          {agents.length} agent{agents.length === 1 ? "" : "s"}
        </span>
        {id && (
          <button
            type="button"
            className="ml-auto text-xs px-2 py-0.5 rounded border border-gray-700 text-gray-500 hover:text-red-400 hover:border-red-500"
            disabled={deleteTeam.isPending}
            onClick={handleDelete}
          >
            {deleteTeam.isPending ? "Deleting…" : "Delete"}
          </button>
        )}
        <span className={id ? "text-gray-500" : "ml-auto text-gray-500"}>{expanded ? "−" : "+"}</span>
      </div>
      {deleteTeam.error && (
        <p className="px-4 pb-2 text-xs text-red-400">
          {deleteTeam.error instanceof Error ? deleteTeam.error.message : String(deleteTeam.error)}
        </p>
      )}
      {expanded && (
        <div className="divide-y divide-gray-800">
          {sorted.map((agent) => (
            <AgentRow key={agent.id} agent={agent} />
          ))}
        </div>
      )}
    </section>
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
    <form
      className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) create.mutate();
      }}
    >
      <h2 className="font-semibold text-gray-200 mb-2 text-sm">New team</h2>
      <input
        aria-label="Team name"
        className="w-full border border-gray-700 bg-gray-900 text-gray-200 rounded p-2 text-sm mb-2 focus:outline-none focus:border-green-600"
        placeholder="Team name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={create.isPending}
      />
      <input
        aria-label="Team description"
        className="w-full border border-gray-700 bg-gray-900 text-gray-200 rounded p-2 text-sm mb-2 focus:outline-none focus:border-green-600"
        placeholder="Description (optional)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        disabled={create.isPending}
      />
      <div className="flex items-center gap-3">
        <button
          type="submit"
          className="px-3 py-1 rounded bg-green-700 hover:bg-green-600 text-white text-sm disabled:opacity-50"
          disabled={create.isPending || !name.trim()}
        >
          {create.isPending ? "Creating…" : "Create team"}
        </button>
        <button type="button" className="text-sm text-gray-500" onClick={onDone}>
          Cancel
        </button>
        {create.error && (
          <span className="text-xs text-red-400">
            {create.error instanceof Error ? create.error.message : String(create.error)}
          </span>
        )}
      </div>
    </form>
  );
}

function NewAgentForm({ teams, onDone }: { teams: OrgViewTeam[]; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [teamId, setTeamId] = useState("");
  const [charter, setCharter] = useState("");
  const [engine, setEngine] = useState("fake");
  const create = useMutation({
    mutationFn: () =>
      apiClient.createAgent({
        name,
        role,
        team_id: teamId || null,
        charter_md: charter || `# ${name}`,
        engine: { id: engine },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["org"] });
      onDone();
    },
  });

  return (
    <form
      className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() && role.trim()) create.mutate();
      }}
    >
      <h2 className="font-semibold text-gray-200 mb-2 text-sm">New agent</h2>
      <input
        aria-label="Agent name"
        className="w-full border border-gray-700 bg-gray-900 text-gray-200 rounded p-2 text-sm mb-2 focus:outline-none focus:border-green-600"
        placeholder="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={create.isPending}
      />
      <input
        aria-label="Agent role"
        className="w-full border border-gray-700 bg-gray-900 text-gray-200 rounded p-2 text-sm mb-2 focus:outline-none focus:border-green-600"
        placeholder="Role (e.g. Backend Engineer)"
        value={role}
        onChange={(e) => setRole(e.target.value)}
        disabled={create.isPending}
      />
      <select
        aria-label="Team"
        className="w-full border border-gray-700 bg-gray-900 text-gray-200 rounded p-2 text-sm mb-2 focus:outline-none focus:border-green-600"
        value={teamId}
        onChange={(e) => setTeamId(e.target.value)}
        disabled={create.isPending}
      >
        <option value="">Unassigned</option>
        {teams.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
      <textarea
        aria-label="Charter"
        className="w-full h-16 border border-gray-700 bg-gray-900 text-gray-200 rounded p-2 text-sm mb-2 focus:outline-none focus:border-green-600"
        placeholder="Charter (markdown, optional — defaults to a stub)"
        value={charter}
        onChange={(e) => setCharter(e.target.value)}
        disabled={create.isPending}
      />
      <select
        aria-label="Engine"
        className="w-full border border-gray-700 bg-gray-900 text-gray-200 rounded p-2 text-sm mb-2 focus:outline-none focus:border-green-600"
        value={engine}
        onChange={(e) => setEngine(e.target.value)}
        disabled={create.isPending}
      >
        <option value="fake">Fake (scripted demo playback, free)</option>
        <option value="claude-code">Claude Code (real CLI, real cost)</option>
      </select>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          className="px-3 py-1 rounded bg-green-700 hover:bg-green-600 text-white text-sm disabled:opacity-50"
          disabled={create.isPending || !name.trim() || !role.trim()}
        >
          {create.isPending ? "Creating…" : "Create agent"}
        </button>
        <button type="button" className="text-sm text-gray-500" onClick={onDone}>
          Cancel
        </button>
        {create.error && (
          <span className="text-xs text-red-400">
            {create.error instanceof Error ? create.error.message : String(create.error)}
          </span>
        )}
      </div>
    </form>
  );
}

export default function OrgView() {
  const { data: org, isLoading, error } = useQuery({
    queryKey: ["org"],
    queryFn: apiClient.getOrg,
  });
  const [openForm, setOpenForm] = useState<"team" | "agent" | null>(null);

  if (isLoading) return <div className="p-6 text-gray-500">Loading organization…</div>;
  if (error)
    return <div className="p-6 text-red-400">Error: {error instanceof Error ? error.message : String(error)}</div>;
  if (!org) return null;

  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-center mb-4">
        <h1 className="text-2xl font-bold text-gray-100"><span className="text-green-500">$</span> Organization</h1>
        <div className="ml-auto flex gap-2">
          <button
            className="px-3 py-1 rounded border border-gray-700 text-sm text-gray-300 hover:bg-gray-800"
            onClick={() => setOpenForm(openForm === "team" ? null : "team")}
          >
            + New team
          </button>
          <button
            className="px-3 py-1 rounded border border-gray-700 text-sm text-gray-300 hover:bg-gray-800"
            onClick={() => setOpenForm(openForm === "agent" ? null : "agent")}
          >
            + New agent
          </button>
        </div>
      </div>
      {openForm === "team" && <NewTeamForm onDone={() => setOpenForm(null)} />}
      {openForm === "agent" && <NewAgentForm teams={org.teams} onDone={() => setOpenForm(null)} />}
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
