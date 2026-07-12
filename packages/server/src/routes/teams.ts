/**
 * Team CRUD (contracts.md API contract): `POST /api/teams`. Teams carry no state
 * machine (02: "labels with defaults, not containers with behaviour") — create is the
 * only lifecycle action they have.
 */
import type { FastifyInstance } from "fastify";
import { CreateTeamRequestSchema } from "@foundry/core";
import type { RouteContext } from "../server.js";

export function registerTeamRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.post<{ Body: unknown }>("/api/teams", async (request, reply) => {
    const body = CreateTeamRequestSchema.parse(request.body);
    const team = ctx.store.commands.createTeam({
      name: body.name,
      description: body.description,
      default_policy: body.default_policy ?? {},
    });
    return reply.status(201).send(team);
  });
}
