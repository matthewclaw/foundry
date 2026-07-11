/**
 * E6.2 — minimal read-only text search over messages.body_md, workstreams.title/goal_md,
 * and runs.result_json, for the `search_history` org-tool. Read-only, like every other
 * query file (mutate() is the only write path).
 */
// ponytail: LIKE scan until E11.5's FTS5 index.
import { formatRef, type ActorId, type AgentId, type Ref } from "@foundry/core";
import type { Db } from "../db/connection.js";

export interface SearchHit {
  ref: Ref;
  excerpt: string;
  ts: string;
}

export interface SearchQueries {
  /**
   * Substring search. `filter` narrows the corpus: messages from/to `actor_ids`,
   * workstreams (and their runs) owned by `agent_ids`. Omitted filter = org-wide.
   */
  text(query: string, filter?: { actor_ids?: ActorId[]; agent_ids?: AgentId[] }, limit?: number): SearchHit[];
}

const EXCERPT_LEN = 200;

export function createSearchQueries(db: Db): SearchQueries {
  return {
    text(query, filter, limit = 20) {
      const pattern = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const hits: SearchHit[] = [];

      const inClause = (ids: readonly string[]) => ids.map(() => "?").join(", ");

      // Messages
      {
        let sql = `SELECT id, body_md, created_at FROM messages WHERE body_md LIKE ? ESCAPE '\\'`;
        const params: unknown[] = [pattern];
        if (filter?.actor_ids) {
          sql += ` AND (from_actor_id IN (${inClause(filter.actor_ids)}) OR to_actor_id IN (${inClause(filter.actor_ids)}))`;
          params.push(...filter.actor_ids, ...filter.actor_ids);
        }
        sql += ` ORDER BY created_at DESC LIMIT ?`;
        params.push(limit);
        for (const row of db.prepare(sql).all(...params) as Array<{ id: string; body_md: string; created_at: string }>) {
          hits.push({ ref: formatRef("message", row.id), excerpt: row.body_md.slice(0, EXCERPT_LEN), ts: row.created_at });
        }
      }

      // Workstreams (title/goal)
      {
        let sql = `SELECT id, title, goal_md, created_at FROM workstreams WHERE (title LIKE ? ESCAPE '\\' OR goal_md LIKE ? ESCAPE '\\')`;
        const params: unknown[] = [pattern, pattern];
        if (filter?.agent_ids) {
          sql += ` AND agent_id IN (${inClause(filter.agent_ids)})`;
          params.push(...filter.agent_ids);
        }
        sql += ` ORDER BY created_at DESC LIMIT ?`;
        params.push(limit);
        for (const row of db.prepare(sql).all(...params) as Array<{ id: string; title: string; goal_md: string; created_at: string }>) {
          hits.push({
            ref: formatRef("workstream", row.id),
            excerpt: `${row.title}: ${row.goal_md}`.slice(0, EXCERPT_LEN),
            ts: row.created_at,
          });
        }
      }

      // Run results
      {
        let sql = `SELECT r.id, r.result_json, COALESCE(r.ended_at, r.started_at) AS ts FROM runs r
                   JOIN workstreams w ON w.id = r.workstream_id
                   WHERE r.result_json LIKE ? ESCAPE '\\' AND COALESCE(r.ended_at, r.started_at) IS NOT NULL`;
        const params: unknown[] = [pattern];
        if (filter?.agent_ids) {
          sql += ` AND w.agent_id IN (${inClause(filter.agent_ids)})`;
          params.push(...filter.agent_ids);
        }
        sql += ` ORDER BY ts DESC LIMIT ?`;
        params.push(limit);
        for (const row of db.prepare(sql).all(...params) as Array<{ id: string; result_json: string; ts: string }>) {
          hits.push({ ref: formatRef("run", row.id), excerpt: row.result_json.slice(0, EXCERPT_LEN), ts: row.ts });
        }
      }

      return hits.slice(0, limit);
    },
  };
}
