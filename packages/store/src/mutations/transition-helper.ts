/**
 * Shared read+validate step for the four state-holding entities (agent, workstream,
 * run, task). Per the work order: transitions are enforced via core's `canTransition`
 * (OPEN_ISSUES.md #6-#8), never a store-local copy of the rules.
 *
 * `mutate()`'s `events` array is data the caller must hand over before `apply()` runs
 * (contracts.md signature), so the pattern here is: read current state first (safe —
 * better-sqlite3 is synchronous and Node is single-threaded, so nothing can interleave
 * between this read and the `mutate()` call that follows it), compute the transition's
 * event name, then re-check the same row inside `apply()` before writing (a
 * compare-and-swap guard against the state having moved between the two reads).
 */
import { canTransition, transitionEvent, type StateMachineEntity } from "@foundry/core";
import type { Db } from "../db/connection.js";

export class InvalidTransitionError extends Error {
  constructor(entity: string, from: string, to: string) {
    super(`Invalid ${entity} transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export class NotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`);
    this.name = "NotFoundError";
  }
}

export function readState(db: Db, table: string, id: string, entityLabel: string): string {
  const row = db.prepare(`SELECT state FROM ${table} WHERE id = ?`).get(id) as
    | { state: string }
    | undefined;
  if (!row) throw new NotFoundError(entityLabel, id);
  return row.state;
}

/** Validates `from -> to` against core's transition table and returns the emitting event type. */
export function requireTransitionEvent(entity: StateMachineEntity, from: string, to: string): string {
  if (!canTransition(entity, from, to)) {
    throw new InvalidTransitionError(entity, from, to);
  }
  return transitionEvent(entity, from, to)!;
}

/** Re-checked inside `apply()` as a compare-and-swap guard before writing. */
export function assertStateUnchanged(db: Db, table: string, id: string, expected: string, entityLabel: string): void {
  const actual = readState(db, table, id, entityLabel);
  if (actual !== expected) {
    throw new InvalidTransitionError(entityLabel, expected, `<row moved to ${actual}>`);
  }
}
