/**
 * E5.4 — query endpoints, mirroring store projections 1:1 (contracts.md):
 * /api/org · /api/inbox · /api/agents/:id · /api/workstreams/:id/timeline ·
 * /api/tasks/:id/tree · /api/cost?scope=…
 */
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../server.js";
import { ProblemError } from "../problem.js";
import type { AgentId, TeamId, WorkstreamId, TaskId } from "@foundry/core";
import type { CostScope } from "@foundry/store";

export function registerQueryRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get("/api/org", async () => {
    return ctx.store.projections.orgView();
  });

  app.get("/api/inbox", async () => {
    return ctx.store.projections.inbox();
  });

  app.get<{ Params: { id: string } }>("/api/agents/:id", async (request) => {
    const page = ctx.store.projections.agentPage(request.params.id as AgentId);
    if (!page) {
      throw new ProblemError(404, "Not Found", `Agent ${request.params.id} not found`);
    }
    return page;
  });

  app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>(
    "/api/workstreams/:id/timeline",
    async (request) => {
      const ws = ctx.store.workstreams.get(request.params.id as WorkstreamId);
      if (!ws) {
        throw new ProblemError(404, "Not Found", `Workstream ${request.params.id} not found`);
      }
      const limit = request.query.limit ? parseInt(String(request.query.limit), 10) : undefined;
      const before = request.query.before ? parseInt(String(request.query.before), 10) : undefined;
      const page = { limit, before };
      return ctx.store.projections.workstreamTimeline(request.params.id as WorkstreamId, page);
    }
  );

  app.get<{ Params: { id: string } }>("/api/tasks/:id/tree", async (request) => {
    const task = ctx.store.tasks.get(request.params.id as TaskId);
    if (!task) {
      throw new ProblemError(404, "Not Found", `Task ${request.params.id} not found`);
    }
    return ctx.store.projections.delegationTree(request.params.id as TaskId);
  });

  app.get<{ Querystring: Record<string, unknown> }>("/api/cost", async (request) => {
    const scopeStr = String(request.query.scope ?? "org");
    const scope = parseCostScope(scopeStr);
    if (!scope) {
      throw new ProblemError(400, "Bad Request", `Invalid scope: ${scopeStr}`);
    }
    return ctx.store.projections.costRollup(scope);
  });
}

function parseCostScope(str: string): CostScope | null {
  if (str === "org") {
    return { level: "org" };
  }
  if (str.startsWith("agent:")) {
    const id = str.slice(6);
    if (!id) return null;
    return { level: "agent", agent_id: id as AgentId };
  }
  if (str.startsWith("team:")) {
    const id = str.slice(5);
    if (!id) return null;
    return { level: "team", team_id: id as TeamId };
  }
  if (str.startsWith("workstream:")) {
    const id = str.slice(11);
    if (!id) return null;
    return { level: "workstream", workstream_id: id as WorkstreamId };
  }
  return null;
}
