/**
 * Read-only browsing of Claude Code's own on-disk session transcripts (grouped by the
 * repo folder they belong to) — GET /api/claude-sessions · GET
 * /api/claude-sessions/:projectDir/:sessionId · POST .../reveal (opens the file's
 * folder in the OS file browser). Entirely outside Foundry's store: this mirrors
 * whatever `~/.claude/projects/` holds, whether Foundry started the session or a human
 * ran `claude` directly in a terminal.
 */
import type { FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import type { RouteContext } from "../server.js";
import { ProblemError } from "../problem.js";
import {
  listSessionGroups,
  readSessionDetail,
  resolveSessionPath,
  revealInFileExplorer,
} from "../claudeSessions/discover.js";

/** Shared 400/404 validation for both routes keyed by :projectDir/:sessionId. */
function resolveOrThrow(root: string, projectDir: string, sessionId: string): string {
  const filePath = resolveSessionPath(root, projectDir, sessionId);
  if (!filePath) {
    throw new ProblemError(400, "Bad Request", `Invalid session reference: ${projectDir}/${sessionId}`);
  }
  if (!existsSync(filePath)) {
    throw new ProblemError(404, "Not Found", `Session ${sessionId} not found in ${projectDir}`);
  }
  return filePath;
}

export function registerClaudeSessionRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get("/api/claude-sessions", async () => {
    return { groups: listSessionGroups(ctx.claudeSessionsRoot) };
  });

  app.get<{ Params: { projectDir: string; sessionId: string } }>(
    "/api/claude-sessions/:projectDir/:sessionId",
    async (request) => {
      const { projectDir, sessionId } = request.params;
      const filePath = resolveOrThrow(ctx.claudeSessionsRoot, projectDir, sessionId);
      return readSessionDetail(filePath, sessionId, projectDir);
    }
  );

  app.post<{ Params: { projectDir: string; sessionId: string } }>(
    "/api/claude-sessions/:projectDir/:sessionId/reveal",
    async (request) => {
      const { projectDir, sessionId } = request.params;
      const filePath = resolveOrThrow(ctx.claudeSessionsRoot, projectDir, sessionId);
      revealInFileExplorer(filePath);
      return { ok: true };
    }
  );
}
