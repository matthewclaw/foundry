/** E2.3 — Agent reads. Read-only: no INSERT/UPDATE/DELETE below (mutate() is the only write path). */
import type { Agent, AgentCharter, AgentId, AgentState, TeamId } from "@foundry/core";
import type { Db } from "../db/connection.js";
import { rowToAgent, type AgentRow } from "../mutations/agents.js";

export interface AgentQueries {
  get(id: AgentId): Agent | undefined;
  list(filter?: { team_id?: TeamId | null; state?: AgentState }): Agent[];
  getCharter(agentId: AgentId, version?: number): AgentCharter | undefined;
}

export function createAgentQueries(db: Db): AgentQueries {
  return {
    get(id) {
      const row = db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id) as AgentRow | undefined;
      return row ? rowToAgent(row) : undefined;
    },
    list(filter) {
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (filter?.team_id !== undefined) {
        clauses.push(filter.team_id === null ? "team_id IS NULL" : "team_id = @team_id");
        if (filter.team_id !== null) params.team_id = filter.team_id;
      }
      if (filter?.state) {
        clauses.push("state = @state");
        params.state = filter.state;
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = db.prepare(`SELECT * FROM agents ${where} ORDER BY created_at`).all(params) as AgentRow[];
      return rows.map(rowToAgent);
    },
    getCharter(agentId, version) {
      const row = version
        ? (db
            .prepare(`SELECT * FROM agent_charters WHERE agent_id = ? AND version = ?`)
            .get(agentId, version) as AgentCharterRow | undefined)
        : (db
            .prepare(`SELECT * FROM agent_charters WHERE agent_id = ? ORDER BY version DESC LIMIT 1`)
            .get(agentId) as AgentCharterRow | undefined);
      return row
        ? {
            agent_id: row.agent_id as AgentCharter["agent_id"],
            version: row.version,
            body_md: row.body_md,
            edited_by_actor: row.edited_by_actor as AgentCharter["edited_by_actor"],
            created_at: row.created_at,
          }
        : undefined;
    },
  };
}

interface AgentCharterRow {
  agent_id: string;
  version: number;
  body_md: string;
  edited_by_actor: string;
  created_at: string;
}
