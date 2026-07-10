/**
 * E2.2 ⚠ KEYSTONE — `mutate()`: the only write path (contracts.md, ADR-002). A state
 * change and its event(s) commit atomically or not at all. Implemented as one
 * better-sqlite3 transaction: `apply(tx)` performs the state change, then every event
 * in `m.events` is validated against the core catalogue and inserted; if anything
 * throws (bad payload, constraint violation, or a caller simulating a crash) the whole
 * transaction rolls back and neither the state change nor any event is left behind.
 * Events only reach `subscribe()`rs after the transaction has actually committed.
 */
import { getEventPayloadSchema, isKnownEventType, type Event } from "@foundry/core";
import type { Db } from "./db/connection.js";
import type { EventBus } from "./events/bus.js";
import type { Mutate, MutateArgs, NewEvent, Tx } from "./types.js";
import { rowToEvent } from "./row-mapping.js";

const INSERT_EVENT = `
INSERT INTO events (ts, actor_id, entity_type, entity_id, type, payload_json, run_id, workstream_id, task_id)
VALUES (@ts, @actor_id, @entity_type, @entity_id, @type, @payload_json, @run_id, @workstream_id, @task_id)
`;

function insertEvent(db: Db, e: NewEvent): Event {
  if (isKnownEventType(e.type)) {
    // Throws on a payload that doesn't match its catalogue schema — rolls back the tx.
    getEventPayloadSchema(e.type)!.parse(e.payload);
  }
  const ts = e.ts ?? new Date().toISOString();
  const info = db.prepare(INSERT_EVENT).run({
    ts,
    actor_id: e.actor_id,
    entity_type: e.entity_type,
    entity_id: e.entity_id,
    type: e.type,
    payload_json: JSON.stringify(e.payload ?? {}),
    run_id: e.run_id ?? null,
    workstream_id: e.workstream_id ?? null,
    task_id: e.task_id ?? null,
  });
  const row = db
    .prepare(`SELECT * FROM events WHERE seq = ?`)
    .get(info.lastInsertRowid) as Parameters<typeof rowToEvent>[0];
  return rowToEvent(row);
}

export function createMutate(db: Db, bus: EventBus): Mutate {
  function runInTransaction<T>(m: MutateArgs<T>): { result: T; events: Event[] } {
    const tx: Tx = { db };
    const result = m.apply(tx);
    const events = m.events.map((e) => insertEvent(db, e));
    return { result, events };
  }

  // better-sqlite3's `.transaction()` typing can't preserve a generic function's type
  // parameter through assignment; the cast below is a compile-time-only bridge back
  // to the caller's `T` (generics are erased at runtime, so this is sound).
  const transactional = db.transaction((m: MutateArgs<unknown>) => runInTransaction(m));

  return function mutate<T>(m: MutateArgs<T>): T {
    const { result, events } = transactional(m as MutateArgs<unknown>) as {
      result: T;
      events: Event[];
    };
    bus.publish(events);
    return result;
  };
}
