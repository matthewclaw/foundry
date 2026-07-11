/**
 * E1.4 — Org-tool input/output schemas (contracts.md "Org-tools contract"). These are
 * the Zod definitions the MCP server and CLI shim derive their tool schemas from
 * (contracts.md: "MCP tool schemas derive from the same Zod definitions") — one
 * definition, no drift between the two transports.
 */
import { z } from "zod";
import {
  AgentIdSchema,
  ActorIdSchema,
  ApprovalIdSchema,
  MessageIdSchema,
  RefSchema,
  TaskIdSchema,
  TeamIdSchema,
  ThreadIdSchema,
} from "../ids.js";
import { BudgetSchema, RoutingSpecSchema, TimestampSchema } from "../schemas/common.js";
import { AgentSchema, MessageSchema, MessageTypeSchema, ThreadSchema, TaskSchema, AgentStateSchema } from "../schemas/entities.js";
import { toolResultSchema } from "../api/errors.js";

// --- delegate_task ---

export const DelegateTaskInputSchema = z
  .object({
    title: z.string().min(1),
    spec_md: z.string().min(1),
    acceptance_criteria_md: z.string().min(1), // ADR-006: no delegation without checkable AC
    budget: BudgetSchema.partial().optional(),
    assignee_agent_id: AgentIdSchema.optional(),
    routing: RoutingSpecSchema.optional(),
    refs: z.array(RefSchema).optional(),
  })
  .refine((v) => Boolean(v.assignee_agent_id) !== Boolean(v.routing), {
    message: "Provide exactly one of assignee_agent_id or routing",
  });
export type DelegateTaskInput = z.infer<typeof DelegateTaskInputSchema>;

export const DelegateTaskOutputSchema = z.object({ task_id: TaskIdSchema });
export type DelegateTaskOutput = z.infer<typeof DelegateTaskOutputSchema>;
export const DelegateTaskResultSchema = toolResultSchema(DelegateTaskOutputSchema);

// --- update_task ---

export const UpdateTaskInputSchema = z.object({
  task_id: TaskIdSchema,
  note_md: z.string().optional(),
  blocked: z.object({ reason: z.string().min(1) }).optional(),
});
export type UpdateTaskInput = z.infer<typeof UpdateTaskInputSchema>;

export const UpdateTaskOutputSchema = z.object({ ok: z.literal(true) });
export const UpdateTaskResultSchema = toolResultSchema(UpdateTaskOutputSchema);

// --- deliver_task ---

export const DeliverTaskInputSchema = z.object({
  task_id: TaskIdSchema,
  summary_md: z.string().min(1),
  artifact_refs: z.array(RefSchema),
});
export type DeliverTaskInput = z.infer<typeof DeliverTaskInputSchema>;

export const DeliverTaskOutputSchema = z.object({ ok: z.literal(true) });
export const DeliverTaskResultSchema = toolResultSchema(DeliverTaskOutputSchema);

// --- accept_task / reject_task (E8.1) ---
// contracts.md's org-tools contract table predates these two; doc-04 is explicit that
// "agents review their own subordinates" (delegated acceptance, not just the human at
// the root), so a delegating *agent* needs a tool-facing way to decide, not just the
// human-facing `/api/tasks/:id/{accept,reject}` HTTP route. Additive amendment,
// OPEN_ISSUES #35 — same posture as every other post-freeze addition in this file.

export const AcceptTaskInputSchema = z.object({ task_id: TaskIdSchema });
export type AcceptTaskInput = z.infer<typeof AcceptTaskInputSchema>;

export const AcceptTaskOutputSchema = z.object({ ok: z.literal(true) });
export const AcceptTaskResultSchema = toolResultSchema(AcceptTaskOutputSchema);

export const RejectTaskInputSchema = z.object({ task_id: TaskIdSchema, reason: z.string().min(1) });
export type RejectTaskInput = z.infer<typeof RejectTaskInputSchema>;

/** `escalated: true` when the F12 rejection cap was hit this call (task stays `rejected`, no auto-resume). */
export const RejectTaskOutputSchema = z.object({ ok: z.literal(true), escalated: z.boolean() });
export const RejectTaskResultSchema = toolResultSchema(RejectTaskOutputSchema);

// --- send_message ---
// Closed set minus escalation/completion, which have their own dedicated tools below (04/contracts.md).

export const SendableMessageTypeSchema = MessageTypeSchema.exclude(["escalation", "completion"]);
export type SendableMessageType = z.infer<typeof SendableMessageTypeSchema>;

