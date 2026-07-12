/**
 * E1.3 — Event catalogue v1 (contracts.md "Data contracts"; 02/04/05/07 state changes).
 *
 * Every state change described in doc 02 and doc 04 has a typed event here, with a Zod
 * payload schema, grouped by the `agent_* / workstream_* / run_* / task_* / message_* /
 * approval_* / policy_* / system_*` prefixes contracts.md names. The catalogue is
 * additive-only from v1 onward (ADR/contracts) — never rename or remove a field/type;
 * add a new one and let consumers ignore what they don't recognise (`parseEventTolerant`).
 */
import { z } from "zod";
import {
  ActorIdSchema,
  AgentIdSchema,
  ApprovalIdSchema,
  RefSchema,
  RunIdSchema,
  TeamIdSchema,
  ThreadIdSchema,
} from "../ids.js";
import {
  BudgetSchema,
  DeliverableRefSchema,
  RunResultSchema,
  UsageSchema,
} from "../schemas/common.js";
import {
  MessageTypeSchema,
  RunTriggerSchema,
  WorkstreamOriginSchema,
} from "../schemas/entities.js";

export const EVENT_CATALOGUE_VERSION = 1;

interface EventCatalogueEntry<Payload extends z.ZodTypeAny = z.ZodTypeAny> {
  /** The `events.entity_type` this event is recorded against. */
  entityType:
    | "agent"
    | "workstream"
    | "run"
    | "task"
    | "message"
    | "thread"
    | "approval"
    | "policy"
    | "system";
  /** Catalogue version this type was introduced in — the catalogue only ever adds types. */
  since: number;
  payloadSchema: Payload;
}

function entry<Payload extends z.ZodTypeAny>(
  entityType: EventCatalogueEntry["entityType"],
  payloadSchema: Payload,
  since = EVENT_CATALOGUE_VERSION
): EventCatalogueEntry<Payload> {
  return { entityType, since, payloadSchema };
}

const EMPTY = z.object({}).strict();
const REASON_OPTIONAL = z.object({ reason: z.string().optional() }).strict();

