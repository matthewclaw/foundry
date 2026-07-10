/**
 * E6.1/E6.2 — the agent-facing org-tools surface over HTTP (contracts.md
 * "Org-tools contract"): POST /api/org-tools/:tool, authenticated by the per-run
 * bearer token minted at run start and dead at run end (tokens.ts). Every response is
 * a core `ToolResult`: `{ok:true,data}` or `{ok:false,error:{code,…}}` with the policy
 * codes relayed verbatim into the run (ADR-004) — an agent reads the code and reacts;
 * only transport/auth failures are HTTP errors.
 *
 * E6.1 lands auth + attribution + the policy-free read tools; E6.2 fills the rest of
 * the toolset (each handler slots into TOOL_HANDLERS below).
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ORG_TOOL_INPUT_SCHEMAS, type OrgToolName, type ToolResult } from "@foundry/core";
import type { RouteContext } from "../server.js";
import { ProblemError } from "../problem.js";
import type { RunCredential } from "../orgtools/tokens.js";

type ToolHandler = (ctx: RouteContext, cred: RunCredential, input: unknown) => ToolResult<unknown> | Promise<ToolResult<unknown>>;

const TOOL_HANDLERS: Partial<Record<OrgToolName, ToolHandler>> = {
  list_org: (ctx) => ({
    ok: true,
    data: {
      teams: ctx.store.teams.list().map((t) => ({ id: t.id, name: t.name })),
      agents: ctx.store.agents
        .list()
        .map((a) => ({ id: a.id, name: a.name, role: a.role, team_id: a.team_id, state: a.state })),
    },
  }),

  get_task: (ctx, _cred, input) => {
    const { task_id } = input as { task_id: string };
    const task = ctx.store.tasks.get(task_id as never);
    if (!task) {
      return { ok: false, error: { code: "assignee_not_found", message: `task not found: ${task_id}` } };
    }
    return { ok: true, data: task };
  },

  get_thread: (ctx, _cred, input) => {
    const { thread_id } = input as { thread_id: string };
    const thread = ctx.store.messages.getThread(thread_id as never);
    if (!thread) {
      return { ok: false, error: { code: "policy_violation", message: `thread not found: ${thread_id}` } };
    }
    return { ok: true, data: { thread, messages: ctx.store.messages.listByThread(thread.id) } };
  },

  // E6.2 fills: delegate_task, update_task, deliver_task, send_message, escalate,
  // request_approval, search_history.
};

export function registerOrgToolRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.post<{ Params: { tool: string }; Body: unknown }>("/api/org-tools/:tool", async (request, reply) => {
    const cred = authenticate(ctx, request);

    const toolName = request.params.tool as OrgToolName;
    const inputSchema = ORG_TOOL_INPUT_SCHEMAS[toolName];
    if (!inputSchema) {
      throw new ProblemError(404, "Unknown org-tool", `no such tool: ${request.params.tool}`);
    }
    const handler = TOOL_HANDLERS[toolName];
    if (!handler) {
      throw new ProblemError(501, "Not implemented", `org-tool "${toolName}" lands with E6.2`);
    }

    const parsed = inputSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      // Invalid input is a tool-level error the agent should see and react to, not a
      // transport failure — same channel as policy rejections.
      const result: ToolResult<never> = {
        ok: false,
        error: { code: "policy_violation", message: `invalid ${toolName} input`, details: parsed.error.issues },
      };
      return reply.status(200).send(result);
    }

    const result = await handler(ctx, cred, parsed.data);
    return reply.status(200).send(result);
  });
}

function authenticate(ctx: RouteContext, request: FastifyRequest): RunCredential {
  const header = request.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const cred = token ? ctx.tokens.resolve(token) : undefined;
  if (!cred) {
    // Expired (run ended), foreign, or absent — all the same 401 (E6.1 AC).
    throw new ProblemError(401, "Unauthorized", "missing, expired, or unknown org-tools token");
  }
  return cred;
}
