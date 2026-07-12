/** E2.3 — Task reads, incl. `tree()` (contracts.md "incl. tree(rootTaskId)"). Read-only. */
import type { AgentId, Task, TaskId, TaskState } from "@foundry/core";
import type { Db } from "../db/connection.js";
import { rowToTask, type TaskRow } from "../mutations/tasks.js";

export interface TaskQueries {
  get(id: TaskId): Task | undefined;
  list(filter?: { assignee_agent_id?: AgentId; state?: TaskState; parent_task_id?: TaskId }): Task[];
  /** Every task sharing `rootTaskId` (the whole delegation tree, 02), ordered depth-first by depth. */
  tree(rootTaskId: TaskId): Task[];
}

export function createTaskQueries(db: Db): TaskQueries {
  return {
    get(id) {
      const row = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskRow | undefined;
      return row ? rowToTask(row) : undefined;
    },
    list(filter) {
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (filter?.assignee_agent_id) {
        clauses.push("assignee_agent_id = @assignee_agent_id");
        params.assignee_agent_id = filter.assignee_agent_id;
      }
      if (filter?.state) {
        clauses.push("state = @state");
        params.state = filter.state;
      }
      if (filter?.parent_task_id) {
        clauses.push("parent_task_id = @parent_task_id");
        params.parent_task_id = filter.parent_task_id;
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = db.prepare(`SELECT * FROM tasks ${where} ORDER BY created_at`).all(params) as TaskRow[];
      return rows.map(rowToTask);
    },
    tree(rootTaskId) {
      const rows = db
        .prepare(`SELECT * FROM tasks WHERE root_task_id = ? ORDER BY depth, created_at`)
        .all(rootTaskId) as TaskRow[];
      return rows.map(rowToTask);
    },
  };
}
