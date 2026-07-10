import {
  canTransitionDisposition,
  dispositionTransitionEvent,
  initialDisposition,
  newMessageId,
  newThreadId,
  type ActorId,
  type Message,
  type MessageType,
  type MessageVisibility,
  type Ref,
  type TeamId,
  type Thread,
  type ThreadAnchorType,
  type ThreadId,
} from "@foundry/core";
import type { Db } from "../db/connection.js";
import type { Mutate } from "../types.js";
import { fromJson } from "../row-mapping.js";
import { InvalidTransitionError, NotFoundError } from "./transition-helper.js";

/** Finds the thread for an anchor, or creates one (04: every message belongs to a thread). */
export function getOrCreateThread(db: Db, mutate: Mutate, anchorType: ThreadAnchorType, anchorId: string): Thread {
  const existing = db
    .prepare(`SELECT * FROM threads WHERE anchor_type = ? AND anchor_id = ?`)
    .get(anchorType, anchorId) as ThreadRow | undefined;
  if (existing) return rowToThread(existing);

  const id = newThreadId();
  const now = new Date().toISOString();
  return mutate({
    apply: (tx) => {
      tx.db
        .prepare(`INSERT INTO threads (id, anchor_type, anchor_id, round_count, created_at) VALUES (?, ?, ?, 0, ?)`)
        .run(id, anchorType, anchorId, now);
      return { id, anchor_type: anchorType, anchor_id: anchorId, round_count: 0, created_at: now } satisfies Thread;
    },
    events: [],
  });
}

export interface SendMessageInput {
  thread_id: ThreadId;
  from_actor_id: ActorId;
  to_actor_id?: ActorId | null;
  to_team_id?: TeamId | null;
  type: MessageType;
  body_md: string;
  refs?: Ref[];
  visibility?: MessageVisibility;
}

export function sendMessage(mutate: Mutate, input: SendMessageInput): Message {
  const id = newMessageId();
  const now = new Date().toISOString();
  const disposition = initialDisposition(input.type);

  return mutate({
    apply: (tx) => {
      tx.db
        .prepare(
          `INSERT INTO messages (id, thread_id, from_actor_id, to_actor_id, to_team_id, type, body_md, refs_json, disposition, disposition_ref, visibility, created_at, resolved_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`
        )
        .run(
          id,
          input.thread_id,
          input.from_actor_id,
          input.to_actor_id ?? null,
          input.to_team_id ?? null,
          input.type,
          input.body_md,
          JSON.stringify(input.refs ?? []),
          disposition,
          input.visibility ?? "normal",
          now
        );
      tx.db.prepare(`UPDATE threads SET round_count = round_count + 1 WHERE id = ?`).run(input.thread_id);
      return {
        id,
        thread_id: input.thread_id,
        from_actor_id: input.from_actor_id,
        to_actor_id: input.to_actor_id ?? null,
        to_team_id: input.to_team_id ?? null,
        type: input.type,
        body_md: input.body_md,
        refs: input.refs ?? [],
        disposition,
        disposition_ref: null,
        visibility: input.visibility ?? "normal",
        created_at: now,
        resolved_at: null,
      } satisfies Message;
    },
    events: [
      {
        actor_id: input.from_actor_id,
        entity_type: "message",
        entity_id: id,
        type: "message_sent",
        payload: {
          type: input.type,
          from_actor_id: input.from_actor_id,
          to_actor_id: input.to_actor_id ?? null,
          to_team_id: input.to_team_id ?? null,
          thread_id: input.thread_id,
        },
      },
    ],
  });
}

export interface ResolveMessageDispositionArgs {
  id: string;
  messageType: MessageType;
  to: string;
  actorId: ActorId | null;
  dispositionRef?: Ref | null;
}

/** Resolves a message's disposition (answer/expire/etc.) per its type's closed set (OPEN_ISSUES.md #8). */
export function resolveMessageDisposition(db: Db, mutate: Mutate, args: ResolveMessageDispositionArgs): void {
  const row = db.prepare(`SELECT disposition FROM messages WHERE id = ?`).get(args.id) as
    | { disposition: string }
    | undefined;
  if (!row) throw new NotFoundError("message", args.id);
  if (!canTransitionDisposition(args.messageType, row.disposition, args.to)) {
    throw new InvalidTransitionError(`message[${args.messageType}]`, row.disposition, args.to);
  }
  const event = dispositionTransitionEvent(args.messageType, row.disposition, args.to)!;

  mutate({
    apply: (tx) => {
      const now = new Date().toISOString();
      tx.db
        .prepare(
          `UPDATE messages SET disposition = ?, disposition_ref = ?, resolved_at = ? WHERE id = ? AND disposition = ?`
        )
        .run(args.to, args.dispositionRef ?? null, now, args.id, row.disposition);
    },
    events: [
      {
        actor_id: args.actorId,
        entity_type: "message",
        entity_id: args.id,
        type: event,
        payload: { disposition: args.to, disposition_ref: args.dispositionRef ?? null },
      },
    ],
  });
}

interface ThreadRow {
  id: string;
  anchor_type: string;
  anchor_id: string;
  round_count: number;
  created_at: string;
}

function rowToThread(row: ThreadRow): Thread {
  return {
    id: row.id as Thread["id"],
    anchor_type: row.anchor_type as ThreadAnchorType,
    anchor_id: row.anchor_id,
    round_count: row.round_count,
    created_at: row.created_at,
  };
}

export interface MessageRow {
  id: string;
  thread_id: string;
  from_actor_id: string;
  to_actor_id: string | null;
  to_team_id: string | null;
  type: string;
  body_md: string;
  refs_json: string;
  disposition: string;
  disposition_ref: string | null;
  visibility: string;
  created_at: string;
  resolved_at: string | null;
}

export function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id as Message["id"],
    thread_id: row.thread_id as Message["thread_id"],
    from_actor_id: row.from_actor_id as Message["from_actor_id"],
    to_actor_id: row.to_actor_id as Message["to_actor_id"],
    to_team_id: row.to_team_id as Message["to_team_id"],
    type: row.type as MessageType,
    body_md: row.body_md,
    refs: fromJson(row.refs_json, []),
    disposition: row.disposition,
    disposition_ref: row.disposition_ref as Message["disposition_ref"],
    visibility: row.visibility as MessageVisibility,
    created_at: row.created_at,
    resolved_at: row.resolved_at,
  };
}
