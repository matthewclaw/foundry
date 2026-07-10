/**
 * E5.5 — SSE event feed with `after` replay (contracts.md):
 * GET /api/events?after=<seq> — every event has a monotonic seq; reconnect replays;
 * zero gap, zero dupe (F13).
 */
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../server.js";
import { ProblemError } from "../problem.js";

export function registerFeedRoutes(app: FastifyInstance, ctx: RouteContext): void {
  // E5.5 (stub): swarm story fills this file.
  void ctx;
  app.get("/api/events", async () => {
    throw new ProblemError(501, "Not implemented", "E5.5 pending");
  });
}
