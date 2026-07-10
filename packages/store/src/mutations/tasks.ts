import {
  newTaskId,
  type ActorId,
  type AgentId,
  type Budget,
  type DeliverableRef,
  type RoutingSpec,
  type Task,
  type TaskId,
  type TaskState,
} from "@foundry/core";
import type { Db } from "../db/connection.js";
import type { Mutate } from "../types.js";
import { fromJson, fromJsonNullable, toJson } from "../row-mapping.js";
import { readState, requireTransitionEvent, assertStateUnchanged } from "./transition-helper.js";

export interface CreateTaskInput {
  parent_task_id: TaskId | null;
  delegator_actor_id: ActorId;
  assignee_agent_id: AgentId;
  routing_spec?: RoutingSpec | null;
  spec_md: string;
  acceptance_criteria_md: string;
  budget: Budget;
}

export function createTask(db: Db, mutate: Mutate, input: CreateTaskInput): Task {
  const id = newTaskId();
  const now = new Date().toISOString();

  let rootTaskId: TaskId = id;
  let depth = 0;
  if (input.parent_task_id) {
    const parent = db
      .prepare(`SELECT root_task_id, depth FROM tasks WHERE id = ?`)
      .get(input.parent_task_id) as { root_task_id: string; depth: number } | undefined;
    if (!parent) throw new Error(`Parent task not found: ${input.parent_task_id}`);
    rootTaskId = parent.root_task_id as TaskId;
    depth = parent.depth + 1;
  }

  return mutate({
    apply: (tx) => {
      tx.db
        .prepare(
          `INSERT INTO tasks (id, parent_task_id, root_task_id, depth, delegator_actor_id, assignee_agent_id, routing_spec_json, spec_md, acceptance_criteria_md, budget_json, state, deliverable_ref_json, accepted_by, accepted_at, rejection_count, created_at, closed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, 0, ?, NULL)`
        )
        .run(
          id,
          input.parent_task_id,
          rootTaskId,
          depth,
          input.delegator_actor_id,
          input.assignee_agent_id,
          toJson(input.routing_spec ?? null),
          input.spec_md,
          input.acceptance_criteria_md,
          toJson(input.budget),
          now
        );
      return {
        id,
        parent_task_id: input.parent_task_id,
        root_task_id: rootTaskId,
        depth,
        delegator_actor_id: input.delegator_actor_id,
        assignee_agent_id: input.assignee_agent_id,
        routing_spec: input.routing_spec ?? null,
        spec_md: input.spec_md,
        acceptance_criteria_md: input.acceptance_criteria_md,
        budget: input.budget,
        state: "pending",
        deliverable_ref: null,
        accepted_by: null,
        accepted_at: null,
        rejection_count: 0,
        created_at: now,
        closed_at: null,
      } satisfies Task;
    },
    events: [
      {
        actor_id: input.delegator_actor_id,
        entity_type: "task",
        entity_id: id,
        type: "task_created",
        payload: {
          title: input.spec_md.slice(0, 80),
          assignee_agent_id: input.assignee_agent_id,
          delegator_actor_id: input.delegator_actor_id,
          budget: input.budget,
          depth,
        },
        task_id: id as TaskId,
      },
    ],
  });
}

export interface TransitionTaskStateArgs {
  id: string;
  to: TaskState;
  actorId: ActorId | null;
  reason?: string;
  deliverableRef?: DeliverableRef;
  acceptedBy?: ActorId;
}

export function transitionTaskState(db: Db, mutate: Mutate, args: TransitionTaskStateArgs): void {
  const from = readState(db, "tasks", args.id, "task");
  const event = requireTransitionEvent("task", from, args.to);

  let rejectionCount: number | undefined;
  if (event === "task_rejected") {
    const row = db.prepare(`SELECT rejection_count FROM tasks WHERE id = ?`).get(args.id) as {
      rejection_count: number;
    };
    rejectionCount = row.rejection_count + 1;
  }

  const payload: Record<string, unknown> =
    event === "task_delivered"
      ? { deliverable_ref: args.deliverableRef }
      : event === "task_accepted"
        ? { accepted_by: args.acceptedBy }
        : event === "task_rejected"
          ? { reason: args.reason ?? "", rejection_count: rejectionCount }
          : event === "task_blocked"
            ? { reason: args.reason ?? "" }
            : event === "task_cancelled"
              ? { reason: args.reason }
              : {};

  mutate({
    apply: (tx) => {
      assertStateUnchanged(tx.db, "tasks", args.id, from, "task");
      const closedAt = ["done", "cancelled"].includes(args.to) ? new Date().toISOString() : null;
      tx.db
        .prepare(
          `UPDATE tasks SET state = ?, deliverable_ref_json = COALESCE(?, deliverable_ref_json), accepted_by = COALESCE(?, accepted_by), accepted_at = COALESCE(?, accepted_at), rejection_count = COALESCE(?, rejection_count), closed_at = COALESCE(?, closed_at) WHERE id = ?`
        )
        .run(
          args.to,
          toJson(args.deliverableRef ?? null),
          args.acceptedBy ?? null,
          args.to === "done" ? new Date().toISOString() : null,
          rejectionCount ?? null,
          closedAt,
          args.id
        );
    },
    events: [
      { actor_id: args.actorId, entity_type: "task", entity_id: args.id, type: event, payload, task_id: args.id as TaskId },
    ],
  });
}

export interface TaskRow {
  id: string;
  parent_task_id: string | null;
  root_task_id: string;
  depth: number;
  delegator_actor_id: string;
  assignee_agent_id: string;
  routing_spec_json: string | null;
  spec_md: string;
  acceptance_criteria_md: string;
  budget_json: string;
  state: string;
  deliverable_ref_json: string | null;
  accepted_by: string | null;
  accepted_at: string | null;
  rejection_count: number;
  created_at: string;
  closed_at: string | null;
}

export function rowToTask(row: TaskRow): Task {
  return {
    id: row.id as Task["id"],
    parent_task_id: row.parent_task_id as Task["parent_task_id"],
    root_task_id: row.root_task_id as Task["root_task_id"],
    depth: row.depth,
    delegator_actor_id: row.delegator_actor_id as Task["delegator_actor_id"],
    assignee_agent_id: row.assignee_agent_id as Task["assignee_agent_id"],
    routing_spec: fromJsonNullable(row.routing_spec_json),
    spec_md: row.spec_md,
    acceptance_criteria_md: row.acceptance_criteria_md,
    budget: fromJson(row.budget_json, {} as Budget),
    state: row.state as TaskState,
    deliverable_ref: fromJsonNullable(row.deliverable_ref_json),
    accepted_by: row.accepted_by as Task["accepted_by"],
    accepted_at: row.accepted_at,
    rejection_count: row.rejection_count,
    created_at: row.created_at,
    closed_at: row.closed_at,
  };
}
