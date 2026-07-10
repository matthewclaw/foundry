/** E2.5 — delegationTree(rootTaskId): reconstructs the parent_task_id tree (02) for display. */
import type { Task, TaskId } from "@foundry/core";
import type { Db } from "../db/connection.js";
import { rowToTask, type TaskRow } from "../mutations/tasks.js";

export interface TreeNode {
  task: Task;
  children: TreeNode[];
}

export interface TreeView {
  root: TreeNode | undefined;
}

export function delegationTree(db: Db, rootTaskId: TaskId): TreeView {
  const rows = db
    .prepare(`SELECT * FROM tasks WHERE root_task_id = ? ORDER BY depth, created_at`)
    .all(rootTaskId) as TaskRow[];
  if (rows.length === 0) return { root: undefined };

  const tasks = rows.map(rowToTask);
  const nodesById = new Map<string, TreeNode>();
  for (const task of tasks) nodesById.set(task.id, { task, children: [] });

  let root: TreeNode | undefined;
  for (const task of tasks) {
    const node = nodesById.get(task.id)!;
    if (task.parent_task_id) {
      const parent = nodesById.get(task.parent_task_id);
      parent?.children.push(node);
    } else {
      root = node;
    }
  }

  return { root };
}
