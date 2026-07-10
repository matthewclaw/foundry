/** E2.5 — orgView(): teams + agents with derived status, worst-of team roll-ups. */
import type { Agent, AgentId, AgentState, TeamId } from "@foundry/core";
import type { Db } from "../db/connection.js";
import { rowToAgent, type AgentRow } from "../mutations/agents.js";
import { rowToTeam, type TeamRow } from "../mutations/teams.js";
import { getAgentStatus, worstStatus, type AgentStatus } from "./status.js";

export interface OrgViewAgent {
  id: AgentId;
  name: string;
  role: string;
  team_id: TeamId | null;
  state: AgentState;
  status: AgentStatus;
}

export interface OrgViewTeam {
  id: TeamId;
  name: string;
  agents: OrgViewAgent[];
  /** Worst status among the team's active agents (02: "roll-up status per team, worst-of members"). */
  status: AgentStatus;
}

export interface OrgView {
  teams: OrgViewTeam[];
  unassignedAgents: OrgViewAgent[];
}

function toOrgViewAgent(db: Db, row: AgentRow): OrgViewAgent {
  const agent: Agent = rowToAgent(row);
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    team_id: agent.team_id,
    state: agent.state,
    status: agent.state === "active" ? getAgentStatus(db, agent.id) : "idle",
  };
}

export function orgView(db: Db): OrgView {
  const teamRows = db.prepare(`SELECT * FROM teams ORDER BY name`).all() as TeamRow[];
  const agentRows = db.prepare(`SELECT * FROM agents ORDER BY name`).all() as AgentRow[];

  const agentsByTeam = new Map<string, OrgViewAgent[]>();
  const unassigned: OrgViewAgent[] = [];
  for (const row of agentRows) {
    const agent = toOrgViewAgent(db, row);
    if (agent.team_id) {
      const list = agentsByTeam.get(agent.team_id) ?? [];
      list.push(agent);
      agentsByTeam.set(agent.team_id, list);
    } else {
      unassigned.push(agent);
    }
  }

  const teams: OrgViewTeam[] = teamRows.map((row) => {
    const team = rowToTeam(row);
    const agents = agentsByTeam.get(team.id) ?? [];
    return {
      id: team.id,
      name: team.name,
      agents,
      status: worstStatus(agents.map((a) => a.status)),
    };
  });

  return { teams, unassignedAgents: unassigned };
}
