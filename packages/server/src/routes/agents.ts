/**
 * E5.2 — agent CRUD + lifecycle commands (contracts.md API contract):
 * POST /api/agents · PATCH /api/agents/:id · POST /api/agents/:id/{suspend,resume,retire}
 */
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../server.js";
import { ProblemError } from "../problem.js";

export function registerAgentRoutes(app: FastifyInstance, ctx: RouteContext): void {
  // E5.2 (stub): swarm story fills this file; see contracts.md + doc-02 lifecycle rules.
  void ctx;
  void ProblemError;
  app.post("/api/agents", async () => {
    throw new ProblemError(501, "Not implemented", "E5.2 pending");
  });
}