export const EVENT_CATALOGUE = {
  // --- agent_* (02 Agent Lifecycle) ---
  agent_created: entry(
    "agent",
    z.object({
      name: z.string(),
      role: z.string(),
      team_id: TeamIdSchema.nullable(),
      engine_id: z.string(),
    })
  ),
  agent_activated: entry("agent", EMPTY),
  agent_suspended: entry("agent", REASON_OPTIONAL),
  agent_resumed: entry("agent", EMPTY),
  agent_retired: entry("agent", REASON_OPTIONAL),
  agent_charter_updated: entry(
    "agent",
    z.object({ version: z.number().int().positive(), edited_by_actor: ActorIdSchema })
  ),
  agent_engine_rebound: entry(
    "agent",
    z.object({ previous_engine_id: z.string(), new_engine_id: z.string() })
  ),

  // --- workstream_* (02 Workstream state semantics) ---
  workstream_created: entry(
    "workstream",
    z.object({ title: z.string(), origin: WorkstreamOriginSchema })
  ),
  workstream_activated: entry("workstream", EMPTY),
  workstream_waiting: entry("workstream", z.object({ waiting_on_ref: RefSchema.nullable() })),
  workstream_resumed: entry("workstream", EMPTY),
  workstream_blocked: entry("workstream", z.object({ reason: z.string() })),
  workstream_unblocked: entry("workstream", EMPTY),
  workstream_entered_review: entry("workstream", EMPTY),
  workstream_reopened: entry("workstream", REASON_OPTIONAL),
  workstream_closed: entry("workstream", EMPTY),
  workstream_archived: entry("workstream", EMPTY),

  // --- run_* (adapter-api EngineEvent + run state machine) ---
  run_queued: entry("run", z.object({ trigger: RunTriggerSchema, message_md: z.string().optional() })),
  run_started: entry("run", z.object({ engine: z.string() })),
  run_running: entry("run", z.object({ engine_session_id: z.string().nullable().optional() })),
  run_awaiting_input: entry("run", z.object({ prompt: z.string() })),
  run_awaiting_approval: entry("run", z.object({ approval_id: ApprovalIdSchema })),
  run_resumed: entry("run", z.object({ attempt: z.number().int().positive().optional() })),
  run_completed: entry("run", z.object({ result: RunResultSchema })),
  run_failed: entry("run", z.object({ error: z.string() })),
  run_interrupted: entry("run", REASON_OPTIONAL),
  run_cancelled: entry("run", REASON_OPTIONAL),
  run_usage_updated: entry("run", UsageSchema),
  run_tool_call: entry(
    "run",
    z.object({
      phase: z.enum(["start", "end"]),
      name: z.string(),
      detail: z.unknown().optional(),
    })
  ),
  run_output_delta: entry("run", z.object({ text: z.string() })),

  // --- task_* (02 Task + 04 delegation flow) ---
  task_created: entry(
    "task",
    z.object({
      title: z.string(),
      assignee_agent_id: AgentIdSchema,
      delegator_actor_id: ActorIdSchema,
      budget: BudgetSchema,
      depth: z.number().int().nonnegative(),
    })
  ),
  task_started: entry("task", EMPTY),
  task_blocked: entry("task", z.object({ reason: z.string() })),
  task_unblocked: entry("task", EMPTY),
  task_delivered: entry("task", z.object({ deliverable_ref: DeliverableRefSchema })),
  task_accepted: entry("task", z.object({ accepted_by: ActorIdSchema })),
  task_rejected: entry(
    "task",
    z.object({ reason: z.string(), rejection_count: z.number().int().nonnegative() })
  ),
  task_cancelled: entry("task", REASON_OPTIONAL),

  // --- message_* (04 message types + thread round cap) ---
  message_sent: entry(
    "message",
    z.object({
      type: MessageTypeSchema,
      from_actor_id: ActorIdSchema,
      to_actor_id: ActorIdSchema.nullable(),
      to_team_id: TeamIdSchema.nullable(),
      thread_id: ThreadIdSchema,
    })
  ),
  message_resolved: entry(
    "message",
    z.object({ disposition: z.string(), disposition_ref: RefSchema.nullable() })
  ),
  message_expired: entry("message", EMPTY),
  thread_round_cap_hit: entry(
    "thread",
    z.object({ thread_id: ThreadIdSchema, round_count: z.number().int().nonnegative() })
  ),

  // --- approval_* ---
  approval_requested: entry(
    "approval",
    z.object({ kind: z.string(), requested_by_actor: ActorIdSchema })
  ),
  approval_granted: entry("approval", z.object({ decided_by_actor: ActorIdSchema })),
  approval_denied: entry(
    "approval",
    z.object({ decided_by_actor: ActorIdSchema, reason: z.string().optional() })
  ),

  // --- policy_* ---
  policy_overridden: entry(
    "policy",
    z.object({
      scope: z.enum(["org", "team", "agent"]),
      scope_id: z.string().nullable(),
      changes: z.record(z.unknown()),
    })
  ),
  policy_rejected: entry(
    "policy",
    z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() })
  ),

  // --- system_* (07 failure modes F3/F7; 05 backup) ---
  system_started: entry("system", z.object({ version: z.string().optional() })),
  system_reconciled: entry(
    "system",
    z.object({
      runs_interrupted: z.number().int().nonnegative(),
      jobs_requeued: z.number().int().nonnegative(),
    })
  ),
  system_orphan_process_killed: entry(
    "system",
    z.object({ pid: z.number().int(), run_id: RunIdSchema.optional() })
  ),
  system_backup_completed: entry(
    "system",
    z.object({ path: z.string(), size_bytes: z.number().int().nonnegative() })
  ),
} as const satisfies Record<string, EventCatalogueEntry>;

export type EventType = keyof typeof EVENT_CATALOGUE;

export function isKnownEventType(type: string): type is EventType {
  return Object.prototype.hasOwnProperty.call(EVENT_CATALOGUE, type);
}

export function getEventPayloadSchema(type: string): z.ZodTypeAny | undefined {
  return isKnownEventType(type) ? EVENT_CATALOGUE[type].payloadSchema : undefined;
}

export function getEventEntityType(type: string): EventCatalogueEntry["entityType"] | undefined {
  return isKnownEventType(type) ? EVENT_CATALOGUE[type].entityType : undefined;
}

/** Validates payload against its catalogue schema. Throws on a known type with a bad payload. */
export function parseEventPayload(type: EventType, payload: unknown): unknown {
  return EVENT_CATALOGUE[type].payloadSchema.parse(payload);
}

export type TolerantEventParse =
  | { known: true; type: EventType; payload: unknown }
  | { known: false; type: string; payload: unknown };

/**
 * Unknown-type tolerance helper (E1.3 AC): consumers built against catalogue v1 must not
 * throw when they encounter a type added by a later, additive-only catalogue version —
 * they get the type name and raw payload back instead of a parsed/validated shape.
 */
export function parseEventTolerant(type: string, payload: unknown): TolerantEventParse {
  if (!isKnownEventType(type)) {
    return { known: false, type, payload };
  }
  return { known: true, type, payload: parseEventPayload(type, payload) };
}

/** One row per catalogue entry — the source contracts.md calls "auto-generated from schemas". */
export function generateCatalogueMarkdown(): string {
  const rows = Object.entries(EVENT_CATALOGUE)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, e]) => `| \`${type}\` | ${e.entityType} | ${e.since} |`);
  return [
    `# Event Catalogue (v${EVENT_CATALOGUE_VERSION})`,
    "",
    "Auto-generated from `@foundry/core` event schemas. Do not hand-edit.",
    "",
    "| Type | Entity | Introduced |",
    "|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}
