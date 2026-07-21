/** Exhaustive fixtures — one concrete, valid instance per entity, for round-trip and schema tests. */
import {
  newActorId,
  newAgentId,
  newApprovalId,
  newArtifactId,
  newMessageId,
  newRunId,
  newScheduleId,
  newTaskId,
  newTeamId,
  newThreadId,
  newWorkstreamId,
} from "../ids.js";
import type {
  Actor,
  Agent,
  AgentCharter,
  Approval,
  Artifact,
  Event,
  Message,
  Run,
  Schedule,
  Task,
  Team,
  Thread,
  Workstream,
} from "./entities.js";

const NOW = "2026-07-09T12:00:00.000Z";

export const humanActorId = newActorId();
export const agentActorId = newActorId();
export const agentId = newAgentId();
export const teamId = newTeamId();
export const workstreamId = newWorkstreamId();
export const runId = newRunId();
export const taskId = newTaskId();
export const messageId = newMessageId();
export const threadId = newThreadId();
export const approvalId = newApprovalId();
export const artifactId = newArtifactId();
export const scheduleId = newScheduleId();

export const humanActorFixture: Actor = {
  id: humanActorId,
  kind: "human",
  display_name: "Matthew",
  created_at: NOW,
};

export const agentActorFixture: Actor = {
  id: agentActorId,
  kind: "agent",
  display_name: "Orbit Backend Engineer",
  created_at: NOW,
};

export const teamFixture: Team = {
  id: teamId,
  name: "Backend",
  description: "Server-side specialists",
  default_policy: { max_depth: 3 },
  default_workspace_ref: null,
};

export const agentFixture: Agent = {
  id: agentId,
  actor_id: agentActorId,
  name: "Orbit Backend Engineer",
  role: "backend-engineer",
  avatar_color: "#4477AA",
  team_id: teamId,
  charter_version: 1,
  engine: { id: "claude-code", config: { model: "default" } },
  memory_ref: "agents/" + agentId + "/memory",
  default_workspace_ref: { kind: "plain_dir", path: "/repos/foundry" },
  policy_overrides: {},
  state: "active",
  created_at: NOW,
  retired_at: null,
};

export const agentCharterFixture: AgentCharter = {
  agent_id: agentId,
  version: 1,
  body_md: "# Purpose\n\nBuild and maintain backend services.",
  edited_by_actor: humanActorId,
  created_at: NOW,
};

export const workstreamFixture: Workstream = {
  id: workstreamId,
  agent_id: agentId,
  title: "Authentication Refactor",
  goal_md: "Replace session cookies with signed JWTs.",
  origin: "human",
  task_id: null,
  workspace_ref: { kind: "plain_dir", path: "/repos/foundry" },
  state: "active",
  budget: { limit_usd: 25, limit_tokens: null, spent_usd: 1.2, spent_tokens: 10000 },
  engine_session_ref: null,
  created_at: NOW,
  closed_at: null,
};

export const runFixture: Run = {
  id: runId,
  workstream_id: workstreamId,
  seq: 1,
  trigger: "human_message",
  input_context_ref: "runs/" + runId + "/context.md",
  engine: "claude-code",
  engine_session_id: null,
  state: "running",
  result: null,
  usage: { tokens_in: 1000, tokens_out: 200 },
  started_at: NOW,
  ended_at: null,
  title: null,
};

export const taskFixture: Task = {
  id: taskId,
  parent_task_id: null,
  root_task_id: taskId,
  depth: 0,
  delegator_actor_id: humanActorId,
  assignee_agent_id: agentId,
  routing_spec: null,
  spec_md: "Fix bug #482",
  acceptance_criteria_md: "- [ ] Repro no longer occurs\n- [ ] Test added",
  budget: { limit_usd: 10, limit_tokens: null, spent_usd: 0, spent_tokens: 0 },
  state: "pending",
  deliverable_ref: null,
  accepted_by: null,
  accepted_at: null,
  rejection_count: 0,
  created_at: NOW,
  closed_at: null,
};

export const messageFixture: Message = {
  id: messageId,
  thread_id: threadId,
  from_actor_id: agentActorId,
  to_actor_id: humanActorId,
  to_team_id: null,
  type: "question",
  body_md: "Should I use JWTs or opaque tokens?",
  refs: [],
  disposition: "open",
  disposition_ref: null,
  visibility: "surfaced",
  created_at: NOW,
  resolved_at: null,
};

export const threadFixture: Thread = {
  id: threadId,
  anchor_type: "workstream",
  anchor_id: workstreamId,
  round_count: 1,
  created_at: NOW,
};

export const approvalFixture: Approval = {
  id: approvalId,
  requested_by_actor: agentActorId,
  kind: "budget_increase",
  payload: { requested_usd: 50 },
  state: "pending",
  decided_by_actor: null,
  decided_at: null,
  created_at: NOW,
};

export const artifactFixture: Artifact = {
  id: artifactId,
  run_id: runId,
  kind: "diff",
  path: "artifacts/ab/cdef.../diff.patch",
  sha256: "a".repeat(64),
  size: 1024,
  created_at: NOW,
};

export const eventFixture: Event = {
  seq: 1,
  ts: NOW,
  actor_id: humanActorId,
  entity_type: "task",
  entity_id: taskId,
  type: "task_created",
  payload: { title: "Fix bug #482" },
  run_id: null,
  workstream_id: null,
  task_id: taskId,
};

export const scheduleFixture: Schedule = {
  id: scheduleId,
  agent_id: agentId,
  cron: "0 9 * * MON",
  prompt_md: "Review the backlog and report status.",
  enabled: true,
};
