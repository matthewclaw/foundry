/**
 * E1.4 — API command DTOs (contracts.md "API contract"). Query endpoints mirror store
 * projections 1:1 and those projection shapes are owned by `@foundry/store`
 * (contracts.md component contracts) — not restated here, since core sits below store.
 */
import { z } from "zod";
import { AgentIdSchema, TaskIdSchema, TeamIdSchema, WorkstreamIdSchema } from "../ids.js";
import { PolicySchema, WorkspaceRefSchema } from "../schemas/common.js";
import { EngineBindingSchema } from "../schemas/entities.js";
import { DelegateTaskInputSchema } from "../org-tools/schemas.js";

// --- POST /api/agents · PATCH /api/agents/:id · lifecycle actions ---

export const CreateAgentRequestSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  team_id: TeamIdSchema.nullable().optional(),
  charter_md: z.string().min(1),
  engine: EngineBindingSchema,
  policy_overrides: PolicySchema.optional(),
});
export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>;

export const PatchAgentRequestSchema = z.object({
  name: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  team_id: TeamIdSchema.nullable().optional(),
  charter_md: z.string().min(1).optional(),
  engine: EngineBindingSchema.optional(),
  policy_overrides: PolicySchema.optional(),
});
export type PatchAgentRequest = z.infer<typeof PatchAgentRequestSchema>;

export const AgentLifecycleActionSchema = z.enum(["suspend", "resume", "retire"]);
export type AgentLifecycleAction = z.infer<typeof AgentLifecycleActionSchema>;

export const AgentLifecycleRequestSchema = z.object({ reason: z.string().optional() });
export type AgentLifecycleRequest = z.infer<typeof AgentLifecycleRequestSchema>;

// --- POST /api/teams ---

export const CreateTeamRequestSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  default_policy: PolicySchema.optional(),
});
export type CreateTeamRequest = z.infer<typeof CreateTeamRequestSchema>;

// --- PATCH /api/teams/:id · DELETE /api/teams/:id ---

export const PatchTeamRequestSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
});
export type PatchTeamRequest = z.infer<typeof PatchTeamRequestSchema>;

// --- POST /api/workstreams · messages · close ---

export const CreateWorkstreamRequestSchema = z.object({
  agent_id: AgentIdSchema,
  title: z.string().min(1),
  goal_md: z.string(),
  workspace_ref: WorkspaceRefSchema.optional(),
  budget: PolicySchema.shape.budget,
});
export type CreateWorkstreamRequest = z.infer<typeof CreateWorkstreamRequestSchema>;

/** A human message on a workstream is either a plain message or a `redirect` (04).
 * `resume` (default true) picks reply-vs-new-conversation: true continues the current
 * engine session (a Reply, in the UI's terms), false forces a cold start into a new
 * conversation even if a resumable session exists. */
export const PostWorkstreamMessageRequestSchema = z.object({
  kind: z.enum(["message", "redirect"]).default("message"),
  body_md: z.string().min(1),
  resume: z.boolean().default(true),
});
export type PostWorkstreamMessageRequest = z.infer<typeof PostWorkstreamMessageRequestSchema>;

export const SetRunTitleRequestSchema = z.object({
  title: z.string().min(1),
});
export type SetRunTitleRequest = z.infer<typeof SetRunTitleRequestSchema>;

export const CloseWorkstreamRequestSchema = z.object({
  reason: z.string().optional(),
  /**
   * E11.3: run a final distillation pass before closing — the agent gets one run whose
   * trigger instructs it to distil durable lessons/skills into memory; the workstream
   * closes when that run settles.
   */
  distill: z.boolean().optional(),
});
export type CloseWorkstreamRequest = z.infer<typeof CloseWorkstreamRequestSchema>;

// --- POST /api/tasks (human delegation — same schema as the delegate_task org-tool) ---

export const CreateTaskRequestSchema = DelegateTaskInputSchema;
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;

export const AcceptTaskRequestSchema = z.object({}).strict();
export type AcceptTaskRequest = z.infer<typeof AcceptTaskRequestSchema>;

export const RejectTaskRequestSchema = z.object({ reason: z.string().min(1) });
export type RejectTaskRequest = z.infer<typeof RejectTaskRequestSchema>;

export const CancelTaskRequestSchema = z.object({ reason: z.string().optional() });
export type CancelTaskRequest = z.infer<typeof CancelTaskRequestSchema>;

// --- POST /api/runs/:id/cancel ---

export const CancelRunRequestSchema = z.object({ reason: z.string().optional() });
export type CancelRunRequest = z.infer<typeof CancelRunRequestSchema>;

// --- POST /api/approvals/:id/{grant,deny} ---

export const GrantApprovalRequestSchema = z.object({ note_md: z.string().optional() });
export type GrantApprovalRequest = z.infer<typeof GrantApprovalRequestSchema>;

export const DenyApprovalRequestSchema = z.object({ reason: z.string().optional() });
export type DenyApprovalRequest = z.infer<typeof DenyApprovalRequestSchema>;

/** Re-exported so API-layer code can key requests by workstream/task id without importing ids.js directly. */
export const RESOURCE_ID_SCHEMAS = {
  workstream_id: WorkstreamIdSchema,
  task_id: TaskIdSchema,
  agent_id: AgentIdSchema,
} as const;
