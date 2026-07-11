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

/** Event shape on the SSE feed (core EventSchema, minimally). */
export interface FeedEvent {
  seq: number;
  ts: string;
  type: string;
  entity_type: string;
  entity_id: string;
  payload: unknown;
}
