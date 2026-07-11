/** E2.3 — Workstream reads. Read-only (mutate() is the only write path). */
import type { AgentId, TaskId, Workstream, WorkstreamId, WorkstreamState } from "@foundry/core";
import type { Db } from "../db/connection.js";
import { rowToWorkstream, type WorkstreamRow } from "../mutations/workstreams.js";

export interface WorkstreamQueries {
  get(id: WorkstreamId): Workstream | undefined;
  list(filter?: { agent_id?: AgentId; state?: WorkstreamState; task_id?: TaskId }): Workstream[];
}

export function createWorkstreamQueries(db: Db): WorkstreamQueries {
  return {
    get(id) {
      const row = db.prepare(`SELECT * FROM workstreams WHERE id = ?`).get(id) as WorkstreamRow | undefined;
      return row ? rowToWorkstream(row) : undefined;
    },
    list(filter) {
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (filter?.agent_id) {
        clauses.push("agent_id = @agent_id");
        params.agent_id = filter.agent_id;
      }
      if (filter?.state) {
        clauses.push("state = @state");
        params.state = filter.state;
      }
      if (filter?.task_id) {
        clauses.push("task_id = @task_id");
        params.task_id = filter.task_id;
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = db
        .prepare(`SELECT * FROM workstreams ${where} ORDER BY created_at`)
        .all(params) as WorkstreamRow[];
      return rows.map(rowToWorkstream);
    },
  };
}
