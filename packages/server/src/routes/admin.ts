/**
 * E5.7 — admin endpoints (not game-facing). POST /api/backup for the CLI.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RouteContext } from "../server.js";

export function registerAdminRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const BackupRequestSchema = z.object({
    dest: z.string().min(1),
  });

  app.post("/api/backup", async (request, reply) => {
    const body = BackupRequestSchema.parse(request.body);
    const result = await ctx.store.backup(body.dest);
    return reply.send(result);
  });
}
