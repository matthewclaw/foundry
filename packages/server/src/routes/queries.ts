/**
 * E5.4 — query endpoints, mirroring store projections 1:1 (contracts.md):
 * /api/org · /api/inbox · /api/agents/:id · /api/workstreams/:id/timeline ·
 * /api/tasks/:id/tree · /api/cost?scope=…
 */
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../server.js";
import { ProblemError } from "../problem.js";

export function registerQueryRoutes(app: FastifyInstance, ctx: RouteContext): void {
  // E5.4 (stub): swarm story fills this file.
  void ctx;
  app.get("/api/org", async () => {
    throw new ProblemError(501, "Not implemented", "E5.4 pending");
  });
}
