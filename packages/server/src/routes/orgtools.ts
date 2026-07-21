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
  describeOrgToolInput,
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
  type ThreadAnchorType,
  type ToolResult,
  type UpdateTaskInput,
} from "@foundry/core";
import type { RouteContext } from "../server.js";
import { ProblemError } from "../problem.js";
import type { RunCredential } from "../orgtools/tokens.js";
import { checkDelegation, resolvePolicy, resolveRouting } from "../policy/policy.js";
import { acceptTask, rejectTask, cancelTaskCascade } from "../tasks/decide.js";

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
 * The delegating agent's own workstream to re-trigger on delivery, if any. Two cases:
 * a sub-delegation (the delegator was itself mid-task) has it pinned via
 * `workstreams.task_id = task.parent_task_id`; a delegation from an agent's top-level,
 * non-task workstream (human-triggered root work that itself calls delegate_task) has
 * no such pin, so this falls back to that agent's newest non-terminal workstream — a
 * heuristic (an agent could in principle have several concurrent root workstreams) but
 * matches every scenario this system actually drives an agent through today. Returns
 * `null` when the delegator is the human (nothing to re-trigger; the completion
 * message is surfaced to the inbox instead) or has nothing open to resume.
 */
function resolveDelegatorWorkstream(ctx: RouteContext, task: Task) {
  if (task.parent_task_id) {
    return ctx.store.workstreams.list({ task_id: task.parent_task_id })[0];
  }
  const delegatorAgent = ctx.store.agents.list().find((a) => a.actor_id === task.delegator_actor_id);
  if (!delegatorAgent) return undefined; // delegator is the human
  const open = ctx.store.workstreams
    .list({ agent_id: delegatorAgent.id })
    .filter((ws) => ws.state !== "closed" && ws.state !== "archived");
  return open[open.length - 1];
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

    // The caller's own in-flight task, if any — this delegation is a sub-delegation
    // of it (depth + budget conservation, F4). Absent for a root/human delegation.
    const parent = callerParentTask(ctx, cred);
    const parentTask = parent ? { id: parent.id, depth: parent.depth, budget: parent.budget } : null;

    // Routing prefers an agent in the delegator's own team (keep work in-team when the
    // routing spec doesn't pin a team). Must match what checkDelegation validates below.
    const delegatorTeamId = ctx.store.agents.get(cred.agentId as never)?.team_id ?? null;

    // E8.5 — pre-check routing early if present, so we can fire an escalation before returning
    if (routing && !assignee_agent_id) {
      const routeResult = resolveRouting(ctx.store, routing, delegatorTeamId);
      if ("code" in routeResult) {
        // Routing failure surfaces to human inbox (F11)
        const human = ctx.store.commands.getOrCreateHumanActor();
        const thread = ctx.store.commands.getOrCreateThread("workstream", cred.agentId as string);
        ctx.store.commands.sendMessage({
          thread_id: thread.id,
          from_actor_id: cred.actorId as never,
          to_actor_id: human,
          type: "escalation",
          body_md: `Delegation routing failed: no active agent matches (team_id=${routing.team_id ?? "*"}, role=${routing.role ?? "*"}). The delegating run has received this error and may retry. Consider creating a specialist agent or adjusting routing criteria.`,
          refs: [],
          visibility: "surfaced",
        });
        return { ok: false, error: routeResult };
      }
    }

    // Check policy: AC, depth, budget, assignee, routing
    const policyErr = checkDelegation({
      store: ctx.store,
      delegator: cred.actorId,
      input: { acceptance_criteria_md, budget, assignee_agent_id, routing },
      parentTask,
    });
    if (policyErr) {
      // E10.4 Rule 3: Cap hits → inbox escalation (depth_cap or budget_exceeded)
      if (policyErr.code === "depth_cap" || policyErr.code === "budget_exceeded") {
        const human = ctx.store.commands.getOrCreateHumanActor();
        const thread = ctx.store.commands.getOrCreateThread("workstream", cred.agentId as string);
        const details = (policyErr.details as any) || {};
        let body = "";
        if (policyErr.code === "depth_cap") {
          body = `Delegation depth cap hit: attempted depth ${details.child_depth}, max allowed ${details.max_depth}. The delegating run has received this error. Consider doing the work directly or requesting a policy override.`;
        } else if (policyErr.code === "budget_exceeded") {
          body = `Delegation budget cap exceeded on ${details.axis}: child limit ${details.child_limit} plus open siblings' ${details.sibling_sum} exceeds parent limit ${details.parent_limit}. The delegating run has received this error. Consider adjusting budget allocation or concluding work.`;
        }
        ctx.store.commands.sendMessage({
          thread_id: thread.id,
          from_actor_id: cred.actorId as never,
          to_actor_id: human,
          type: "escalation",
          body_md: body,
          refs: [],
          visibility: "surfaced",
        });
      }
      return { ok: false, error: policyErr };
    }

    // Resolve assignee for createTask
    let resolvedAssigneeId: any;
    if (assignee_agent_id) {
      resolvedAssigneeId = assignee_agent_id;
    } else if (routing) {
      const routeResult = resolveRouting(ctx.store, routing, delegatorTeamId);
      if ("code" in routeResult) {
        return { ok: false, error: routeResult };
      }
      // resolveRouting returns the resolved Agent, not just its id — createTask wants
      // the id (this was previously passing the whole object through, which would
      // fail to bind as a SQLite parameter).
      resolvedAssigneeId = routeResult.id;
    }

    // Create the task, spawn the assignee's workstream, and trigger their first run
    // (doc-04 delegation flow: create Task(pending) -> create Workstream(origin=task)
    // -> schedule run(trigger=task_assigned) -> Task: in_progress).
    try {
      const task = ctx.store.commands.createTask({
        parent_task_id: parent ? parent.id : null,
        delegator_actor_id: cred.actorId,
        assignee_agent_id: resolvedAssigneeId,
        routing_spec: routing || null,
        spec_md,
        acceptance_criteria_md,
        budget: budget || { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 },
      });
      const ws = ctx.store.commands.createWorkstream({
        agent_id: resolvedAssigneeId,
        title: (spec_md as string).slice(0, 80),
        goal_md: acceptance_criteria_md,
        origin: `task:${task.id}` as never,
        task_id: task.id as never,
        budget: task.budget,
      });
      try {
        ctx.runtime.enqueue({ workstreamId: ws.id, trigger: "task_assigned" });
        ctx.store.commands.transitionTaskState({ id: task.id, to: "in_progress", actorId: cred.actorId });
      } catch (enqueueErr) {
        // Task+workstream exist but nothing runs yet (e.g. assignee suspended between
        // policy check and now) — leave the task pending; not fatal to the delegation.
        void enqueueErr;
      }
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
      // Resolved once so the message's visibility and the re-trigger decision agree:
      // an agent delegator gets re-triggered (message stays "normal", it'll be in their
      // next composed context); a human delegator (or an agent with nothing open to
      // resume) gets it "surfaced" into the inbox instead (doc-04: "roots delegated by
      // the human are accepted by the human").
      const delegatorWs = resolveDelegatorWorkstream(ctx, task);

      const thread = ctx.store.commands.getOrCreateThread("task", task_id as string);
      const msg = ctx.store.commands.sendMessage({
        thread_id: thread.id,
        from_actor_id: cred.actorId,
        to_actor_id: task.delegator_actor_id,
        type: "completion",
        body_md: summary_md,
        refs: artifact_refs || [],
        visibility: delegatorWs ? "normal" : "surfaced",
      });

      // Transition task to delivered with the completion message ref
      if (canTransition("task", task.state, "delivered")) {
        ctx.store.commands.transitionTaskState({
          id: task_id as string,
          to: "delivered",
          actorId: cred.actorId,
          deliverableRef: { message_id: msg.id, artifact_refs: artifact_refs || [] },
        });
        // Re-trigger the delegator's workstream so the deliverable + AC reach its next
        // composed context (doc-04 delegation flow) — it can then call
        // accept_task/reject_task.
        if (delegatorWs) {
          ctx.runtime.enqueue({ workstreamId: delegatorWs.id, trigger: "agent_message" });
        }
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

  accept_task: (ctx, cred, input) => {
    const { task_id } = input as any;
    const err = acceptTask({ store: ctx.store, runtime: ctx.runtime, taskId: task_id, decidedBy: cred.actorId });
    return err ? { ok: false, error: err } : { ok: true, data: { ok: true } };
  },

  reject_task: (ctx, cred, input) => {
    const { task_id, reason } = input as any;
    const result = rejectTask({ store: ctx.store, runtime: ctx.runtime, taskId: task_id, decidedBy: cred.actorId, reason });
    return "code" in result ? { ok: false, error: result } : { ok: true, data: { ok: true, escalated: result.escalated } };
  },

  cancel_task: async (ctx, cred, input) => {
    const { task_id, reason } = input as any;
    const err = await cancelTaskCascade({ store: ctx.store, runtime: ctx.runtime, taskId: task_id, cancelledBy: cred.actorId, reason });
    return err ? { ok: false, error: err } : { ok: true, data: { ok: true } };
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

      // E8.4 — thread round cap check (F5): agent-to-agent only, not human-agent
      // Only check when to_actor_id is set (no cap for team sends)
      if (to_actor_id) {
        const senderAgent = ctx.store.agents.list().find((a) => a.actor_id === cred.actorId);
        const recipientAgent = ctx.store.agents.list().find((a) => a.actor_id === to_actor_id);

        // If both are real agents (not human), check the round cap
        if (senderAgent && recipientAgent) {
          const thread = ctx.store.messages.getThread(msgThreadId as never);
          if (thread && thread.round_count >= resolvePolicy(ctx.store, senderAgent).thread_round_cap) {
            // Thread round cap exceeded. Check if an escalation already exists to avoid duplicates.
            const existingEscalation = ctx.store.messages
              .listByThread(thread.id)
              .some((m) => m.type === "escalation" && m.disposition === "open");

            if (!existingEscalation) {
              const human = ctx.store.commands.getOrCreateHumanActor();
              ctx.store.commands.sendMessage({
                thread_id: thread.id,
                from_actor_id: cred.actorId as never,
                to_actor_id: human,
                type: "escalation",
                body_md: `Thread between agents has exceeded round cap (${resolvePolicy(ctx.store, senderAgent).thread_round_cap} messages per thread) — pulling in a human to decide next steps.`,
                refs: [],
                visibility: "surfaced",
              });
            }

            return { ok: false, error: { code: "thread_round_cap", message: `Agent-to-agent thread exceeded round cap of ${resolvePolicy(ctx.store, senderAgent).thread_round_cap}` } };
          }
        }
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
      // approvals.ts's grant handler reads payload.workstream_id to know which run to
      // re-trigger (E6.4 AC: "grant ⇒ next run scheduled") — same shape the supervisor's
      // engine-permission_request path already writes.
      const run = ctx.store.runs.get(cred.runId);
      const approval = ctx.store.commands.requestApproval({
        requested_by_actor: cred.actorId,
        kind,
        payload: { description, ...(payload as object | undefined), run_id: cred.runId, workstream_id: run?.workstream_id },
      });
      return { ok: true, data: { approval_id: approval.id } };
    } catch (e) {
      return { ok: false, error: { code: "policy_violation", message: String(e) } };
    }
  },

  search_history: (ctx, cred, input) => {
    const { query, scope: requestedScope } = input as SearchHistoryInput;

    try {
      // Resolve caller's policy for search_history_scope
      const agent = ctx.store.agents.get(cred.agentId);
      const policy = agent ? resolvePolicy(ctx.store, agent) : { search_history_scope: "self" as SearchHistoryScope };
      const allowedScope = policy.search_history_scope || "self";

      // Clamp requested scope to allowed scope
      const scope: SearchHistoryScope = requestedScope ?? "self";
      if (
        (scope === "team" && allowedScope === "self") ||
        (scope === "org" && (allowedScope === "self" || allowedScope === "team"))
      ) {
        return {
          ok: false,
          error: { code: "policy_violation", message: `Search scope ${scope} exceeds policy limit ${allowedScope}` },
        };
      }

      // "self": only the caller's own messages/workstreams/runs. "team": everyone on
      // the caller's team (a teamless agent has no teammates, so this narrows to just
      // itself rather than falling through to an unfiltered org-wide search — note
      // *both* axes need scoping, or an unscoped one silently leaks the other corpus
      // org-wide). "org": unfiltered (store.search.text's default).
      let filter: Parameters<typeof ctx.store.search.text>[1];
      if (scope === "self") {
        filter = { actor_ids: [cred.actorId], agent_ids: agent ? [agent.id] : [] };
      } else if (scope === "team") {
        const teammates = agent?.team_id ? ctx.store.agents.list({ team_id: agent.team_id }) : agent ? [agent] : [];
        filter = { actor_ids: teammates.map((a) => a.actor_id), agent_ids: teammates.map((a) => a.id) };
      }

      return { ok: true, data: { hits: ctx.store.search.text(query, filter) } };
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
      // transport failure — same channel as policy rejections. Echo the expected fields
      // (derived from the same Zod schema) so the agent self-corrects instead of guessing.
      const result: ToolResult<never> = {
        ok: false,
        error: {
          code: "policy_violation",
          message: `invalid ${toolName} input.\n${describeOrgToolInput(toolName)}`,
          details: parsed.error.issues,
        },
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
