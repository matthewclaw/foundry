/**
 * E1.2 — State-machine transition tables for agent, workstream, run, task, and
 * message-disposition (02-domain-model.md, 04-communication-and-delegation.md).
 *
 * One implementation, consumed by store and server alike (contracts.md). Every
 * transition names the event type that emits it (events/catalogue.ts defines the
 * payload schema for each).
 */
import type { AgentState, MessageType, RunState, TaskState, WorkstreamState } from "../schemas/entities.js";

interface Transition<S extends string> {
  from: S;
  to: S;
  event: string;
}

function buildLookup<S extends string>(
  transitions: readonly Transition<S>[]
): Map<S, Map<S, string>> {
  const lookup = new Map<S, Map<S, string>>();
  for (const t of transitions) {
    if (!lookup.has(t.from)) lookup.set(t.from, new Map());
    lookup.get(t.from)!.set(t.to, t.event);
  }
  return lookup;
}

// --- Agent (02 Agent Lifecycle) ---
//   draft --create--> active <--suspend/resume--> suspended
//                        \--retire--> retired

export const AGENT_STATES: readonly AgentState[] = ["draft", "active", "suspended", "retired"];

export const AGENT_TRANSITIONS: readonly Transition<AgentState>[] = [
  { from: "draft", to: "active", event: "agent_activated" },
  { from: "active", to: "suspended", event: "agent_suspended" },
  { from: "suspended", to: "active", event: "agent_resumed" },
  { from: "active", to: "retired", event: "agent_retired" },
];

// --- Workstream (02: open -> active <-> waiting -> blocked -> review -> closed -> archived) ---
// `close` is callable at any open state (API contracts.md `POST /workstreams/:id/close`
// has no state precondition); `blocked` is reachable from active or waiting (both are
// running states that can discover a blocker); `review` can bounce back to `active`
// when a delegator rejects the delivered work (04).

export const WORKSTREAM_STATES: readonly WorkstreamState[] = [
  "open",
  "active",
  "waiting",
  "blocked",
  "review",
  "closed",
  "archived",
];

export const WORKSTREAM_TRANSITIONS: readonly Transition<WorkstreamState>[] = [
  { from: "open", to: "active", event: "workstream_activated" },
  { from: "active", to: "waiting", event: "workstream_waiting" },
  { from: "waiting", to: "active", event: "workstream_resumed" },
  { from: "active", to: "blocked", event: "workstream_blocked" },
  { from: "waiting", to: "blocked", event: "workstream_blocked" },
  { from: "blocked", to: "active", event: "workstream_unblocked" },
  { from: "active", to: "review", event: "workstream_entered_review" },
  { from: "review", to: "active", event: "workstream_reopened" },
  { from: "review", to: "closed", event: "workstream_closed" },
  { from: "open", to: "closed", event: "workstream_closed" },
  { from: "active", to: "closed", event: "workstream_closed" },
  { from: "waiting", to: "closed", event: "workstream_closed" },
  { from: "blocked", to: "closed", event: "workstream_closed" },
  { from: "closed", to: "archived", event: "workstream_archived" },
];

// --- Run (adapter-api / contracts.md run state enum) ---

export const RUN_STATES: readonly RunState[] = [
  "queued",
  "starting",
  "running",
  "awaiting_input",
  "awaiting_approval",
  "completed",
  "failed",
  "interrupted",
  "cancelled",
];

export const RUN_TRANSITIONS: readonly Transition<RunState>[] = [
  { from: "queued", to: "starting", event: "run_started" },
  { from: "queued", to: "cancelled", event: "run_cancelled" },
  { from: "starting", to: "running", event: "run_running" },
  { from: "starting", to: "failed", event: "run_failed" },
  { from: "starting", to: "cancelled", event: "run_cancelled" },
  { from: "running", to: "awaiting_input", event: "run_awaiting_input" },
  { from: "running", to: "awaiting_approval", event: "run_awaiting_approval" },
  { from: "running", to: "completed", event: "run_completed" },
  { from: "running", to: "failed", event: "run_failed" },
  { from: "running", to: "interrupted", event: "run_interrupted" },
  { from: "running", to: "cancelled", event: "run_cancelled" },
  { from: "awaiting_input", to: "running", event: "run_resumed" },
  { from: "awaiting_input", to: "interrupted", event: "run_interrupted" },
  { from: "awaiting_input", to: "cancelled", event: "run_cancelled" },
  { from: "awaiting_approval", to: "running", event: "run_resumed" },
  { from: "awaiting_approval", to: "interrupted", event: "run_interrupted" },
  { from: "awaiting_approval", to: "cancelled", event: "run_cancelled" },
  // F1/F3: interrupted runs auto-resume once when the engine supports sessions.
  { from: "interrupted", to: "starting", event: "run_resumed" },
];

// --- Task (02 Task + 04 delegation flow) ---

export const TASK_STATES: readonly TaskState[] = [
  "pending",
  "in_progress",
  "blocked",
  "delivered",
  "done",
  "rejected",
  "cancelled",
];

