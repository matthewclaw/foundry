/**
 * Row <-> core-entity mapping helpers shared by mutation helpers, queries, and
 * projections. SQLite has no native JSON/boolean type, so `*_json` columns round-trip
 * through `JSON.stringify`/`JSON.parse` and booleans through 0/1 (05-data-and-persistence.md).
 */
import type { Event, EntityType } from "@foundry/core";

export function toJson(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

export function fromJson<T>(value: string | null, fallback: T): T {
  return value === null || value === undefined ? fallback : (JSON.parse(value) as T);
}

export function fromJsonNullable<T>(value: string | null): T | null {
  return value === null || value === undefined ? null : (JSON.parse(value) as T);
}

export function boolToInt(value: boolean): number {
  return value ? 1 : 0;
}

export function intToBool(value: number): boolean {
  return value !== 0;
}

export interface EventRow {
  seq: number;
  ts: string;
  actor_id: string | null;
  entity_type: string;
  entity_id: string;
  type: string;
  payload_json: string;
  run_id: string | null;
  workstream_id: string | null;
  task_id: string | null;
}

export function rowToEvent(row: EventRow): Event {
  return {
    seq: row.seq,
    ts: row.ts,
    actor_id: row.actor_id,
    entity_type: row.entity_type as EntityType,
    entity_id: row.entity_id,
    type: row.type,
    payload: JSON.parse(row.payload_json),
    run_id: row.run_id,
    workstream_id: row.workstream_id,
    task_id: row.task_id,
  } as Event;
}
