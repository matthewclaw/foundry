/**
 * E5.3 — workstream commands (contracts.md API contract):
 * POST /api/workstreams · POST /api/workstreams/:id/messages (→ enqueue run) ·
 * POST /api/workstreams/:id/close · POST /api/runs/:id/cancel
 */
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../server.js";
import { ProblemError } from "../problem.js";

export function registerWorkstreamRoutes(app: FastifyInstance, ctx: RouteContext): void {
  // E5.3 (stub): swarm story fills this file.
  void ctx;
  app.post("/api/workstreams", async () => {
    throw new ProblemError(501, "Not implemented", "E5.3 pending");
  });
}
