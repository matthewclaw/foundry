/**
 * Team CRUD (contracts.md API contract): `POST /api/teams` · `PATCH /api/teams/:id` ·
 * `DELETE /api/teams/:id`. Teams carry no state machine (02: "labels with defaults, not
 * containers with behaviour") — rename/delete need no lifecycle transition, and (per
 * OPEN_ISSUES.md #17) no catalogue event, same as create.
 */
import type { FastifyInstance } from "fastify";
import { CreateTeamRequestSchema, PatchTeamRequestSchema, type TeamId } from "@foundry/core";
import { ProblemError } from "../problem.js";
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

  app.patch<{ Params: { id: string }; Body: unknown }>("/api/teams/:id", async (request, reply) => {
    const teamId = request.params.id as TeamId;
    const body = PatchTeamRequestSchema.parse(request.body);

    if (!ctx.store.teams.get(teamId)) {
      throw new ProblemError(404, "Team not found", `Team ${teamId} does not exist`);
    }

    const team = ctx.store.commands.updateTeam({ id: teamId, name: body.name, description: body.description });
    return reply.status(200).send(team);
  });

  app.delete<{ Params: { id: string } }>("/api/teams/:id", async (request, reply) => {
    const teamId = request.params.id as TeamId;

    if (!ctx.store.teams.get(teamId)) {
      throw new ProblemError(404, "Team not found", `Team ${teamId} does not exist`);
    }

    ctx.store.commands.deleteTeam(teamId);
    return reply.status(204).send();
  });
}
