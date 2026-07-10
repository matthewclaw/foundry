/** E2.3 — Message + thread reads. Read-only. */
import type { ActorId, Message, MessageId, Thread, ThreadId } from "@foundry/core";
import type { Db } from "../db/connection.js";
import { rowToMessage, type MessageRow } from "../mutations/messages.js";

export interface MessageQueries {
  get(id: MessageId): Message | undefined;
  listByThread(threadId: ThreadId): Message[];
  /** Open-disposition messages addressed to an actor directly (inbox building block). */
  listOpenForActor(actorId: ActorId): Message[];
  getThread(id: ThreadId): Thread | undefined;
}

export function createMessageQueries(db: Db): MessageQueries {
  return {
    get(id) {
      const row = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as MessageRow | undefined;
      return row ? rowToMessage(row) : undefined;
    },
    listByThread(threadId) {
      const rows = db
        .prepare(`SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at`)
        .all(threadId) as MessageRow[];
      return rows.map(rowToMessage);
    },
    listOpenForActor(actorId) {
      const rows = db
        .prepare(
          `SELECT * FROM messages WHERE to_actor_id = ? AND disposition = 'open' ORDER BY created_at`
        )
        .all(actorId) as MessageRow[];
      return rows.map(rowToMessage);
    },
    getThread(id) {
      const row = db.prepare(`SELECT * FROM threads WHERE id = ?`).get(id) as ThreadRow | undefined;
      return row
        ? {
            id: row.id as Thread["id"],
            anchor_type: row.anchor_type as Thread["anchor_type"],
            anchor_id: row.anchor_id,
            round_count: row.round_count,
            created_at: row.created_at,
          }
        : undefined;
    },
  };
}

interface ThreadRow {
  id: string;
  anchor_type: string;
  anchor_id: string;
  round_count: number;
  created_at: string;
}
