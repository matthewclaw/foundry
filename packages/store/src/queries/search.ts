/**
 * E6.2 — minimal read-only text search over messages.body_md, workstreams.title/goal_md,
 * and runs.result_json, for the `search_history` org-tool. Read-only, like every other
 * query file (mutate() is the only write path).
 */
// E11.5: FTS5 index over searchable corpora.
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

/**
 * Escapes user input for FTS5 MATCH by wrapping in double quotes (phrase match) and
 * doubling embedded quotes. This prevents FTS5 special characters from triggering
 * syntax errors.
 */
function escapeFts5Query(query: string): string {
  return `"${query.replace(/"/g, '""')}"`;
}

export function createSearchQueries(db: Db): SearchQueries {
  return {
    text(query, filter, limit = 20) {
      const ftsQuery = escapeFts5Query(query);
      const hits: SearchHit[] = [];

      const inClause = (ids: readonly string[]) => ids.map(() => "?").join(", ");

      // Messages
      {
        let sql = `SELECT m.id, m.body_md, m.created_at FROM messages m
                   JOIN messages_fts ON messages_fts.id = m.id
                   WHERE messages_fts.body_md MATCH ?`;
        const params: unknown[] = [ftsQuery];
        if (filter?.actor_ids) {
          sql += ` AND (m.from_actor_id IN (${inClause(filter.actor_ids)}) OR m.to_actor_id IN (${inClause(filter.actor_ids)}))`;
          params.push(...filter.actor_ids, ...filter.actor_ids);
        }
        sql += ` ORDER BY m.created_at DESC LIMIT ?`;
        params.push(limit);
        for (const row of db.prepare(sql).all(...params) as Array<{ id: string; body_md: string; created_at: string }>) {
          hits.push({ ref: formatRef("message", row.id), excerpt: row.body_md.slice(0, EXCERPT_LEN), ts: row.created_at });
        }
      }

      // Workstreams (title/goal)
      {
        // ponytail: search each FTS column separately, then merge in-memory to avoid
        // FTS OR syntax issues (MATCH doesn't compose well with OR in WHERE).
        const wsHits = new Map<string, { id: string; title: string; goal_md: string; created_at: string }>();

        let sql1 = `SELECT w.id, w.title, w.goal_md, w.created_at FROM workstreams w
                    JOIN workstreams_fts ON workstreams_fts.id = w.id
                    WHERE workstreams_fts.title MATCH ?`;
        const params1: unknown[] = [ftsQuery];
        if (filter?.agent_ids) {
          sql1 += ` AND w.agent_id IN (${inClause(filter.agent_ids)})`;
          params1.push(...filter.agent_ids);
        }
        sql1 += ` ORDER BY w.created_at DESC LIMIT ?`;
        params1.push(limit);

        try {
          for (const row of db.prepare(sql1).all(...params1) as Array<{ id: string; title: string; goal_md: string; created_at: string }>) {
            wsHits.set(row.id, row);
          }
        } catch {
          // FTS query syntax error (e.g., special characters) — skip this search.
          void 0;
        }

        // Also search goal_md
        let sql2 = `SELECT w.id, w.title, w.goal_md, w.created_at FROM workstreams w
                    JOIN workstreams_fts ON workstreams_fts.id = w.id
                    WHERE workstreams_fts.goal_md MATCH ?`;
        const params2: unknown[] = [ftsQuery];
        if (filter?.agent_ids) {
          sql2 += ` AND w.agent_id IN (${inClause(filter.agent_ids)})`;
          params2.push(...filter.agent_ids);
        }
        sql2 += ` ORDER BY w.created_at DESC LIMIT ?`;
        params2.push(limit);

        try {
          for (const row of db.prepare(sql2).all(...params2) as Array<{ id: string; title: string; goal_md: string; created_at: string }>) {
            wsHits.set(row.id, row);
          }
        } catch {
          // FTS query syntax error — skip this search.
          void 0;
        }

        // Add deduplicated results to hits
        for (const row of wsHits.values()) {
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
                   JOIN runs_fts ON runs_fts.id = r.id
                   JOIN workstreams w ON w.id = r.workstream_id
                   WHERE runs_fts.result_json MATCH ? AND COALESCE(r.ended_at, r.started_at) IS NOT NULL`;
        const params: unknown[] = [ftsQuery];
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