export const TASK_TRANSITIONS: readonly Transition<TaskState>[] = [
  { from: "pending", to: "in_progress", event: "task_started" },
  { from: "in_progress", to: "blocked", event: "task_blocked" },
  { from: "blocked", to: "in_progress", event: "task_unblocked" },
  { from: "in_progress", to: "delivered", event: "task_delivered" },
  { from: "delivered", to: "done", event: "task_accepted" },
  { from: "delivered", to: "rejected", event: "task_rejected" },
  // Rejected work returns to the assignee for a new attempt (04), bounded by
  // policy.max_rejections and then escalated (F12) — escalation is a message
  // side-effect, not a further task-state transition.
  { from: "rejected", to: "in_progress", event: "task_started" },
  { from: "pending", to: "cancelled", event: "task_cancelled" },
  { from: "in_progress", to: "cancelled", event: "task_cancelled" },
  { from: "blocked", to: "cancelled", event: "task_cancelled" },
  { from: "delivered", to: "cancelled", event: "task_cancelled" },
  { from: "rejected", to: "cancelled", event: "task_cancelled" },
];

// --- Message disposition (04 message types table) ---
// `answer`, `status`, `discovery`, and `redirect` carry no disposition life cycle —
// they are always `none` and never transition (informational/one-shot by design).

export const MESSAGE_DISPOSITION_STATES: readonly string[] = [
  "none",
  "open",
  "answered",
  "withdrawn",
  "expired",
  "reviewed",
  "declined",
  "accepted",
  "rejected",
  "resolved",
];

const MESSAGE_DISPOSITION_TRANSITIONS: Readonly<Record<MessageType, readonly Transition<string>[]>> = {
  question: [
    { from: "open", to: "answered", event: "message_resolved" },
    { from: "open", to: "withdrawn", event: "message_resolved" },
    { from: "open", to: "expired", event: "message_expired" },
  ],
  review_request: [
    { from: "open", to: "reviewed", event: "message_resolved" },
    { from: "open", to: "declined", event: "message_resolved" },
    { from: "open", to: "expired", event: "message_expired" },
  ],
  proposal: [
    { from: "open", to: "accepted", event: "message_resolved" },
    { from: "open", to: "rejected", event: "message_resolved" },
    { from: "open", to: "expired", event: "message_expired" },
  ],
  escalation: [{ from: "open", to: "resolved", event: "message_resolved" }],
  handover: [{ from: "open", to: "accepted", event: "message_resolved" }],
  completion: [
    { from: "open", to: "accepted", event: "message_resolved" },
    { from: "open", to: "rejected", event: "message_resolved" },
  ],
  // `answer` and `review` close another message's disposition (question/review_request)
  // rather than carrying one of their own — same shape as `status`/`discovery`/`redirect`.
  answer: [],
  review: [],
  status: [],
  discovery: [],
  redirect: [],
};

/** The disposition a freshly-sent message of this type starts in. */
export function initialDisposition(messageType: MessageType): string {
  return MESSAGE_DISPOSITION_TRANSITIONS[messageType].length > 0 ? "open" : "none";
}

export function canTransitionDisposition(
  messageType: MessageType,
  from: string,
  to: string
): boolean {
  return MESSAGE_DISPOSITION_TRANSITIONS[messageType].some(
    (t) => t.from === from && t.to === to
  );
}

export function dispositionTransitionEvent(
  messageType: MessageType,
  from: string,
  to: string
): string | undefined {
  return MESSAGE_DISPOSITION_TRANSITIONS[messageType].find(
    (t) => t.from === from && t.to === to
  )?.event;
}

// --- Generic canTransition(entity, from, to) surface (contracts.md `@foundry/core`) ---

const REGISTRY = {
  agent: { states: AGENT_STATES, lookup: buildLookup(AGENT_TRANSITIONS) },
  workstream: { states: WORKSTREAM_STATES, lookup: buildLookup(WORKSTREAM_TRANSITIONS) },
  run: { states: RUN_STATES, lookup: buildLookup(RUN_TRANSITIONS) },
  task: { states: TASK_STATES, lookup: buildLookup(TASK_TRANSITIONS) },
} as const;

export type StateMachineEntity = keyof typeof REGISTRY;

export function statesFor(entity: StateMachineEntity): readonly string[] {
  return REGISTRY[entity].states;
}

export function canTransition(entity: StateMachineEntity, from: string, to: string): boolean {
  return REGISTRY[entity].lookup.get(from as never)?.has(to as never) ?? false;
}

export function transitionEvent(
  entity: StateMachineEntity,
  from: string,
  to: string
): string | undefined {
  return REGISTRY[entity].lookup.get(from as never)?.get(to as never);
}

/** States with no outgoing transitions in the table — dead ends by design, not omission. */
export function terminalStates(entity: StateMachineEntity): readonly string[] {
  const { states, lookup } = REGISTRY[entity];
  return states.filter((s) => (lookup.get(s as never)?.size ?? 0) === 0);
}

export function reachableStatesFrom(
  entity: StateMachineEntity,
  from: string
): ReadonlySet<string> {
  return new Set(REGISTRY[entity].lookup.get(from as never)?.keys() ?? []);
}
