/**
 * E8.1 — shared accept/reject decision logic for a delivered task, used by both the
 * `accept_task`/`reject_task` org-tools (an agent delegator deciding on its own
 * subordinate's work, doc-04: "agents review their own subordinates") and the
 * human-facing `POST /api/tasks/:id/{accept,reject}` route (root tasks, doc-04:
 * "roots delegated by the human are accepted by the human"). One place for the
 * F12 rejection-cap check and the escalation/re-trigger side effects so the two
 * callers can't drift.
 *
 * E8.6 — task cancellation cascade: cancel a task and its entire subtree of delegated children.
 */
import type { ActorId, PolicyError, Task } from "@foundry/core";
import { terminalStates } from "@foundry/core";
import type { Store } from "@foundry/store";
import type { Runtime } from "@foundry/runtime";
import { checkRejection, resolvePolicy } from "../policy/policy.js";

export interface DecideTaskArgs {
  store: Store;
  runtime: Runtime;
  taskId: string;
  decidedBy: ActorId;
}

function requireDeliverable(store: Store, taskId: string): Task | PolicyError {
  const task = store.tasks.get(taskId as never);
  if (!task) return { code: "assignee_not_found", message: `Task not found: ${taskId}` };
  if (task.state !== "delivered") {
    return { code: "invalid_transition", message: `Cannot decide task from state "${task.state}" — must be "delivered"` };
  }
  return task;
}

export function acceptTask(args: DecideTaskArgs): PolicyError | null {
  const task = requireDeliverable(args.store, args.taskId);
  if ("code" in task) return task;

  args.store.commands.transitionTaskState({
    id: task.id,
    to: "done",
    actorId: args.decidedBy,
    acceptedBy: args.decidedBy,
  });
  return null;
}

export interface RejectTaskArgs extends DecideTaskArgs {
  reason: string;
}

export interface RejectTaskOutcome {
  /** true when the F12 rejection cap was hit — task stays `rejected`, no auto-resume (OPEN_ISSUES #7). */
  escalated: boolean;
}

export function rejectTask(args: RejectTaskArgs): RejectTaskOutcome | PolicyError {
  const task = requireDeliverable(args.store, args.taskId);
  if ("code" in task) return task;

  args.store.commands.transitionTaskState({
    id: task.id,
    to: "rejected",
    actorId: args.decidedBy,
    reason: args.reason,
  });
  const rejected = args.store.tasks.get(task.id)!;

  // assignee_agent_id always references a real, never-deleted agent row (agents are
  // suspended/retired, never removed — doc-02 lifecycle).
  const assignee = args.store.agents.get(rejected.assignee_agent_id)!;
  const policy = resolvePolicy(args.store, assignee);
  const capped = checkRejection({ rejection_count: rejected.rejection_count }, policy);

  if (capped) {
    const human = args.store.commands.getOrCreateHumanActor();
    const thread = args.store.commands.getOrCreateThread("task", task.id);
    args.store.commands.sendMessage({
      thread_id: thread.id,
      from_actor_id: args.decidedBy,
      to_actor_id: human,
      type: "escalation",
      body_md: `Task ${task.id} rejected ${rejected.rejection_count} time(s) (max ${policy.max_rejections}) — needs a human decision.\n\nLatest reason: ${args.reason}`,
      refs: [],
      visibility: "surfaced",
    });
    return { escalated: true };
  }

  // Under the cap: hand back to the assignee — `rejected -> in_progress` reuses the
  // `task_started` event (OPEN_ISSUES #7: "assignee resumes work") — and re-trigger
  // their workstream so the rejection reason reaches their next composed context.
  args.store.commands.transitionTaskState({ id: task.id, to: "in_progress", actorId: args.decidedBy });
  const ws = args.store.workstreams.list({ task_id: task.id as never })[0];
  if (ws && ws.state !== "closed" && ws.state !== "archived") {
    args.runtime.enqueue({ workstreamId: ws.id, trigger: "agent_message" });
  }
  return { escalated: false };
}

export interface CancelTaskCascadeArgs {
  store: Store;
  runtime: Runtime;
  taskId: string;
  cancelledBy: ActorId;
  reason?: string;
}

/**
 * E8.6: Cancel a task and its entire subtree. Transitions all non-terminal tasks to
 * `cancelled`, closes their workstreams, cancels in-flight runs, and notifies assignees.
 * Returns null on success or a PolicyError if the root task is not found.
 */
export async function cancelTaskCascade(args: CancelTaskCascadeArgs): Promise<PolicyError | null> {
  const root = args.store.tasks.get(args.taskId as never);
  if (!root) return { code: "assignee_not_found", message: `Task not found: ${args.taskId}` };

  // Walk the tree: root + all descendants. Since parent_task_id points downward (parent → child),
  // we walk by filtering parent_task_id = taskId, then recursively for each child.
  function collectDescendants(taskId: string): Task[] {
    const result: Task[] = [args.store.tasks.get(taskId as never)!];
    const children = args.store.tasks.list({ parent_task_id: taskId as never });
    for (const child of children) {
      result.push(...collectDescendants(child.id));
    }
    return result;
  }

  const taskTree = collectDescendants(args.taskId);
  const terminalTaskStates = new Set(terminalStates("task"));
  // Task and run are different state machines (task: pending/in_progress/blocked/
  // delivered/done/rejected/cancelled; run: queued/starting/running/awaiting_*/
  // completed/failed/cancelled/interrupted) — terminalStates("task") only overlaps
  // run's terminal set by coincidence on the literal "cancelled" value, so reusing it
  // for runs would try to cancel already-completed/failed runs. Resolve each set
  // from its own entity.
  const terminalRunStates = new Set(terminalStates("run"));

  for (const task of taskTree) {
    // Skip already-terminal tasks (done, cancelled).
    if (terminalTaskStates.has(task.state)) continue;

    // Transition to cancelled.
    args.store.commands.transitionTaskState({
      id: task.id,
      to: "cancelled",
      actorId: args.cancelledBy,
      reason: args.reason,
    });

    // Close the task's workstream and cancel in-flight runs.
    const workstreams = args.store.workstreams.list({ task_id: task.id as never });
    for (const ws of workstreams) {
      if (ws.state !== "closed" && ws.state !== "archived") {
        // Cancel any active run.
        const runs = args.store.runs.list({ workstream_id: ws.id });
        for (const run of runs) {
          if (!terminalRunStates.has(run.state)) {
            await args.runtime.cancelRun(run.id, args.reason);
          }
        }

        // Close the workstream.
        args.store.commands.transitionWorkstreamState({
          id: ws.id,
          to: "closed",
          actorId: args.cancelledBy,
          reason: args.reason,
        });

        // Release the workspace.
        args.runtime.releaseWorkspace(ws.id);
      }
    }

    // Notify the assignee.
    const assignee = args.store.agents.get(task.assignee_agent_id)!;
    const thread = args.store.commands.getOrCreateThread("task", task.id);
    args.store.commands.sendMessage({
      thread_id: thread.id,
      from_actor_id: args.cancelledBy,
      to_actor_id: assignee.actor_id,
      type: "status",
      body_md: `Task ${task.id} has been cancelled${args.reason ? ` — ${args.reason}` : ""}.`,
      refs: [],
      visibility: "normal",
    });
  }

  return null;
}
