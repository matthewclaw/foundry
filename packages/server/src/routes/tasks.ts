/**
 * E8.1 — human-facing task decisions: `POST /api/tasks/:id/{accept,reject}` (contracts.md
 * API contract). A root task's delegator is the human (doc-04: "roots delegated by the
 * human are accepted by the human") — this is their decision surface, parallel to the
 * `accept_task`/`reject_task` org-tools an agent delegator uses for its own subordinates.
 * Both call the same `tasks/decide.ts` logic so the two paths can't drift.
 *
 * E8.6 — task cancellation: `POST /api/tasks/:id/cancel` closes a task and its subtree.
 */
import type { FastifyInstance } from "fastify";
import { AcceptTaskRequestSchema, RejectTaskRequestSchema, CancelTaskRequestSchema } from "@foundry/core";
import type { RouteContext } from "../server.js";
import { ProblemError } from "../problem.js";
import { acceptTask, rejectTask, cancelTaskCascade } from "../tasks/decide.js";

export function registerTaskRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.post<{ Params: { id: string }; Body: unknown }>("/api/tasks/:id/accept", async (request, reply) => {
    AcceptTaskRequestSchema.parse(request.body ?? {});
    const human = ctx.store.commands.getOrCreateHumanActor();
    const err = acceptTask({ store: ctx.store, runtime: ctx.runtime, taskId: request.params.id, decidedBy: human });
    if (err) throw new ProblemError(409, "Cannot accept task", err.message, err.code);
    return reply.status(200).send({ task: ctx.store.tasks.get(request.params.id as never) });
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/tasks/:id/reject", async (request, reply) => {
    const body = RejectTaskRequestSchema.parse(request.body ?? {});
    const human = ctx.store.commands.getOrCreateHumanActor();
    const result = rejectTask({
      store: ctx.store,
      runtime: ctx.runtime,
      taskId: request.params.id,
      decidedBy: human,
      reason: body.reason,
    });
    if ("code" in result) throw new ProblemError(409, "Cannot reject task", result.message, result.code);
    return reply.status(200).send({ task: ctx.store.tasks.get(request.params.id as never), escalated: result.escalated });
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/tasks/:id/cancel", async (request, reply) => {
    const body = CancelTaskRequestSchema.parse(request.body ?? {});
    const human = ctx.store.commands.getOrCreateHumanActor();
    const err = await cancelTaskCascade({
      store: ctx.store,
      runtime: ctx.runtime,
      taskId: request.params.id,
      cancelledBy: human,
      reason: body.reason,
    });
    if (err) throw new ProblemError(409, "Cannot cancel task", err.message, err.code);
    return reply.status(200).send({ ok: true });
  });
}
