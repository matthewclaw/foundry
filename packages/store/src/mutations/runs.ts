import {
  newRunId,
  type ActorId,
  type Run,
  type RunResult,
  type RunState,
  type RunTrigger,
  type Usage,
  type WorkstreamId,
} from "@foundry/core";
import type { Db } from "../db/connection.js";
import type { Mutate, NewEvent } from "../types.js";
import { fromJsonNullable, toJson } from "../row-mapping.js";
import { readState, requireTransitionEvent, assertStateUnchanged } from "./transition-helper.js";

export interface CreateRunInput {
  workstream_id: WorkstreamId;
  trigger: RunTrigger;
  input_context_ref: string;
  engine_id: string;
  /** The message body that triggered this run (human_message/redirect/agent_message)
   * — carried on the run_queued event so the timeline can show what was actually said,
   * not just the trigger kind. */
  trigger_message_md?: string;
}

export function createRun(mutate: Mutate, input: CreateRunInput): Run {
  const id = newRunId();
  // The conventional context path (05: `runs/<run-id>/context.md`) needs the id this
  // function generates, so callers may use a `{run_id}` token (OPEN_ISSUES #29).
  const inputContextRef = input.input_context_ref.replace("{run_id}", id);
  const now = new Date().toISOString();

  return mutate({
    apply: (tx) => {
      const { next } = tx.db
        .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM runs WHERE workstream_id = ?`)
        .get(input.workstream_id) as { next: number };
      tx.db
        .prepare(
          `INSERT INTO runs (id, workstream_id, seq, trigger, input_context_ref, engine_id, engine_session_id, state, result_json, usage_json, started_at, ended_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, 'queued', NULL, NULL, NULL, NULL)`
        )
        .run(id, input.workstream_id, next, input.trigger, inputContextRef, input.engine_id);
      return {
        id,
        workstream_id: input.workstream_id,
        seq: next,
        trigger: input.trigger,
        input_context_ref: inputContextRef,
        engine: input.engine_id,
        engine_session_id: null,
        state: "queued",
        result: null,
        usage: null,
        started_at: null,
        ended_at: null,
        title: null,
      } satisfies Run;
    },
    events: [
      {
        actor_id: null,
        entity_type: "run",
        entity_id: id,
        type: "run_queued",
        payload: input.trigger_message_md
          ? { trigger: input.trigger, message_md: input.trigger_message_md }
          : { trigger: input.trigger },
        run_id: id,
        workstream_id: input.workstream_id,
      },
    ],
  });
}

export interface TransitionRunStateArgs {
  id: string;
  workstreamId: WorkstreamId;
  to: RunState;
  actorId: ActorId | null;
  result?: RunResult;
  error?: string;
  engineSessionId?: string | null;
  prompt?: string;
  reason?: string;
}

export function transitionRunState(db: Db, mutate: Mutate, args: TransitionRunStateArgs): void {
  const from = readState(db, "runs", args.id, "run");
  const event = requireTransitionEvent("run", from, args.to);

  const payload: Record<string, unknown> =
    event === "run_started"
      ? { engine: (db.prepare(`SELECT engine_id FROM runs WHERE id = ?`).get(args.id) as { engine_id: string }).engine_id }
      : event === "run_completed"
        ? { result: args.result }
        : event === "run_failed"
          ? { error: args.error ?? "" }
          : event === "run_awaiting_input"
            ? { prompt: args.prompt ?? "" }
            : event === "run_running"
              ? { engine_session_id: args.engineSessionId ?? null }
              : event === "run_interrupted" || event === "run_cancelled"
                ? { reason: args.reason }
                : {};

  mutate({
    apply: (tx) => {
      assertStateUnchanged(tx.db, "runs", args.id, from, "run");
      const startedAt = args.to === "running" && from === "starting" ? new Date().toISOString() : null;
      const terminal = ["completed", "failed", "interrupted", "cancelled"].includes(args.to);
      const endedAt = terminal ? new Date().toISOString() : null;
      tx.db
        .prepare(
          `UPDATE runs SET state = ?, result_json = COALESCE(?, result_json), engine_session_id = COALESCE(?, engine_session_id), started_at = COALESCE(started_at, ?), ended_at = COALESCE(?, ended_at) WHERE id = ?`
        )
        .run(args.to, toJson(args.result ?? null), args.engineSessionId ?? null, startedAt, endedAt, args.id);
      if (args.result) {
        // "INSERT OR REPLACE" only dedupes against a UNIQUE constraint, which FTS5
        // virtual tables can't declare on a plain column — verified empirically it just
        // inserts a second row, not a replace. Delete-then-insert instead, so a run
        // whose result gets set more than once (defense in depth; the state machine
        // otherwise guarantees exactly one) can't leave stale duplicate FTS rows.
        tx.db.prepare(`DELETE FROM runs_fts WHERE id = ?`).run(args.id);
        tx.db.prepare(`INSERT INTO runs_fts (id, result_json) VALUES (?, ?)`).run(args.id, toJson(args.result));
      }
    },
    events: [
      {
        actor_id: args.actorId,
        entity_type: "run",
        entity_id: args.id,
        type: event,
        payload,
        run_id: args.id as Run["id"],
        workstream_id: args.workstreamId,
      },
    ],
  });
}

/** Append-only run-detail events (07/adapter-api): usage, tool calls, output deltas. No table write. */
export function emitRunDetailEvent(
  mutate: Mutate,
  event: Pick<NewEvent, "entity_id" | "type" | "payload" | "run_id" | "workstream_id" | "actor_id">
): void {
  mutate({
    apply: () => undefined,
    events: [{ entity_type: "run", ...event }],
  });
}

export interface SetRunTitleArgs {
  id: string;
  workstreamId: WorkstreamId;
  title: string;
}

/** Renames the conversation this run belongs to. Not state-machine-gated (unlike
 * transitionRunState) — a display label, settable at any point in the run's life. */
export function setRunTitle(mutate: Mutate, args: SetRunTitleArgs): void {
  mutate({
    apply: (tx) => {
      tx.db.prepare(`UPDATE runs SET title = ? WHERE id = ?`).run(args.title, args.id);
    },
    events: [
      {
        actor_id: null,
        entity_type: "run",
        entity_id: args.id,
        type: "run_titled",
        payload: { title: args.title },
        run_id: args.id as Run["id"],
        workstream_id: args.workstreamId,
      },
    ],
  });
}

export interface RunRow {
  id: string;
  workstream_id: string;
  seq: number;
  trigger: string;
  input_context_ref: string;
  engine_id: string;
  engine_session_id: string | null;
  state: string;
  result_json: string | null;
  usage_json: string | null;
  started_at: string | null;
  ended_at: string | null;
  title: string | null;
}

export function rowToRun(row: RunRow): Run {
  return {
    id: row.id as Run["id"],
    workstream_id: row.workstream_id as Run["workstream_id"],
    seq: row.seq,
    trigger: row.trigger as RunTrigger,
    input_context_ref: row.input_context_ref,
    engine: row.engine_id,
    engine_session_id: row.engine_session_id,
    state: row.state as RunState,
    result: fromJsonNullable(row.result_json),
    usage: fromJsonNullable<Usage>(row.usage_json),
    started_at: row.started_at,
    ended_at: row.ended_at,
    title: row.title,
  };
}
