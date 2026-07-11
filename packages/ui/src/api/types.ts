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
  relationships: { actor_id: string; weight: number; last_interaction_at: string }[];
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
  };
  events: { seq: number; type: string; payload: unknown }[];
  transcriptText: string | null;
  transcriptSource: "live" | "file" | "none";
}

export interface Timeline {
  workstreamId: string;
  runs: TimelineRunEntry[];
}

/** Event shape on the SSE feed (core EventSchema, minimally). */
export interface FeedEvent {
  seq: number;
  ts: string;
  type: string;
  entity_type: string;
  entity_id: string;
  payload: unknown;
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
