/** E2.3 — Run reads. Read-only (mutate() is the only write path). */
import type { Run, RunId, RunState, WorkstreamId } from "@foundry/core";
import type { Db } from "../db/connection.js";
import { rowToRun, type RunRow } from "../mutations/runs.js";

export interface RunQueries {
  get(id: RunId): Run | undefined;
  list(filter?: { workstream_id?: WorkstreamId; state?: RunState }): Run[];
}

export function createRunQueries(db: Db): RunQueries {
  return {
    get(id) {
      const row = db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as RunRow | undefined;
      return row ? rowToRun(row) : undefined;
    },
    list(filter) {
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (filter?.workstream_id) {
        clauses.push("workstream_id = @workstream_id");
        params.workstream_id = filter.workstream_id;
      }
      if (filter?.state) {
        clauses.push("state = @state");
        params.state = filter.state;
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = db.prepare(`SELECT * FROM runs ${where} ORDER BY workstream_id, seq`).all(params) as RunRow[];
      return rows.map(rowToRun);
    },
  };
}
