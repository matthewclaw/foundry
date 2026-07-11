/** E2.3 — Approval reads. Read-only. */
import type { Approval, ApprovalId } from "@foundry/core";
import type { Db } from "../db/connection.js";
import { rowToApproval, type ApprovalRow } from "../mutations/approvals.js";

export interface ApprovalQueries {
  get(id: ApprovalId): Approval | undefined;
  listPending(): Approval[];
  /** Most-recently-decided approvals requested by an actor (context composition, E6.4). */
  listDecidedFor(requestedByActor: string, limit?: number): Approval[];
}

export function createApprovalQueries(db: Db): ApprovalQueries {
  return {
    get(id) {
      const row = db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(id) as ApprovalRow | undefined;
      return row ? rowToApproval(row) : undefined;
    },
    listPending() {
      const rows = db
        .prepare(`SELECT * FROM approvals WHERE state = 'pending' ORDER BY created_at`)
        .all() as ApprovalRow[];
      return rows.map(rowToApproval);
    },
    listDecidedFor(requestedByActor, limit = 5) {
      const rows = db
        .prepare(
          `SELECT * FROM approvals WHERE requested_by_actor = ? AND state != 'pending' ORDER BY decided_at DESC LIMIT ?`
        )
        .all(requestedByActor, limit) as ApprovalRow[];
      return rows.map(rowToApproval);
    },
  };
}
