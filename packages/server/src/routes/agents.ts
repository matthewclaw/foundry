/**
 * E5.2 — agent CRUD + lifecycle commands (contracts.md API contract):
 * POST /api/agents · PATCH /api/agents/:id · POST /api/agents/:id/{suspend,resume,retire}
 */
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../server.js";
import { ProblemError } from "../problem.js";
import {
  CreateAgentRequestSchema,
  PatchAgentRequestSchema,
  AgentLifecycleRequestSchema,
  type AgentId,
} from "@foundry/core";
import { InvalidTransitionError } from "@foundry/store";
import { terminalStates } from "@foundry/core";

export function registerAgentRoutes(app: FastifyInstance, ctx: RouteContext): void {
  // POST /api/agents — create an agent in active state
  app.post<{ Body: unknown }>("/api/agents", async (request, reply) => {
    const body = CreateAgentRequestSchema.parse(request.body);

    const { agentId, actorId } = ctx.store.commands.createAgent({
      name: body.name,
      role: body.role,
      team_id: body.team_id ?? null,
      engine_id: body.engine.id,
      engine_config: body.engine.config,
      charter_body_md: body.charter_md,
      memory_ref: "agents/{agent_id}/memory",
      policy_overrides: body.policy_overrides,
      default_workspace_ref: body.default_workspace_ref ?? null,
    });

    // API-created agents are immediately usable (doc-02)
    const human = ctx.store.commands.getOrCreateHumanActor();
    ctx.store.commands.transitionAgentState({
      id: agentId,
      to: "active",
      actorId: human,
    });

    const agent = ctx.store.agents.get(agentId);
    return reply.status(201).send(agent);
  });

  // PATCH /api/agents/:id — update charter and/or engine only (OPEN_ISSUES #31)
  app.patch<{ Params: { id: string }; Body: unknown }>(
    "/api/agents/:id",
    async (request, reply) => {
      const agentId = request.params.id as AgentId;
      const body = PatchAgentRequestSchema.parse(request.body);

      const agent = ctx.store.agents.get(agentId);
      if (!agent) {
        throw new ProblemError(
          404,
          "Agent not found",
          `Agent ${agentId} does not exist`
        );
      }

      // OPEN_ISSUES #31: reject if body contains name, role, team_id, or policy_overrides
      if (
        body.name !== undefined ||
        body.role !== undefined ||
        body.team_id !== undefined ||
        body.policy_overrides !== undefined
      ) {
        throw new ProblemError(
          422,
          "Unprocessable Entity",
          "PATCH /api/agents/:id accepts charter_md and engine only. See OPEN_ISSUES #31.",
          "policy_violation"
        );
      }

      const human = ctx.store.commands.getOrCreateHumanActor();

      // Update charter if provided
      if (body.charter_md !== undefined) {
        ctx.store.commands.updateAgentCharter({
          agentId,
          bodyMd: body.charter_md,
          editedByActor: human,
        });
      }

      // Rebind engine if provided
      if (body.engine !== undefined) {
        ctx.store.commands.rebindAgentEngine({
          agentId,
          engine: body.engine,
          actorId: human,
        });
      }

      // Set/clear the default working directory if provided
      if (body.default_workspace_ref !== undefined) {
        ctx.store.commands.setAgentDefaultWorkspace({
          agentId,
          workspaceRef: body.default_workspace_ref,
          actorId: human,
        });
      }

      const updated = ctx.store.agents.get(agentId);
      return reply.status(200).send(updated);
    }
  );

  // POST /api/agents/:id/suspend — suspend an agent
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/agents/:id/suspend",
    async (request, reply) => {
      const agentId = request.params.id as AgentId;
      const body = AgentLifecycleRequestSchema.parse(request.body);

      const agent = ctx.store.agents.get(agentId);
      if (!agent) {
        throw new ProblemError(
          404,
          "Agent not found",
          `Agent ${agentId} does not exist`
        );
      }

      const human = ctx.store.commands.getOrCreateHumanActor();

      try {
        ctx.store.commands.transitionAgentState({
          id: agentId,
          to: "suspended",
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

      const updated = ctx.store.agents.get(agentId);
      return reply.status(200).send(updated);
    }
  );

  // POST /api/agents/:id/resume — resume a suspended agent
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/agents/:id/resume",
    async (request, reply) => {
      const agentId = request.params.id as AgentId;
      const body = AgentLifecycleRequestSchema.parse(request.body);

      const agent = ctx.store.agents.get(agentId);
      if (!agent) {
        throw new ProblemError(
          404,
          "Agent not found",
          `Agent ${agentId} does not exist`
        );
      }

      const human = ctx.store.commands.getOrCreateHumanActor();

      try {
        ctx.store.commands.transitionAgentState({
          id: agentId,
          to: "active",
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

      const updated = ctx.store.agents.get(agentId);
      return reply.status(200).send(updated);
    }
  );

  // POST /api/agents/:id/retire — retire an agent (check for open tasks)
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/agents/:id/retire",
    async (request, reply) => {
      const agentId = request.params.id as AgentId;
      const body = AgentLifecycleRequestSchema.parse(request.body);

      const agent = ctx.store.agents.get(agentId);
      if (!agent) {
        throw new ProblemError(
          404,
          "Agent not found",
          `Agent ${agentId} does not exist`
        );
      }

      // RETIRE RULE (doc-02): check for open tasks assigned to this agent
      const openTaskStates = ctx.store.tasks
        .list({ assignee_agent_id: agentId })
        .filter((task) => !terminalStates("task").includes(task.state));

      if (openTaskStates.length > 0) {
        throw new ProblemError(
          409,
          "Agent has open tasks",
          `Cannot retire agent: ${openTaskStates.length} open task(s) assigned to this agent`,
          "policy_violation"
        );
      }

      const human = ctx.store.commands.getOrCreateHumanActor();

      try {
        ctx.store.commands.transitionAgentState({
          id: agentId,
          to: "retired",
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

      const updated = ctx.store.agents.get(agentId);
      return reply.status(200).send(updated);
    }
  );

  // DELETE /api/agents/:id — hard delete (housekeeping), the counterpart to retire's
  // soft delete. Cancels any live runs, then purges the agent and everything it owns:
  // its workstreams (with their runs/events/artifacts/messages), charters, schedules,
  // tasks assigned to it, and its actor. Tasks it delegated to other agents survive.
  // Irreversible — use retire to keep the audited history.
  app.delete<{ Params: { id: string } }>("/api/agents/:id", async (request, reply) => {
    const agentId = request.params.id as AgentId;
    if (!ctx.store.agents.get(agentId)) {
      throw new ProblemError(404, "Agent not found", `Agent ${agentId} does not exist`);
    }

    for (const ws of ctx.store.workstreams.list({ agent_id: agentId })) {
      for (const run of ctx.store.runs.list({ workstream_id: ws.id })) {
        if (!terminalStates("run").includes(run.state)) {
          await ctx.runtime.cancelRun(run.id, "agent deleted").catch(() => {});
        }
      }
      ctx.runtime.releaseWorkspace(ws.id);
    }
    ctx.store.commands.deleteAgent(agentId);
    return reply.status(204).send();
  });
}
