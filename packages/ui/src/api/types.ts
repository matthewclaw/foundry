/**
 * E7.1 — Minimal API DTO shapes, hand-copied from the store projections
 * (packages/store/src/projections/{orgView,status,inbox}.ts).
 * L4 rule (contracts.md): ui may import @foundry/core types only, never @foundry/store.
 */
import type { AgentId, TeamId, AgentState } from "@foundry/core";

export type AgentStatus = "blocked" | "degraded" | "waiting" | "active" | "over-committed" | "idle";

export interface OrgViewAgent {
  id: AgentId;
  name: string;
  role: string;
  team_id: TeamId | null;
  state: AgentState;
  status: AgentStatus;
  /**
   * doc-06 asks for a "currently: …" line and burn text per agent, but the store's
   * orgView projection does not provide them yet (reported upstream, not invented).
   * Rendered if/when the API starts sending them.
   */
  currently?: string;
  spend_usd?: number;
}

export interface OrgViewTeam {
  id: TeamId;
  name: string;
  agents: OrgViewAgent[];
  /** Worst status among the team's agents (worst-of roll-up). */
  status: AgentStatus;
}

export interface OrgView {
  teams: OrgViewTeam[];
  unassignedAgents: OrgViewAgent[];
}

/** From packages/store/src/projections/inbox.ts. */
export interface InboxItem {
  kind: "approval_pending" | "message_surfaced";
  ref: string;
  created_at: string;
  summary: string;
}

/**
 * E7.3 — GET /api/agents/:id returns the store's agentPage projection
 * (packages/store/src/projections/agentPage.ts). Only the fields the UI renders
 * are typed here; `charter` is absent in JSON when the projection has none.
 */
export interface AgentPageDto {
  agent: {
    id: AgentId;
    name: string;
    role: string;
    team_id: TeamId | null;
    state: AgentState;
    engine: { id: string };
  };
  charter?: { version: number; body_md: string };
  status: AgentStatus;
  workstreams: { id: string; title: string; state: string }[];
  openTasks: { id: string; spec_md: string; state: string }[];
  relationships: {
    actor_id: string;
    weight: number;
    last_interaction_at: string;
    counterpart_name: string;
    counterpart_kind: string;
    counterpart_agent_id: string | null;
  }[];
}

/**
 * E7.4 — GET /api/workstreams/:id/timeline
 * (packages/store/src/projections/workstreamTimeline.ts). transcriptSource is the
 * ADR-003 capability-degradation tag: "live" (from events), "file" (compacted), "none".
 */
export interface TimelineRunEntry {
  run: {
    id: string;
    seq: number;
    trigger: string;
    state: string;
    started_at: string | null;
    ended_at: string | null;
    usage: { cost_usd?: number; tokens_in?: number; tokens_out?: number } | null;
    /** engine_session_id — consecutive runs sharing one are the same conversation
     * (see groupIntoConversations in WorkstreamView.tsx). */
    engine_session_id?: string | null;
    /** User-set display name for the conversation this run belongs to. */
    title?: string | null;
  };
  events: { seq: number; type: string; payload: unknown }[];
  transcriptText: string | null;
  transcriptSource: "live" | "file" | "none";
}

/** Header for the timeline view — real title/goal/agent so the page isn't just a ULID. */
export interface TimelineHeader {
  id: string;
  title: string;
  goal_md: string;
  state: string;
  agent: { id: string; name: string } | null;
}

export interface Timeline {
  workstreamId: string;
  workstream: TimelineHeader | null;
  runs: TimelineRunEntry[];
}

/** Event shape on the SSE feed (core EventSchema — packages/core/src/schemas/entities.ts). */
export interface FeedEvent {
  seq: number;
  ts: string;
  type: string;
  entity_type: string;
  entity_id: string;
  payload: unknown;
  actor_id: string | null;
  run_id: string | null;
  workstream_id: string | null;
  task_id: string | null;
}

/** E10.3 — Cost report for an org/team/agent/workstream scope. */
export type CostScope =
  | { level: "org" }
  | { level: "team"; team_id: string }
  | { level: "agent"; agent_id: string }
  | { level: "workstream"; workstream_id: string };

export interface CostBreakdownEntry {
  label: string;
  spent_usd: number;
  spent_tokens: number;
}

export interface CostReport {
  scope: CostScope;
  spent_usd: number;
  spent_tokens: number;
  limit_usd: number | null;
  limit_tokens: number | null;
  breakdown: CostBreakdownEntry[];
}

/** E10.2 — Task tree view (GET /api/tasks/:id/tree). */
export type TaskState = "pending" | "in_progress" | "blocked" | "delivered" | "done" | "rejected" | "cancelled";

export interface TaskDto {
  id: string;
  parent_task_id: string | null;
  root_task_id: string;
  depth: number;
  delegator_actor_id: string;
  assignee_agent_id: string;
  spec_md: string;
  acceptance_criteria_md: string;
  budget: { limit_usd: number | null; limit_tokens: number | null; spent_usd: number; spent_tokens: number };
  state: TaskState;
  rejection_count: number;
  created_at: string;
  closed_at: string | null;
}

export interface TreeNode {
  task: TaskDto;
  children: TreeNode[];
}

export interface TreeView {
  root: TreeNode | undefined;
}

/**
 * Claude Code's own on-disk session transcripts, browsed read-only (GET
 * /api/claude-sessions, packages/server/src/claudeSessions/discover.ts) — entirely
 * separate from Foundry's own runs/workstreams.
 */
export interface ClaudeSessionSummaryDto {
  id: string;
  filePath: string;
  startedAtMs: number | null;
  mtimeMs: number;
  sizeBytes: number;
  preview: string | null;
}

export interface ClaudeSessionGroupDto {
  projectDir: string;
  repoPath: string;
  repoPathResolved: boolean;
  lastActiveAtMs: number;
  sessions: ClaudeSessionSummaryDto[];
}

export interface ClaudeSessionTurnDto {
  role: "user" | "assistant";
  text: string;
  timestamp: string | null;
}

export interface ClaudeSessionDetailDto {
  id: string;
  projectDir: string;
  mtimeMs: number;
  sizeBytes: number;
  turns: ClaudeSessionTurnDto[];
}
