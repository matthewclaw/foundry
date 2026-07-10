import {
  newWorkstreamId,
  type ActorId,
  type AgentId,
  type Budget,
  type Ref,
  type TaskId,
  type Workstream,
  type WorkstreamOrigin,
  type WorkstreamState,
  type WorkspaceRef,
} from "@foundry/core";
import type { Db } from "../db/connection.js";
import type { Mutate } from "../types.js";
import { fromJson, fromJsonNullable, toJson } from "../row-mapping.js";
import { readState, requireTransitionEvent, assertStateUnchanged } from "./transition-helper.js";

export interface CreateWorkstreamInput {
  agent_id: AgentId;
  title: string;
  goal_md: string;
  origin: WorkstreamOrigin;
  task_id?: TaskId | null;
  workspace_ref?: WorkspaceRef | null;
  budget: Budget;
}

export function createWorkstream(mutate: Mutate, input: CreateWorkstreamInput): Workstream {
  const id = newWorkstreamId();
  const now = new Date().toISOString();

  return mutate({
    apply: (tx) => {
      tx.db
        .prepare(
          `INSERT INTO workstreams (id, agent_id, title, goal_md, origin, task_id, workspace_ref_json, state, budget_json, engine_session_ref, created_at, closed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, NULL, ?, NULL)`
        )
        .run(
          id,
          input.agent_id,
          input.title,
          input.goal_md,
          input.origin,
          input.task_id ?? null,
          toJson(input.workspace_ref ?? null),
          toJson(input.budget),
          now
        );
      return {
        id,
        agent_id: input.agent_id,
        title: input.title,
        goal_md: input.goal_md,
        origin: input.origin,
        task_id: input.task_id ?? null,
        workspace_ref: input.workspace_ref ?? null,
        state: "open",
        budget: input.budget,
        engine_session_ref: null,
        created_at: now,
        closed_at: null,
      } satisfies Workstream;
    },
    events: [
      {
        actor_id: null,
        entity_type: "workstream",
        entity_id: id,
        type: "workstream_created",
        payload: { title: input.title, origin: input.origin },
      },
    ],
  });
}

export function transitionWorkstreamState(
  db: Db,
  mutate: Mutate,
  args: {
    id: string;
    to: WorkstreamState;
    actorId: ActorId | null;
    waitingOnRef?: Ref | null;
    reason?: string;
  }
): void {
  const from = readState(db, "workstreams", args.id, "workstream");
  const event = requireTransitionEvent("workstream", from, args.to);

  const payload: Record<string, unknown> =
    event === "workstream_waiting"
      ? { waiting_on_ref: args.waitingOnRef ?? null }
      : event === "workstream_blocked"
        ? { reason: args.reason ?? "" }
        : event === "workstream_reopened"
          ? { reason: args.reason }
          : {};

  mutate({
    apply: (tx) => {
      assertStateUnchanged(tx.db, "workstreams", args.id, from, "workstream");
      const closedAt = args.to === "closed" ? new Date().toISOString() : null;
      tx.db
        .prepare(`UPDATE workstreams SET state = ?, closed_at = COALESCE(?, closed_at) WHERE id = ?`)
        .run(args.to, closedAt, args.id);
    },
    events: [
      { actor_id: args.actorId, entity_type: "workstream", entity_id: args.id, type: event, payload },
    ],
  });
}

export interface WorkstreamRow {
  id: string;
  agent_id: string;
  title: string;
  goal_md: string;
  origin: string;
  task_id: string | null;
  workspace_ref_json: string | null;
  state: string;
  budget_json: string;
  engine_session_ref: string | null;
  created_at: string;
  closed_at: string | null;
}

export function rowToWorkstream(row: WorkstreamRow): Workstream {
  return {
    id: row.id as Workstream["id"],
    agent_id: row.agent_id as Workstream["agent_id"],
    title: row.title,
    goal_md: row.goal_md,
    origin: row.origin as WorkstreamOrigin,
    task_id: row.task_id as Workstream["task_id"],
    workspace_ref: fromJsonNullable(row.workspace_ref_json),
    state: row.state as WorkstreamState,
    budget: fromJson(row.budget_json, {} as Budget),
    engine_session_ref: row.engine_session_ref,
    created_at: row.created_at,
    closed_at: row.closed_at,
  };
}
