/**
 * Store-local types that aren't part of `@foundry/core` (core defines entity/event
 * shapes; `Tx`/`NewEvent` are this package's own mutation-plumbing types).
 */
import type { ActorId, Event, RunId, TaskId, WorkstreamId } from "@foundry/core";
import type { Db } from "./db/connection.js";

/**
 * A transaction handle. `apply()` callbacks passed to `mutate()` get this and this
 * only — there is no other way to obtain a writable handle to the database, which is
 * what makes `mutate()` the sole write path (E2.2).
 */
export interface Tx {
  db: Db;
}

/** An event not yet assigned a `seq` — `mutate()` assigns it on insert. */
export type NewEvent = {
  ts?: string;
  actor_id: ActorId | null;
  entity_type: Event["entity_type"];
  entity_id: string;
  type: string;
  payload: unknown;
  run_id?: RunId | null;
  workstream_id?: WorkstreamId | null;
  task_id?: TaskId | null;
};

export interface MutateArgs<T> {
  apply(tx: Tx): T;
  events: NewEvent[];
}

export type Mutate = <T>(m: MutateArgs<T>) => T;
