/**
 * E1.1 — Entity types + Zod schemas for every entity in 02-domain-model.md.
 * Field lists mirror 02 (domain description) cross-checked against the authoritative
 * table shapes in 05-data-and-persistence.md. Zod schemas are the source of truth;
 * static types are inferred from them.
 */
import { z } from "zod";
import {
  ActorIdSchema,
  AgentIdSchema,
  ApprovalIdSchema,
  ArtifactIdSchema,
  MessageIdSchema,
  RefSchema,
  RunIdSchema,
  ScheduleIdSchema,
  TaskIdSchema,
  TeamIdSchema,
  ThreadIdSchema,
  WorkstreamIdSchema,
  isValidUlid,
} from "../ids.js";
import {
  BudgetSchema,
  DeliverableRefSchema,
  PolicySchema,
  RoutingSpecSchema,
  RunResultSchema,
  TimestampSchema,
  UsageSchema,
  WorkspaceRefSchema,
} from "./common.js";

// --- Actor ---

export const ActorKindSchema = z.enum(["human", "agent"]);
export type ActorKind = z.infer<typeof ActorKindSchema>;

export const ActorSchema = z.object({
  id: ActorIdSchema,
  kind: ActorKindSchema,
  display_name: z.string().min(1),
  created_at: TimestampSchema,
});
export type Actor = z.infer<typeof ActorSchema>;

// --- Agent ---

export const AgentStateSchema = z.enum(["draft", "active", "suspended", "retired"]);
export type AgentState = z.infer<typeof AgentStateSchema>;

export const EngineBindingSchema = z.object({
  id: z.string().min(1),
  config: z.unknown().optional(),
});
export type EngineBinding = z.infer<typeof EngineBindingSchema>;

export const AgentSchema = z.object({
  id: AgentIdSchema,
  actor_id: ActorIdSchema,
  name: z.string().min(1),
  role: z.string().min(1),
  avatar_color: z.string().optional(),
  team_id: TeamIdSchema.nullable(),
  charter_version: z.number().int().positive(),
  engine: EngineBindingSchema,
  memory_ref: z.string().min(1),
  default_workspace_ref: WorkspaceRefSchema.nullable(),
  policy_overrides: PolicySchema,
  state: AgentStateSchema,
  created_at: TimestampSchema,
  retired_at: TimestampSchema.nullable(),
});
export type Agent = z.infer<typeof AgentSchema>;

export const AgentCharterSchema = z.object({
  agent_id: AgentIdSchema,
  version: z.number().int().positive(),
  body_md: z.string(),
  edited_by_actor: ActorIdSchema,
  created_at: TimestampSchema,
});
export type AgentCharter = z.infer<typeof AgentCharterSchema>;

// --- Team ---

export const TeamSchema = z.object({
  id: TeamIdSchema,
  name: z.string().min(1),
  description: z.string(),
  default_policy: PolicySchema,
  // "This team works on this project": agents in the team inherit this repo/dir for their
  // runs unless the agent (a "consultant") or workstream overrides it. See workspace
  // resolution in runtime/facade.ts — team default sits below the agent default.
  default_workspace_ref: WorkspaceRefSchema.nullable(),
});
export type Team = z.infer<typeof TeamSchema>;

// --- Workstream ---

export const WorkstreamStateSchema = z.enum([
  "open",
  "active",
  "waiting",
  "blocked",
  "review",
  "closed",
  "archived",
]);
export type WorkstreamState = z.infer<typeof WorkstreamStateSchema>;

/** `human` | `task:<TaskId>` | `schedule:<ScheduleId>` (02 Workstream.origin). */
export const WorkstreamOriginSchema = z.custom<
  "human" | `task:${string}` | `schedule:${string}`
>((value) => {
  if (value === "human") return true;
  if (typeof value !== "string") return false;
  const idx = value.indexOf(":");
  if (idx === -1) return false;
  const prefix = value.slice(0, idx);
  const id = value.slice(idx + 1);
  return (prefix === "task" || prefix === "schedule") && isValidUlid(id);
}, "Origin must be \"human\", \"task:<ulid>\" or \"schedule:<ulid>\"");
export type WorkstreamOrigin = z.infer<typeof WorkstreamOriginSchema>;

export const WorkstreamSchema = z.object({
  id: WorkstreamIdSchema,
  agent_id: AgentIdSchema,
  title: z.string().min(1),
  goal_md: z.string(),
  origin: WorkstreamOriginSchema,
  task_id: TaskIdSchema.nullable(),
  workspace_ref: WorkspaceRefSchema.nullable(),
  state: WorkstreamStateSchema,
  budget: BudgetSchema,
  engine_session_ref: z.string().nullable(),
  created_at: TimestampSchema,
  closed_at: TimestampSchema.nullable(),
});
export type Workstream = z.infer<typeof WorkstreamSchema>;

// --- Run ---

export const RunTriggerSchema = z.enum([
  "human_message",
  "agent_message",
  "task_assigned",
  "schedule",
  "resume",
  "approval_granted",
  /** E13 "drop in": one turn sent to an already-attached live interactive session,
   * distinct from a queued `human_message` reply. */
  "interactive_message",
]);
export type RunTrigger = z.infer<typeof RunTriggerSchema>;

export const RunStateSchema = z.enum([
  "queued",
  "starting",
  "running",
  "awaiting_input",
  "awaiting_approval",
  "completed",
  "failed",
  "interrupted",
  "cancelled",
]);
export type RunState = z.infer<typeof RunStateSchema>;

