/**
 * E6.3 — Policy engine: effective-policy resolution (org → team → agent chain),
 * deterministic routing, delegation checks (F4 depth/budget, F11 routing), and the
 * rejection-loop check (F12). Docs: 02 (routing rules), 04 (delegation flow),
 * 07 (policy matrix).
 */
import {
  DEFAULT_POLICY,
  type Agent,
  type ActorId,
  type Budget,
  type Policy,
  type PolicyError,
  type RoutingSpec,
  type TaskId,
} from "@foundry/core";
import type { Store } from "@foundry/store";

/** The fully-resolved policy every check runs against — no optional fields left. */
export type ResolvedPolicy = Required<Policy>;

const ORG_POLICY: ResolvedPolicy = {
  // ponytail: org level = DEFAULT_POLICY for v1; a real org policy row is a later concern.
  budget: { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 },
  max_depth: DEFAULT_POLICY.max_depth,
  max_rejections: DEFAULT_POLICY.max_rejections,
  thread_round_cap: DEFAULT_POLICY.thread_round_cap,
  question_expiry_hours: DEFAULT_POLICY.question_expiry_hours,
  tool_allowlist: [],
  permission_mode: "default",
  can_redirect_actor_ids: [],
  requires_human_acceptance: false,
  search_history_scope: "self",
};

/** Per-field merge where later layers win (07: org → team → agent). */
function overlay(base: ResolvedPolicy, layer: Policy | undefined): ResolvedPolicy {
  if (!layer) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(layer)) {
    if (v !== undefined && v !== null) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Effective policy for an agent: DEFAULT_POLICY ← team.default_policy ← agent.policy_overrides. */
export function resolvePolicy(store: Store, agent: Agent): ResolvedPolicy {
  const team = agent.team_id ? store.teams.get(agent.team_id) : undefined;
  return overlay(overlay(ORG_POLICY, team?.default_policy), agent.policy_overrides);
}

/**
 * Deterministic routing (02): filter ACTIVE agents by team_id and/or role exact-match,
 * pick fewest open workstreams, tie-break lowest agent id. Returns the resolved agent
 * or a `routing_failed` PolicyError (F11).
 */
export function resolveRouting(store: Store, routing: RoutingSpec): Agent | PolicyError {
  const openWorkstreams = (agentId: Agent["id"]) =>
    store.workstreams.list({ agent_id: agentId }).filter((ws) => ws.state !== "closed" && ws.state !== "archived")
      .length;

  const candidates = store.agents
    .list({ state: "active" })
    .filter(
      (a) =>
        (routing.team_id == null || a.team_id === routing.team_id) &&
        (routing.role == null || a.role === routing.role)
    )
    .sort((a, b) => {
      const load = openWorkstreams(a.id) - openWorkstreams(b.id);
      return load !== 0 ? load : a.id < b.id ? -1 : 1;
    });

  if (candidates.length === 0) {
    return {
      code: "routing_failed",
      message: `No eligible active agent matches routing spec (team_id=${routing.team_id ?? "*"}, role=${routing.role ?? "*"})`,
      details: { routing },
    };
  }
  return candidates[0]!;
}

export interface CheckDelegationArgs {
  store: Store;
  /** The delegating actor (an agent's actor_id, or the human). */
  delegator: ActorId;
  input: {
    acceptance_criteria_md: string;
    budget?: Partial<Budget>;
    assignee_agent_id?: string;
    routing?: RoutingSpec;
  };
  /** The task the delegator is executing, when this is a sub-delegation. */
  parentTask?: { id: TaskId; depth: number; budget: Budget } | null;
}

const NON_TERMINAL_TASK_STATES = new Set(["pending", "in_progress", "blocked", "delivered", "rejected"]);

/**
 * Delegation policy checks, in order (first failure wins):
 * missing_acceptance_criteria → depth_cap → budget_exceeded → assignee_not_found /
 * assignee_not_eligible / routing_failed. Returns null when clean.
 */
export function checkDelegation(args: CheckDelegationArgs): PolicyError | null {
  const { store, input, parentTask } = args;

  // 1. AC mandatory (ADR-006 / 04): blank or whitespace-only is refused.
  if (!input.acceptance_criteria_md || input.acceptance_criteria_md.trim() === "") {
    return {
      code: "missing_acceptance_criteria",
      message: "delegate_task requires checkable acceptance criteria; the schema refuses vague delegation (04)",
    };
  }

  // 2. Depth cap (F4). The delegator's effective policy decides; a human delegator
  // gets the org default.
  const delegatorAgent = store.agents.list().find((a) => a.actor_id === args.delegator);
  const policy = delegatorAgent ? resolvePolicy(store, delegatorAgent) : ORG_POLICY;
  const childDepth = (parentTask?.depth ?? 0) + 1;
  if (childDepth > policy.max_depth) {
    return {
      code: "depth_cap",
      message: `Delegation depth ${childDepth} exceeds max_depth ${policy.max_depth} — escalate or do the work yourself (04)`,
      details: { child_depth: childDepth, max_depth: policy.max_depth },
    };
  }

  // 3. Budget conservation (04): per axis where both parent and child limits are
  // non-null, child limit + Σ non-terminal sibling limits must fit in the parent's limit.
  if (parentTask && input.budget) {
    const siblings = store.tasks
      .list()
      .filter((t) => t.parent_task_id === parentTask.id && NON_TERMINAL_TASK_STATES.has(t.state));
    for (const axis of ["limit_usd", "limit_tokens"] as const) {
      const parentLimit = parentTask.budget[axis];
      const childLimit = input.budget[axis];
      if (parentLimit == null || childLimit == null) continue;
      const siblingSum = siblings.reduce((sum, t) => sum + (t.budget[axis] ?? 0), 0);
      if (childLimit + siblingSum > parentLimit) {
        return {
          code: "budget_exceeded",
          message: `Child ${axis} ${childLimit} plus open siblings' ${siblingSum} exceeds parent limit ${parentLimit}`,
          details: { axis, child_limit: childLimit, sibling_sum: siblingSum, parent_limit: parentLimit },
        };
      }
    }
  }

  // 4. Assignee: explicit id must exist and be active; a routing spec must resolve.
  if (input.assignee_agent_id) {
    const assignee = store.agents.get(input.assignee_agent_id as never);
    if (!assignee) {
      return { code: "assignee_not_found", message: `No such agent: ${input.assignee_agent_id}` };
    }
    if (assignee.state !== "active") {
      return {
        code: "assignee_not_eligible",
        message: `Agent ${assignee.name} is ${assignee.state}, not active`,
        details: { agent_id: assignee.id, state: assignee.state },
      };
    }
  } else if (input.routing) {
    const routed = resolveRouting(store, input.routing);
    if ("code" in routed) return routed;
  }

  return null;
}

/** F12: rejected-work loop cap. Exported for E8's acceptance flow; tested here. */
export function checkRejection(task: { rejection_count: number }, policy: ResolvedPolicy): PolicyError | null {
  if (task.rejection_count >= policy.max_rejections) {
    return {
      code: "max_rejections_exceeded",
      message: `Task rejected ${task.rejection_count} times (max ${policy.max_rejections}) — auto-escalates (F12)`,
      details: { rejection_count: task.rejection_count, max_rejections: policy.max_rejections },
    };
  }
  return null;
}