export const SendMessageInputSchema = z
  .object({
    type: SendableMessageTypeSchema,
    to_actor_id: ActorIdSchema.optional(),
    to_team_id: TeamIdSchema.optional(),
    thread_id: ThreadIdSchema.optional(),
    body_md: z.string().min(1),
    refs: z.array(RefSchema).optional(),
  })
  .refine((v) => Boolean(v.to_actor_id) !== Boolean(v.to_team_id), {
    message: "Provide exactly one of to_actor_id or to_team_id",
  });
export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;

export const SendMessageOutputSchema = z.object({ message_id: MessageIdSchema });
export const SendMessageResultSchema = toolResultSchema(SendMessageOutputSchema);

// --- escalate ---

export const EscalationSeveritySchema = z.enum(["decision_needed", "blocked", "incident"]);
export type EscalationSeverity = z.infer<typeof EscalationSeveritySchema>;

export const EscalateInputSchema = z.object({
  severity: EscalationSeveritySchema,
  body_md: z.string().min(1),
  refs: z.array(RefSchema).optional(),
});
export type EscalateInput = z.infer<typeof EscalateInputSchema>;

export const EscalateOutputSchema = z.object({ message_id: MessageIdSchema });
export const EscalateResultSchema = toolResultSchema(EscalateOutputSchema);

// --- request_approval ---

export const RequestApprovalInputSchema = z.object({
  kind: z.string().min(1),
  description: z.string().min(1),
  payload: z.unknown().optional(),
});
export type RequestApprovalInput = z.infer<typeof RequestApprovalInputSchema>;

export const RequestApprovalOutputSchema = z.object({ approval_id: ApprovalIdSchema });
export const RequestApprovalResultSchema = toolResultSchema(RequestApprovalOutputSchema);

// --- search_history (ADR-012, policy-scoped FTS5 recall) ---

export const SearchHistoryScopeSchema = z.enum(["self", "team", "org"]);
export type SearchHistoryScope = z.infer<typeof SearchHistoryScopeSchema>;

export const SearchHistoryInputSchema = z.object({
  query: z.string().min(1),
  scope: SearchHistoryScopeSchema.optional(),
});
export type SearchHistoryInput = z.infer<typeof SearchHistoryInputSchema>;

export const SearchHistoryHitSchema = z.object({
  ref: RefSchema,
  excerpt: z.string(),
  ts: TimestampSchema,
});
export type SearchHistoryHit = z.infer<typeof SearchHistoryHitSchema>;

export const SearchHistoryOutputSchema = z.object({ hits: z.array(SearchHistoryHitSchema) });
export const SearchHistoryResultSchema = toolResultSchema(SearchHistoryOutputSchema);

// --- policy-scoped reads: get_task / get_thread / list_org ---

export const GetTaskInputSchema = z.object({ task_id: TaskIdSchema });
export const GetTaskOutputSchema = TaskSchema;
export const GetTaskResultSchema = toolResultSchema(GetTaskOutputSchema);

export const GetThreadInputSchema = z.object({ thread_id: ThreadIdSchema });
export const GetThreadOutputSchema = z.object({
  thread: ThreadSchema,
  messages: z.array(MessageSchema),
});
export const GetThreadResultSchema = toolResultSchema(GetThreadOutputSchema);

export const ListOrgInputSchema = z.object({}).strict();
/**
 * A minimal, tool-facing org summary (name/role/team/state only) — the rich navigation
 * projection (org health roll-ups, burn, relationships) is `@foundry/store`'s `orgView()`
 * (contracts.md: purpose-built projections live in store, not core); this is just enough
 * for an agent to look up teammates via `list_org`.
 */
export const ListOrgOutputSchema = z.object({
  teams: z.array(z.object({ id: TeamIdSchema, name: z.string() })),
  agents: z.array(
    z.object({
      id: AgentIdSchema,
      name: z.string(),
      role: z.string(),
      team_id: TeamIdSchema.nullable(),
      state: AgentStateSchema,
    })
  ),
});
export const ListOrgResultSchema = toolResultSchema(ListOrgOutputSchema);

/** Registry of every org-tool's input schema — used to auto-derive MCP tool schemas. */
export const ORG_TOOL_INPUT_SCHEMAS = {
  delegate_task: DelegateTaskInputSchema,
  update_task: UpdateTaskInputSchema,
  deliver_task: DeliverTaskInputSchema,
  accept_task: AcceptTaskInputSchema,
  reject_task: RejectTaskInputSchema,
  send_message: SendMessageInputSchema,
  escalate: EscalateInputSchema,
  request_approval: RequestApprovalInputSchema,
  search_history: SearchHistoryInputSchema,
  get_task: GetTaskInputSchema,
  get_thread: GetThreadInputSchema,
  list_org: ListOrgInputSchema,
} as const;

export type OrgToolName = keyof typeof ORG_TOOL_INPUT_SCHEMAS;
