/**
 * Hard deletes — physical row removal, the housekeeping counterpart to the soft paths
 * (workstream `close`, agent `retire`). The audit model keeps history for *live* work;
 * these exist to purge junk (abandoned test workstreams, orphaned agents) that would
 * otherwise linger forever with no way out.
 *
 * FKs are enforced (`foreign_keys = ON`), so every dependent row is removed in
 * reverse-dependency order, including the three FTS mirror tables. `task_id` on
 * workstreams and every column on `events`/`threads` are plain TEXT (no FK), so those
 * are cleaned by filter, not cascade.
 *
 * These do NOT touch on-disk state (memory/skills dirs, git worktrees) — worktrees are
 * released by the runtime's cancelRun before a delete, and memory dirs are small and
 * git-versioned. The route layer cancels any live runs first; a raw row delete can't
 * reach a running process.
 */
import type { AgentId, WorkstreamId } from "@foundry/core";
import type { Db } from "../db/connection.js";
import type { Mutate, Tx } from "../types.js";

/** Delete one workstream and everything owned solely by it, inside an existing tx. */
function cascadeWorkstream(tx: Tx, wsId: string): void {
  const runIds = (tx.db.prepare(`SELECT id FROM runs WHERE workstream_id = ?`).all(wsId) as { id: string }[]).map(
    (r) => r.id
  );
  for (const runId of runIds) {
    tx.db.prepare(`DELETE FROM artifacts WHERE run_id = ?`).run(runId);
    tx.db.prepare(`DELETE FROM runs_fts WHERE id = ?`).run(runId);
    tx.db.prepare(`DELETE FROM events WHERE run_id = ?`).run(runId);
  }
  tx.db.prepare(`DELETE FROM runs WHERE workstream_id = ?`).run(wsId);

  // Threads anchored to this workstream, and their messages.
  const threadIds = (
    tx.db.prepare(`SELECT id FROM threads WHERE anchor_type = 'workstream' AND anchor_id = ?`).all(wsId) as {
      id: string;
    }[]
  ).map((t) => t.id);
  for (const threadId of threadIds) {
    const msgIds = (tx.db.prepare(`SELECT id FROM messages WHERE thread_id = ?`).all(threadId) as { id: string }[]).map(
      (m) => m.id
    );
    for (const msgId of msgIds) tx.db.prepare(`DELETE FROM messages_fts WHERE id = ?`).run(msgId);
    tx.db.prepare(`DELETE FROM messages WHERE thread_id = ?`).run(threadId);
    tx.db.prepare(`DELETE FROM threads WHERE id = ?`).run(threadId);
  }

  tx.db.prepare(`DELETE FROM events WHERE workstream_id = ? OR entity_id = ?`).run(wsId, wsId);
  tx.db.prepare(`DELETE FROM workstreams_fts WHERE id = ?`).run(wsId);
  tx.db.prepare(`DELETE FROM workstreams WHERE id = ?`).run(wsId);
}

/** Hard-delete a single workstream (its runs, artifacts, thread/messages, events). */
export function deleteWorkstream(db: Db, mutate: Mutate, id: WorkstreamId): void {
  const row = db.prepare(`SELECT id FROM workstreams WHERE id = ?`).get(id);
  if (!row) throw new Error(`workstream not found: ${id}`);
  mutate({
    apply: (tx) => cascadeWorkstream(tx, id),
    events: [],
  });
}

/**
 * Hard-delete an agent and everything it owns: its workstreams (full cascade), charters,
 * schedules, tasks assigned to it, and its actor. Tasks it delegated to *other* agents
 * survive (they belong to those agents' work) — their parent pointer is nulled so they
 * become roots rather than dangling into the deleted rows.
 */
export function deleteAgent(db: Db, mutate: Mutate, id: AgentId): void {
  const agent = db.prepare(`SELECT id, actor_id FROM agents WHERE id = ?`).get(id) as
    | { id: string; actor_id: string }
    | undefined;
  if (!agent) throw new Error(`agent not found: ${id}`);

  mutate({
    apply: (tx) => {
      const wsIds = (tx.db.prepare(`SELECT id FROM workstreams WHERE agent_id = ?`).all(id) as { id: string }[]).map(
        (w) => w.id
      );
      for (const wsId of wsIds) cascadeWorkstream(tx, wsId);

      const taskIds = (tx.db.prepare(`SELECT id FROM tasks WHERE assignee_agent_id = ?`).all(id) as { id: string }[]).map(
        (t) => t.id
      );
      for (const taskId of taskIds) {
        tx.db.prepare(`UPDATE tasks SET parent_task_id = NULL WHERE parent_task_id = ?`).run(taskId);
        tx.db.prepare(`DELETE FROM events WHERE task_id = ?`).run(taskId);
        tx.db.prepare(`DELETE FROM tasks WHERE id = ?`).run(taskId);
      }

      tx.db.prepare(`DELETE FROM agent_charters WHERE agent_id = ?`).run(id);
      tx.db.prepare(`DELETE FROM schedules WHERE agent_id = ?`).run(id);
      tx.db.prepare(`DELETE FROM events WHERE entity_id = ?`).run(id);
      tx.db.prepare(`DELETE FROM agents WHERE id = ?`).run(id);
      tx.db.prepare(`DELETE FROM actors WHERE id = ?`).run(agent.actor_id);
    },
    events: [],
  });
}
