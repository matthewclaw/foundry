/**
 * E8.1 — shared accept/reject decision logic for a delivered task, used by both the
 * `accept_task`/`reject_task` org-tools (an agent delegator deciding on its own
 * subordinate's work, doc-04: "agents review their own subordinates") and the
 * human-facing `POST /api/tasks/:id/{accept,reject}` route (root tasks, doc-04:
 * "roots delegated by the human are accepted by the human"). One place for the
 * F12 rejection-cap check and the escalation/re-trigger side effects so the two
 * callers can't drift.
 */
import type { ActorId, PolicyError, Task } from "@foundry/core";
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
