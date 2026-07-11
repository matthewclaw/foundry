/**
 * E6.1/E6.2 — the agent-facing org-tools surface over HTTP (contracts.ms
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
import {
  canTransition,
  ORG_TOOL_INPUT_SCHEMAS,
  type DelegateTaskInput,
  type DeliverTaskInput,
  type EscalateInput,
  type OrgToolName,
  type RequestApprovalInput,
  type SearchHistoryInput,
  type SearchHistoryScope,
  type SendMessageInput,
  type Task,
  type ToolResult,
  type UpdateTaskInput,
} from "@foundry/core";
import type { RouteContext } from "../server.js";
import { ProblemError } from "../problem.js";
import type { RunCredential } from "../orgtools/tokens.js";
import { checkDelegation, resolvePolicy, resolveRouting } from "../policy/policy.js";

export type ToolHandler = (ctx: RouteContext, cred: RunCredential, input: unknown) => ToolResult<unknown> | Promise<ToolResult<unknown>>;

/**
 * The task the calling run is executing, if any: run → workstream → task. Sub-delegations
 * hang off it (depth + budget conservation); absent for test-minted creds or task-less runs.
 */
function callerParentTask(ctx: RouteContext, cred: RunCredential): Task | null {
  const run = ctx.store.runs.get(cred.runId);
  const ws = run ? ctx.store.workstreams.get(run.workstream_id) : undefined;
  return ws?.task_id ? (ctx.store.tasks.get(ws.task_id) ?? null) : null;
}

/**
 * Thread anchor for messages sent outside an existing thread: the caller's own
 * workstream when the run is known (the conversation happens where the work is),
 * else keyed on the caller's agent id. Both are "workstream"-kind anchors — the only
 * ThreadAnchorType besides "task", which is reserved for task-progress threads.
 */
function callerThread(ctx: RouteContext, cred: RunCredential) {
  const run = ctx.store.runs.get(cred.runId);
  return ctx.store.commands.getOrCreateThread("workstream", run ? run.workstream_id : (cred.agentId as string));
}

