/**
 * Shared value-object schemas used across entities. Doc 02/05 name these fields (e.g.
 * `budget_json`, `usage_json`) but don't give exact sub-fields — shapes below are this
 * package's concrete proposal for those contracts; see OPEN_ISSUES.md for the ones
 * flagged as assumptions rather than restatements of the docs.
 */
import { z } from "zod";
import {
  ActorIdSchema,
  ArtifactIdSchema,
  MessageIdSchema,
  RefSchema,
  TeamIdSchema,
} from "../ids.js";

/** ISO-8601 timestamp. */
export const TimestampSchema = z.string().datetime();
export type Timestamp = z.infer<typeof TimestampSchema>;

/**
 * A token/currency cap plus its running spend (02 Workstream/Task `budget`).
 * Either axis may be uncapped (null); `spent` is always tracked so overrun is detectable
 * even against a null limit (org daily cap backstop, 07 F6).
 */
export const BudgetSchema = z.object({
  limit_usd: z.number().nonnegative().nullable(),
  limit_tokens: z.number().int().nonnegative().nullable(),
  spent_usd: z.number().nonnegative().default(0),
  spent_tokens: z.number().int().nonnegative().default(0),
});
export type Budget = z.infer<typeof BudgetSchema>;

/** Run/workstream usage as reported by the engine adapter — capability-dependent, so all optional. */
export const UsageSchema = z.object({
  tokens_in: z.number().int().nonnegative().optional(),
  tokens_out: z.number().int().nonnegative().optional(),
  cost_usd: z.number().nonnegative().optional(),
  duration_ms: z.number().int().nonnegative().optional(),
});
export type Usage = z.infer<typeof UsageSchema>;

/** `delegate_task` routing spec — team and/or role, resolved deterministically by the router (02). */
export const RoutingSpecSchema = z.object({
  team_id: TeamIdSchema.nullable().optional(),
  role: z.string().min(1).nullable().optional(),
});
export type RoutingSpec = z.infer<typeof RoutingSpecSchema>;

/** Task deliverable: completion message + artifacts (02 Task.deliverable_ref). */
export const DeliverableRefSchema = z.object({
  message_id: MessageIdSchema,
  artifact_refs: z.array(RefSchema).default([]),
});
export type DeliverableRef = z.infer<typeof DeliverableRefSchema>;

/** A run's terminal summary (adapter-api EngineEvent `run_ended` folds into this). */
export const RunResultSchema = z.object({
  outcome: z.enum(["completed", "needs_input", "failed", "cancelled"]),
  final_text: z.string().nullable(),
  artifact_refs: z.array(RefSchema).default([]),
  error: z.string().nullable().optional(),
});
export type RunResult = z.infer<typeof RunResultSchema>;

/** 02 Workspace: a git worktree per workstream, or a plain directory for non-code work. */
export const WorkspaceRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("git_worktree"),
    repo_path: z.string().min(1),
    worktree_path: z.string().min(1),
    branch: z.string().min(1),
  }),
  z.object({
    kind: z.literal("plain_dir"),
    path: z.string().min(1),
  }),
]);
export type WorkspaceRef = z.infer<typeof WorkspaceRefSchema>;

/**
 * Policy chain node (org -> team -> agent, 07). Every field is optional so a node can
 * override only what it wants to; resolution merges org -> team -> agent with later
 * layers winning per-field.
 */
export const PolicySchema = z.object({
  budget: BudgetSchema.partial().optional(),
  max_depth: z.number().int().positive().optional(),
  max_rejections: z.number().int().nonnegative().optional(),
  thread_round_cap: z.number().int().positive().optional(),
  question_expiry_hours: z.number().positive().optional(),
  tool_allowlist: z.array(z.string()).optional(),
  permission_mode: z.string().optional(),
  /** Actor ids (beyond the delegator/human default) allowed to `redirect` this agent. */
  can_redirect_actor_ids: z.array(ActorIdSchema).optional(),
  requires_human_acceptance: z.boolean().optional(),
  search_history_scope: z.enum(["self", "team", "org"]).optional(),
});
export type Policy = z.infer<typeof PolicySchema>;

/** Policy defaults, org-wide (04/06/07 depth/budget/round-cap/expiry defaults). */
export const DEFAULT_POLICY: Required<
  Pick<
    Policy,
    "max_depth" | "max_rejections" | "thread_round_cap" | "question_expiry_hours"
  >
> = {
  max_depth: 3,
  max_rejections: 2,
  thread_round_cap: 4,
  question_expiry_hours: 48,
};
