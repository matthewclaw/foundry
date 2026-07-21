/**
 * A workstream's on-disk workspace: where its runs execute, what the agent changed, and
 * the handoff into your own tools. Foundry (an ADE) surfaces and promotes; it doesn't
 * render diffs or merge — that's the IDE's job.
 *   GET  /api/workstreams/:id/workspace          → path, kind, changed files
 *   POST /api/workstreams/:id/workspace/open     → open the dir in VS Code
 *   POST /api/workstreams/:id/workspace/reveal   → reveal in the OS file explorer
 *   POST /api/workstreams/:id/workspace/promote  → commit the changes onto a branch
 */
import type { FastifyInstance } from "fastify";
import type { WorkstreamId } from "@foundry/core";
import type { RouteContext } from "../server.js";
import { ProblemError } from "../problem.js";
import { revealInFileExplorer } from "../claudeSessions/discover.js";
import { resolveWorkspaceDir, inspectWorkspace, openInEditor, promoteToBranch, branchNameFor } from "../workspace/inspect.js";

export function registerWorkspaceRoutes(app: FastifyInstance, ctx: RouteContext): void {
  /** Resolve the workstream + its agent, or 404. */
  function resolve(id: string) {
    const workstream = ctx.store.workstreams.get(id as WorkstreamId);
    if (!workstream) throw new ProblemError(404, "Workstream not found", `Workstream ${id} does not exist`);
    const agent = ctx.store.agents.get(workstream.agent_id);
    if (!agent) throw new ProblemError(404, "Agent not found", `Agent ${workstream.agent_id} does not exist`);
    const { path, kind } = resolveWorkspaceDir(ctx.dataDir, workstream, agent);
    return { workstream, path, kind };
  }

  app.get<{ Params: { id: string } }>("/api/workstreams/:id/workspace", async (request) => {
    const { path, kind } = resolve(request.params.id);
    return inspectWorkspace(path, kind);
  });

  app.post<{ Params: { id: string } }>("/api/workstreams/:id/workspace/open", async (request, reply) => {
    const { path } = resolve(request.params.id);
    if (!openInEditor(path)) {
      throw new ProblemError(
        409,
        "Could not open editor",
        "Failed to launch `code` — is the VS Code CLI on the daemon's PATH? Use Reveal instead."
      );
    }
    return reply.status(202).send({ ok: true, path });
  });

  app.post<{ Params: { id: string } }>("/api/workstreams/:id/workspace/reveal", async (request, reply) => {
    const { path } = resolve(request.params.id);
    revealInFileExplorer(path);
    return reply.status(202).send({ ok: true, path });
  });

  app.post<{ Params: { id: string } }>("/api/workstreams/:id/workspace/promote", async (request, reply) => {
    const { workstream, path } = resolve(request.params.id);
    const branch = branchNameFor(workstream);
    const result = promoteToBranch(path, branch, `Foundry: ${workstream.title}`);
    if (!result.ok) throw new ProblemError(409, "Cannot promote workspace", result.message ?? "promotion failed");
    return reply.status(200).send(result);
  });
}