export const RunSchema = z.object({
  id: RunIdSchema,
  workstream_id: WorkstreamIdSchema,
  seq: z.number().int().positive(),
  trigger: RunTriggerSchema,
  input_context_ref: z.string().min(1),
  engine: z.string().min(1),
  engine_session_id: z.string().nullable(),
  state: RunStateSchema,
  result: RunResultSchema.nullable(),
  usage: UsageSchema.nullable(),
  started_at: TimestampSchema.nullable(),
  ended_at: TimestampSchema.nullable(),
  /** User-set display name for the conversation this run belongs to (a chain of runs
   * sharing an engine_session_id via resume). Null until explicitly renamed. */
  title: z.string().nullable(),
});
export type Run = z.infer<typeof RunSchema>;

// --- Task ---

export const TaskStateSchema = z.enum([
  "pending",
  "in_progress",
  "blocked",
  "delivered",
  "done",
  "rejected",
  "cancelled",
]);
export type TaskState = z.infer<typeof TaskStateSchema>;

export const TaskSchema = z.object({
  id: TaskIdSchema,
  parent_task_id: TaskIdSchema.nullable(),
  root_task_id: TaskIdSchema,
  depth: z.number().int().nonnegative(),
  delegator_actor_id: ActorIdSchema,
  assignee_agent_id: AgentIdSchema,
  routing_spec: RoutingSpecSchema.nullable(),
  spec_md: z.string().min(1),
  acceptance_criteria_md: z.string().min(1),
  budget: BudgetSchema,
  state: TaskStateSchema,
  deliverable_ref: DeliverableRefSchema.nullable(),
  accepted_by: ActorIdSchema.nullable(),
  accepted_at: TimestampSchema.nullable(),
  rejection_count: z.number().int().nonnegative().default(0),
  created_at: TimestampSchema,
  closed_at: TimestampSchema.nullable(),
});
export type Task = z.infer<typeof TaskSchema>;

// --- Message ---

export const MessageTypeSchema = z.enum([
  "question",
  "answer",
  "review_request",
  "review",
  "proposal",
  "status",
  "discovery",
  "escalation",
  "handover",
  "completion",
  "redirect",
]);
export type MessageType = z.infer<typeof MessageTypeSchema>;

export const MessageVisibilitySchema = z.enum(["normal", "surfaced"]);
export type MessageVisibility = z.infer<typeof MessageVisibilitySchema>;

export const MessageSchema = z
  .object({
    id: MessageIdSchema,
    thread_id: ThreadIdSchema,
    from_actor_id: ActorIdSchema,
    to_actor_id: ActorIdSchema.nullable(),
    to_team_id: TeamIdSchema.nullable(),
    type: MessageTypeSchema,
    body_md: z.string(),
    refs: z.array(RefSchema).default([]),
    disposition: z.string().min(1),
    disposition_ref: RefSchema.nullable(),
    visibility: MessageVisibilitySchema,
    created_at: TimestampSchema,
    resolved_at: TimestampSchema.nullable(),
  })
  .refine((m) => m.to_actor_id !== null || m.to_team_id !== null, {
    message: "Message must address to_actor_id or to_team_id",
  });
export type Message = z.infer<typeof MessageSchema>;

// --- Thread ---

export const ThreadAnchorTypeSchema = z.enum(["task", "workstream"]);
export type ThreadAnchorType = z.infer<typeof ThreadAnchorTypeSchema>;

export const ThreadSchema = z.object({
  id: ThreadIdSchema,
  anchor_type: ThreadAnchorTypeSchema,
  anchor_id: z.string().min(1),
  round_count: z.number().int().nonnegative(),
  created_at: TimestampSchema,
});
export type Thread = z.infer<typeof ThreadSchema>;

// --- Approval ---

export const ApprovalStateSchema = z.enum(["pending", "granted", "denied"]);
export type ApprovalState = z.infer<typeof ApprovalStateSchema>;

export const ApprovalSchema = z.object({
  id: ApprovalIdSchema,
  requested_by_actor: ActorIdSchema,
  kind: z.string().min(1),
  payload: z.unknown().optional(),
  state: ApprovalStateSchema,
  decided_by_actor: ActorIdSchema.nullable(),
  decided_at: TimestampSchema.nullable(),
  created_at: TimestampSchema,
});
export type Approval = z.infer<typeof ApprovalSchema>;

// --- Artifact ---

export const ArtifactSchema = z.object({
  id: ArtifactIdSchema,
  run_id: RunIdSchema,
  kind: z.string().min(1),
  path: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "Expected a lowercase hex sha256 digest"),
  size: z.number().int().nonnegative(),
  created_at: TimestampSchema,
});
export type Artifact = z.infer<typeof ArtifactSchema>;

// --- Event (base envelope; catalogue payload schemas live in events/catalogue.ts) ---

export const EntityTypeSchema = z.enum([
  "actor",
  "agent",
  "team",
  "workstream",
  "run",
  "task",
  "message",
  "thread",
  "approval",
  "artifact",
  "schedule",
  "policy",
  "system",
]);
export type EntityType = z.infer<typeof EntityTypeSchema>;

export const EventSchema = z.object({
  seq: z.number().int().positive(),
  ts: TimestampSchema,
  actor_id: ActorIdSchema.nullable(),
  entity_type: EntityTypeSchema,
  entity_id: z.string().min(1),
  type: z.string().min(1),
  payload: z.unknown(),
  run_id: RunIdSchema.nullable(),
  workstream_id: WorkstreamIdSchema.nullable(),
  task_id: TaskIdSchema.nullable(),
});
export type Event = z.infer<typeof EventSchema>;

// --- Schedule ---

export const ScheduleSchema = z.object({
  id: ScheduleIdSchema,
  agent_id: AgentIdSchema,
  cron: z.string().min(1),
  prompt_md: z.string().min(1),
  enabled: z.boolean(),
});
export type Schedule = z.infer<typeof ScheduleSchema>;
