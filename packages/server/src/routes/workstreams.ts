/**
 * E5.3 — workstream commands (contracts.md API contract):
 * POST /api/workstreams · POST /api/workstreams/:id/messages (→ enqueue run) ·
 * POST /api/workstreams/:id/close · POST /api/runs/:id/cancel
 */
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../server.js";
import { ProblemError } from "../problem.js";
import {
  CreateWorkstreamRequestSchema,
  PostWorkstreamMessageRequestSchema,
  CloseWorkstreamRequestSchema,
  CancelRunRequestSchema,
  type Budget,
  type AgentId,
  type WorkstreamId,
  type RunId,
} from "@foundry/core";
import { InvalidTransitionError } from "@foundry/store";

export function registerWorkstreamRoutes(app: FastifyInstance, ctx: RouteContext): void {
  // POST /api/workstreams — create a workstream
  app.post<{ Body: unknown }>("/api/workstreams", async (request, reply) => {
    const body = CreateWorkstreamRequestSchema.parse(request.body);

    // 404 if agent_id unknown
    const agent = ctx.store.agents.get(body.agent_id);
    if (!agent) {
      throw new ProblemError(
        404,
        "Agent not found",
        `Agent ${body.agent_id} does not exist`
      );
    }

    // Fill budget with defaults
    const budget: Budget = {
      limit_usd: body.budget?.limit_usd ?? null,
      limit_tokens: body.budget?.limit_tokens ?? null,
      spent_usd: body.budget?.spent_usd ?? 0,
      spent_tokens: body.budget?.spent_tokens ?? 0,
    };

    const workstream = ctx.store.commands.createWorkstream({
      agent_id: body.agent_id,
      title: body.title,
      goal_md: body.goal_md,
      origin: "human",
      workspace_ref: body.workspace_ref ?? undefined,
      budget,
    });

    return reply.status(201).send(workstream);
  });

  // POST /api/workstreams/:id/messages — send a human message and enqueue a run
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/workstreams/:id/messages",
    async (request, reply) => {
      const workstreamId = request.params.id as WorkstreamId;
      const body = PostWorkstreamMessageRequestSchema.parse(request.body);

      // 404 if workstream unknown
      const workstream = ctx.store.workstreams.get(workstreamId);
      if (!workstream) {
        throw new ProblemError(
          404,
          "Workstream not found",
          `Workstream ${workstreamId} does not exist`
        );
      }

      const human = ctx.store.commands.getOrCreateHumanActor();
      const thread = ctx.store.commands.getOrCreateThread(
        "workstream",
        workstreamId
      );

      // Get agent to access its actor_id
      const agent = ctx.store.agents.get(workstream.agent_id);
      if (!agent) {
        throw new ProblemError(
          404,
          "Agent not found",
          `Agent ${workstream.agent_id} does not exist`
        );
      }

      // Determine message type from kind
      const messageType = body.kind === "redirect" ? "redirect" : "status";

      const message = ctx.store.commands.sendMessage({
        thread_id: thread.id,
        from_actor_id: human,
        to_actor_id: agent.actor_id,
        type: messageType,
        body_md: body.body_md,
      });

      // Enqueue a run
      let run;
      try {
        run = ctx.runtime.enqueue({
          workstreamId,
          trigger: "human_message",
          triggerMessageMd: body.body_md,
        });
      } catch (err) {
        // Wrap runtime errors (e.g., suspended agent) into 409
        throw new ProblemError(
          409,
          "Cannot enqueue run",
          (err instanceof Error ? err.message : String(err)) ||
            "An error occurred while enqueueing the run"
        );
      }

      return reply.status(202).send({ message_id: message.id, run_id: run.id });
    }
  );

  // POST /api/workstreams/:id/close — close a workstream
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/workstreams/:id/close",
    async (request, reply) => {
      const workstreamId = request.params.id as WorkstreamId;
      const body = CloseWorkstreamRequestSchema.parse(request.body);

      // 404 if workstream unknown
      const workstream = ctx.store.workstreams.get(workstreamId);
      if (!workstream) {
        throw new ProblemError(
          404,
          "Workstream not found",
          `Workstream ${workstreamId} does not exist`
        );
      }

      const human = ctx.store.commands.getOrCreateHumanActor();

      // E11.3: distillation pass — one final run whose trigger tells the agent to distil
      // durable lessons into memory (capture at the moment of maximum context, doc-05);
      // the workstream closes when that run settles (ctx.onRunSettled hook).
      if (body.distill && ctx.store.runs.list({ workstream_id: workstreamId }).length > 0) {
        const agent = ctx.store.agents.get(workstream.agent_id);
        if (agent) {
          const thread = ctx.store.commands.getOrCreateThread("workstream", workstreamId);
          ctx.store.commands.sendMessage({
            thread_id: thread.id,
            from_actor_id: human,
            to_actor_id: agent.actor_id,
            type: "redirect",
            body_md:
              "Close-out: this workstream is being closed. Distil durable lessons from it into your memory (facts, decisions) and skills (procedures that worked) now — update INDEX.md — then finish.",
          });
          try {
            const run = ctx.runtime.enqueue({ workstreamId, trigger: "human_message" });
            ctx.onRunSettled(run.id, () => {
              try {
                ctx.store.commands.transitionWorkstreamState({ id: workstreamId, to: "closed", actorId: human, reason: body.reason });
                ctx.runtime.releaseWorkspace(workstreamId);
              } catch {
                // already closed or not closable — the human can close explicitly
              }
            });
            return reply.status(202).send({ closing: true, distillation_run_id: run.id });
          } catch (err) {
            throw new ProblemError(409, "Cannot schedule distillation run", err instanceof Error ? err.message : String(err));
          }
        }
      }

      try {
        ctx.store.commands.transitionWorkstreamState({
          id: workstreamId,
          to: "closed",
          actorId: human,
          reason: body.reason,
        });
      } catch (err) {
        if (err instanceof InvalidTransitionError) {
          throw new ProblemError(
            409,
            "Invalid transition",
            err.message,
            "invalid_transition"
          );
        }
        throw err;
      }

      // Release workspace (doc-05 retention)
      ctx.runtime.releaseWorkspace(workstreamId);

      const updated = ctx.store.workstreams.get(workstreamId);
      return reply.status(200).send(updated);
    }
  );

  // POST /api/runs/:id/cancel — cancel a run
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/runs/:id/cancel",
    async (request, reply) => {
      const runId = request.params.id as RunId;
      const body = CancelRunRequestSchema.parse(request.body);

      try {
        await ctx.runtime.cancelRun(runId, body.reason);
      } catch (err) {
        // "run not found" → 404
        if (err instanceof Error && err.message.includes("not found")) {
          throw new ProblemError(
            404,
            "Run not found",
            `Run ${runId} does not exist`
          );
        }
        throw err;
      }

      return reply.status(202).send({ ok: true });
    }
  );
}
