/**
 * E2.4 — Event feed: `after(seq)` replay, in-process `subscribe`, `compactRunDeltas`
 * (05: high-volume run deltas are compactable; the durable record becomes the
 * transcript file + run result, not every delta row).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Event, EntityType, RunId } from "@foundry/core";
import type { Db } from "../db/connection.js";
import type { Mutate } from "../types.js";
import type { EventBus, Unsubscribe } from "./bus.js";
import { rowToEvent, type EventRow } from "../row-mapping.js";

export interface EventFilter {
  entity_type?: EntityType;
  type?: string;
  run_id?: string;
  workstream_id?: string;
  task_id?: string;
}

export interface EventFeed {
  after(seq: number, filter?: EventFilter): Event[];
  subscribe(cb: (e: Event) => void): Unsubscribe;
  compactRunDeltas(runId: RunId): void;
}

export function transcriptPath(dataDir: string, runId: string): string {
  return join(dataDir, "runs", runId, "transcript.md");
}

export function createEventFeed(db: Db, bus: EventBus, mutate: Mutate, dataDir: string): EventFeed {
  return {
    after(seq, filter) {
      const clauses = ["seq > @seq"];
      const params: Record<string, unknown> = { seq };
      if (filter?.entity_type) {
        clauses.push("entity_type = @entity_type");
        params.entity_type = filter.entity_type;
      }
      if (filter?.type) {
        clauses.push("type = @type");
        params.type = filter.type;
      }
      if (filter?.run_id) {
        clauses.push("run_id = @run_id");
        params.run_id = filter.run_id;
      }
      if (filter?.workstream_id) {
        clauses.push("workstream_id = @workstream_id");
        params.workstream_id = filter.workstream_id;
      }
      if (filter?.task_id) {
        clauses.push("task_id = @task_id");
        params.task_id = filter.task_id;
      }
      const rows = db
        .prepare(`SELECT * FROM events WHERE ${clauses.join(" AND ")} ORDER BY seq`)
        .all(params) as EventRow[];
      return rows.map(rowToEvent);
    },

    subscribe(cb) {
      return bus.subscribe(cb);
    },

    compactRunDeltas(runId) {
      const deltas = db
        .prepare(`SELECT * FROM events WHERE run_id = ? AND type = 'run_output_delta' ORDER BY seq`)
        .all(runId) as EventRow[];
      if (deltas.length === 0) return;

      const text = deltas
        .map((row) => (JSON.parse(row.payload_json) as { text: string }).text)
        .join("");
      const path = transcriptPath(dataDir, runId);
      mkdirSync(dirname(path), { recursive: true });
      const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
      writeFileSync(path, existing + text, "utf-8");

      const seqs = deltas.map((d) => d.seq);
      // Pruning compacted deltas is retention housekeeping, not a domain state change
      // (05) — no event catalogue type exists for it (nor should one: the transcript
      // file plus the run's own lifecycle events remain the durable audit record).
      mutate({
        apply: (tx) => {
          const placeholders = seqs.map(() => "?").join(",");
          tx.db.prepare(`DELETE FROM events WHERE seq IN (${placeholders})`).run(...seqs);
        },
        events: [],
      });
    },
  };
}
