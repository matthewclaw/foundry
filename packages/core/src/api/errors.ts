/**
 * E1.4 — Machine-readable policy error codes (contracts.md: "policy rejections carry
 * machine-readable `code` … org-tools relay these codes verbatim into the run").
 */
import { z } from "zod";

export const POLICY_ERROR_CODES = [
  "budget_exceeded", // delegate_task would give a child more than the parent's remaining budget
  "budget_exhausted", // a run was cut off at its budget cap mid-task (07 F6)
  "depth_cap", // sub-delegation beyond policy.max_depth (04)
  "missing_acceptance_criteria", // delegate_task without checkable AC (ADR-006)
  "assignee_not_found", // assignee_agent_id doesn't resolve to a known agent
  "assignee_not_eligible", // assignee exists but isn't active / can't take work (suspended, retired)
  "routing_failed", // no eligible agent for a team/role routing spec (07 F11)
  "thread_round_cap", // agent-to-agent thread hit its round cap (07 F5)
  "unauthorized_redirect", // redirect from an actor who isn't the delegator or the human (04)
  "max_rejections_exceeded", // rejection loop hit policy.max_rejections (07 F12)
  "invalid_transition", // requested state change isn't in the entity's transition table
  "approval_required", // the requested action needs a human/delegator approval first
  "policy_violation", // catch-all for a named policy check with no more specific code
] as const;

export const PolicyErrorCodeSchema = z.enum(POLICY_ERROR_CODES);
export type PolicyErrorCode = z.infer<typeof PolicyErrorCodeSchema>;

export const PolicyErrorSchema = z.object({
  code: PolicyErrorCodeSchema,
  message: z.string().min(1),
  details: z.unknown().optional(),
});
export type PolicyError = z.infer<typeof PolicyErrorSchema>;

/** RFC 9457 problem+json shape used by the HTTP API (contracts.md "Errors"). */
export const ProblemDetailsSchema = z.object({
  type: z.string().default("about:blank"),
  title: z.string().min(1),
  status: z.number().int().min(100).max(599),
  detail: z.string().optional(),
  code: PolicyErrorCodeSchema.optional(),
  instance: z.string().optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;

/**
 * The result shape every org-tool call returns: either the tool's data, or a policy
 * error carrying one of the codes above, verbatim, into the run (ADR-004).
 */
export function toolResultSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), data: dataSchema }),
    z.object({ ok: z.literal(false), error: PolicyErrorSchema }),
  ]);
}
export type ToolResult<T> = { ok: true; data: T } | { ok: false; error: PolicyError };
