/**
 * E7.2 — Org view (doc-06): teams as sections, worst-of roll-up chip, exception-first
 * collapse. Status precedence (doc-02): blocked > degraded > waiting > active >
 * over-committed > idle. Blocked/degraded agents sort first and are emphasized;
 * teams with only idle/active members render collapsed to one calm line.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client.js";
import type { AgentStatus, OrgViewAgent, OrgViewTeam } from "../api/types.js";

/** Badge classes + precedence rank per status (rank 0 = worst; doc-02 order). */
export const STATUS_BADGE: Record<AgentStatus, { classes: string; rank: number }> = {
  blocked: { classes: "bg-red-100 text-red-800", rank: 0 },
  degraded: { classes: "bg-orange-100 text-orange-800", rank: 1 },
  waiting: { classes: "bg-amber-100 text-amber-800", rank: 2 },
  active: { classes: "bg-green-100 text-green-800", rank: 3 },
  "over-committed": { classes: "bg-purple-100 text-purple-800", rank: 4 },
  idle: { classes: "bg-gray-100 text-gray-600", rank: 5 },
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
        emphasized ? "bg-red-50 border-l-4 border-red-400" : ""
      }`}
    >
      <Badge status={agent.status} />
      <div className="min-w-0 flex-1">
        <span className={`text-sm truncate ${emphasized ? "font-semibold text-gray-900" : "text-gray-800"}`}>
          {agent.name}
        </span>
        <span className="ml-2 text-xs text-gray-500">{agent.role}</span>
        {agent.currently && (
          <div className="text-xs text-gray-600 truncate">currently: {agent.currently}</div>
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

function TeamSection({ name, status, agents }: { name: string; status: AgentStatus; agents: OrgViewAgent[] }) {
  const [expanded, setExpanded] = useState(!isCalm(agents));
  const sorted = sortAgents(agents);

  return (
    <section className="bg-white border border-gray-200 rounded-lg mb-3 overflow-hidden">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full px-4 py-2 flex items-center gap-3 bg-gray-50 hover:bg-gray-100 text-left"
      >
        <span className="font-semibold text-gray-800">{name}</span>
        <Badge status={status} />
        <span className="text-xs text-gray-500">
          {agents.length} agent{agents.length === 1 ? "" : "s"}
        </span>
        <span className="ml-auto text-gray-400">{expanded ? "−" : "+"}</span>
      </button>
      {expanded && (
        <div className="divide-y divide-gray-100">
          {sorted.map((agent) => (
            <AgentRow key={agent.id} agent={agent} />
          ))}
        </div>
      )}
    </section>
  );
}

export default function OrgView() {
  const { data: org, isLoading, error } = useQuery({
    queryKey: ["org"],
    queryFn: apiClient.getOrg,
  });

  if (isLoading) return <div className="p-6 text-gray-500">Loading organization…</div>;
  if (error)
    return <div className="p-6 text-red-600">Error: {error instanceof Error ? error.message : String(error)}</div>;
  if (!org) return null;

  return (
    <div className="p-6 max-w-3xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-4">Organization</h1>
      {org.teams.map((team: OrgViewTeam) => (
        <TeamSection key={team.id} name={team.name} status={team.status} agents={team.agents} />
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