export const TOOL_HANDLERS: Partial<Record<OrgToolName, ToolHandler>> = {
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

  delegate_task: (ctx, cred, input) => {
    const { spec_md, acceptance_criteria_md, budget, assignee_agent_id, routing, refs } = input as any;

    // Check policy: AC, depth, budget, assignee, routing
    const policyErr = checkDelegation({
      store: ctx.store,
      delegator: cred.actorId,
      input: { acceptance_criteria_md, budget, assignee_agent_id, routing },
      parentTask: null,
    });
    if (policyErr) {
      return { ok: false, error: policyErr };
    }

    // Resolve assignee for createTask
    let resolvedAssigneeId: any;
    if (assignee_agent_id) {
      resolvedAssigneeId = assignee_agent_id;
    } else if (routing) {
      const routeResult = resolveRouting(ctx.store, routing);
      if ("code" in routeResult) {
        return { ok: false, error: routeResult };
      }
      resolvedAssigneeId = routeResult;
    }

    // Create the task
    try {
      const task = ctx.store.commands.createTask({
        parent_task_id: null,
        delegator_actor_id: cred.actorId,
        assignee_agent_id: resolvedAssigneeId,
        routing_spec: routing || null,
        spec_md,
        acceptance_criteria_md,
        budget: budget || { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 },
      });
      return { ok: true, data: { task_id: task.id } };
    } catch (e) {
      return { ok: false, error: { code: "policy_violation", message: String(e) } };
    }
  },

  update_task: (ctx, cred, input) => {
    const { task_id, note_md, blocked } = input as any;
    const task = ctx.store.tasks.get(task_id as never);
    if (!task) {
      return { ok: false, error: { code: "assignee_not_found", message: `Task not found: ${task_id}` } };
    }

    try {
      // Send a "status" message on the task thread if note provided
      if (note_md) {
        const thread = ctx.store.commands.getOrCreateThread("task", task_id as string);
        ctx.store.commands.sendMessage({
          thread_id: thread.id,
          from_actor_id: cred.actorId,
          to_actor_id: task.delegator_actor_id,
          type: "status",
          body_md: note_md,
          refs: [],
          visibility: "normal",
        });
      }

      // Transition to blocked if requested
      if (blocked) {
        if (canTransition("task", task.state, "blocked")) {
          ctx.store.commands.transitionTaskState({
            id: task_id as string,
            to: "blocked",
            actorId: cred.actorId,
            reason: blocked.reason,
          });
        } else {
          return {
            ok: false,
            error: { code: "invalid_transition", message: `Cannot transition from ${task.state} to blocked` },
          };
        }
      }

      return { ok: true, data: { ok: true } };
    } catch (e) {
      return { ok: false, error: { code: "policy_violation", message: String(e) } };
    }
  },

  deliver_task: (ctx, cred, input) => {
    const { task_id, summary_md, artifact_refs } = input as any;
    const task = ctx.store.tasks.get(task_id as never);
    if (!task) {
      return { ok: false, error: { code: "assignee_not_found", message: `Task not found: ${task_id}` } };
    }

    try {
      // Send completion message on the task thread
      const thread = ctx.store.commands.getOrCreateThread("task", task_id as string);
      const msg = ctx.store.commands.sendMessage({
        thread_id: thread.id,
        from_actor_id: cred.actorId,
        to_actor_id: task.delegator_actor_id,
        type: "completion",
        body_md: summary_md,
        refs: artifact_refs || [],
        visibility: "normal",
      });

      // Transition task to delivered with the completion message ref
      if (canTransition("task", task.state, "delivered")) {
        ctx.store.commands.transitionTaskState({
          id: task_id as string,
          to: "delivered",
          actorId: cred.actorId,
          deliverableRef: { message_id: msg.id, artifact_refs: artifact_refs || [] },
        });
      } else {
        return {
          ok: false,
          error: { code: "invalid_transition", message: `Cannot transition from ${task.state} to delivered` },
        };
      }

      return { ok: true, data: { ok: true } };
    } catch (e) {
      return { ok: false, error: { code: "policy_violation", message: String(e) } };
    }
  },

  send_message: (ctx, cred, input) => {
    const { type, to_actor_id, to_team_id, thread_id, body_md, refs } = input as any;

    try {
      let msgThreadId = thread_id;
      if (!msgThreadId) {
        // Determine anchor type from addressee: if to_actor_id, use "workstream" as default anchor
        // ponytail: thread anchor choice depends on context (task vs workstream); defaulting to workstream for agent-to-agent.
        const anchorType: ThreadAnchorType = "workstream";
        const anchorId = to_actor_id || to_team_id || "general";
        const thread = ctx.store.commands.getOrCreateThread(anchorType, anchorId as string);
        msgThreadId = thread.id;
      }

      const msg = ctx.store.commands.sendMessage({
        thread_id: msgThreadId,
        from_actor_id: cred.actorId,
        to_actor_id: to_actor_id || null,
        to_team_id: to_team_id || null,
        type,
        body_md,
        refs: refs || [],
        visibility: "normal",
      });

      return { ok: true, data: { message_id: msg.id } };
    } catch (e) {
      return { ok: false, error: { code: "policy_violation", message: String(e) } };
    }
  },

  escalate: (ctx, cred, input) => {
    const { severity, body_md, refs } = input as any;

    try {
      const human = ctx.store.commands.getOrCreateHumanActor();
      const thread = ctx.store.commands.getOrCreateThread("workstream", cred.agentId as string);
      const msg = ctx.store.commands.sendMessage({
        thread_id: thread.id,
        from_actor_id: cred.actorId,
        to_actor_id: human,
        type: "escalation",
        body_md,
        refs: refs || [],
        visibility: "surfaced",
      });
      return { ok: true, data: { message_id: msg.id } };
    } catch (e) {
      return { ok: false, error: { code: "policy_violation", message: String(e) } };
    }
  },

  request_approval: (ctx, cred, input) => {
    const { kind, description, payload } = input as any;

    try {
      const approval = ctx.store.commands.requestApproval({
        requested_by_actor: cred.actorId,
        kind,
        payload: payload || { description },
      });
      return { ok: true, data: { approval_id: approval.id } };
    } catch (e) {
      return { ok: false, error: { code: "policy_violation", message: String(e) } };
    }
  },

  search_history: (ctx, cred, input) => {
    const { query, scope: requestedScope } = input as any;

    try {
      // Resolve caller's policy for search_history_scope
      const agent = ctx.store.agents.get(cred.agentId);
      const policy = agent ? resolvePolicy(ctx.store, cred.agentId) : { search_history_scope: "self" };
      const allowedScope = policy.search_history_scope || "self";

      // Clamp requested scope to allowed scope
      const scope = requestedScope && ["self", "team", "org"].includes(requestedScope) ? requestedScope : "self";
      if (
        (scope === "team" && allowedScope === "self") ||
        (scope === "org" && (allowedScope === "self" || allowedScope === "team"))
      ) {
        return {
          ok: false,
          error: { code: "policy_violation", message: `Search scope ${scope} exceeds policy limit ${allowedScope}` },
        };
      }

      // ponytail: LIKE scan until E11.5's FTS5 index. Naive SQL search for now.
      const hits: any[] = [];
      const pattern = `%${query}%`;

      // Search messages
      const messages = ctx.store.messages.listOpenForActor(cred.actorId);
      for (const msg of messages) {
        if (msg.body_md.includes(query)) {
          hits.push({
            ref: { kind: "message", id: msg.id },
            excerpt: msg.body_md.substring(0, 200),
            ts: msg.created_at,
          });
        }
      }

      // Search workstreams
      const workstreams = agent
        ? ctx.store.workstreams.list({ agent_id: agent.id })
        : ctx.store.workstreams.list();
      for (const ws of workstreams) {
        if (ws.goal_md.includes(query) || ws.title.includes(query)) {
          hits.push({
            ref: { kind: "workstream", id: ws.id },
            excerpt: (ws.title + ": " + ws.goal_md).substring(0, 200),
            ts: ws.created_at,
          });
        }
      }

      // ponytail: Search runs' result_json would require parsing; skip for v1
      // until E11 adds a proper search index.

      return { ok: true, data: { hits: hits.slice(0, 20) } };
    } catch (e) {
      return { ok: false, error: { code: "policy_violation", message: String(e) } };
    }
  },
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
