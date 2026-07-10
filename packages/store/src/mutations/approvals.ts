import { newApprovalId, type ActorId, type Approval, type ApprovalState } from "@foundry/core";
import type { Db } from "../db/connection.js";
import type { Mutate } from "../types.js";
import { fromJsonNullable, toJson } from "../row-mapping.js";
import { InvalidTransitionError, NotFoundError } from "./transition-helper.js";

export function requestApproval(
  mutate: Mutate,
  input: { requested_by_actor: ActorId; kind: string; payload?: unknown }
): Approval {
  const id = newApprovalId();
  const now = new Date().toISOString();

  return mutate({
    apply: (tx) => {
      tx.db
        .prepare(
          `INSERT INTO approvals (id, requested_by_actor, kind, payload_json, state, decided_by_actor, decided_at, created_at)
           VALUES (?, ?, ?, ?, 'pending', NULL, NULL, ?)`
        )
        .run(id, input.requested_by_actor, input.kind, toJson(input.payload), now);
      return {
        id,
        requested_by_actor: input.requested_by_actor,
        kind: input.kind,
        payload: input.payload,
        state: "pending",
        decided_by_actor: null,
        decided_at: null,
        created_at: now,
      } satisfies Approval;
    },
    events: [
      {
        actor_id: input.requested_by_actor,
        entity_type: "approval",
        entity_id: id,
        type: "approval_requested",
        payload: { kind: input.kind, requested_by_actor: input.requested_by_actor },
      },
    ],
  });
}

export function decideApproval(
  db: Db,
  mutate: Mutate,
  args: { id: string; decision: "granted" | "denied"; decided_by_actor: ActorId; reason?: string }
): void {
  const row = db.prepare(`SELECT state FROM approvals WHERE id = ?`).get(args.id) as
    | { state: ApprovalState }
    | undefined;
  if (!row) throw new NotFoundError("approval", args.id);
  if (row.state !== "pending") {
    throw new InvalidTransitionError("approval", row.state, args.decision);
  }

  mutate({
    apply: (tx) => {
      const now = new Date().toISOString();
      tx.db
        .prepare(
          `UPDATE approvals SET state = ?, decided_by_actor = ?, decided_at = ? WHERE id = ? AND state = 'pending'`
        )
        .run(args.decision, args.decided_by_actor, now, args.id);
    },
    events: [
      {
        actor_id: args.decided_by_actor,
        entity_type: "approval",
        entity_id: args.id,
        type: args.decision === "granted" ? "approval_granted" : "approval_denied",
        payload:
          args.decision === "granted"
            ? { decided_by_actor: args.decided_by_actor }
            : { decided_by_actor: args.decided_by_actor, reason: args.reason },
      },
    ],
  });
}

export interface ApprovalRow {
  id: string;
  requested_by_actor: string;
  kind: string;
  payload_json: string | null;
  state: string;
  decided_by_actor: string | null;
  decided_at: string | null;
  created_at: string;
}

export function rowToApproval(row: ApprovalRow): Approval {
  return {
    id: row.id as Approval["id"],
    requested_by_actor: row.requested_by_actor as Approval["requested_by_actor"],
    kind: row.kind,
    payload: fromJsonNullable(row.payload_json) ?? undefined,
    state: row.state as ApprovalState,
    decided_by_actor: row.decided_by_actor as Approval["decided_by_actor"],
    decided_at: row.decided_at,
    created_at: row.created_at,
  };
}
