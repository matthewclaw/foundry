/**
 * E2.5 — inbox(): items needing human attention (06: the human attention queue).
 * Full severity-then-age ranking and per-type actions are E10's job; this projection
 * supplies the two item kinds store data already supports (pending approvals, messages
 * surfaced to the human) ordered oldest-first so nothing silently ages out of view.
 */
import type { ApprovalId, MessageId, Ref } from "@foundry/core";
import type { Db } from "../db/connection.js";
import { formatRef } from "@foundry/core";

export type InboxItemKind = "approval_pending" | "message_surfaced";

export interface InboxItem {
  kind: InboxItemKind;
  ref: Ref;
  created_at: string;
  summary: string;
}

export function inbox(db: Db): InboxItem[] {
  const approvals = db
    .prepare(`SELECT id, kind, created_at FROM approvals WHERE state = 'pending' ORDER BY created_at`)
    .all() as { id: string; kind: string; created_at: string }[];

  const surfacedMessages = db
    .prepare(
      `SELECT id, type, body_md, created_at FROM messages
       WHERE visibility = 'surfaced' AND disposition IN ('open', 'none') ORDER BY created_at`
    )
    .all() as { id: string; type: string; body_md: string; created_at: string }[];

  const items: InboxItem[] = [
    ...approvals.map(
      (a): InboxItem => ({
        kind: "approval_pending",
        ref: formatRef("approval", a.id as ApprovalId),
        created_at: a.created_at,
        summary: `Approval requested: ${a.kind}`,
      })
    ),
    ...surfacedMessages.map(
      (m): InboxItem => ({
        kind: "message_surfaced",
        ref: formatRef("message", m.id as MessageId),
        created_at: m.created_at,
        summary: `${m.type}: ${m.body_md.slice(0, 80)}`,
      })
    ),
  ];

  return items.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
}
