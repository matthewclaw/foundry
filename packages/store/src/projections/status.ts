/**
 * E2.5 ⚠ KEYSTONE — Agent status derivation (02 "Status (derived, real-time)", ADR-008:
 * exactly one definition of agent status, and it lives here). `deriveAgentStatus` is a
 * pure function over pre-gathered facts so the precedence table can be tested case by
 * case without touching SQLite; `computeAgentStatusFacts` is the only place that turns
 * live rows into those facts.
 */
import type { AgentId } from "@foundry/core";
import type { Db } from "../db/connection.js";

export type AgentStatus = "blocked" | "degraded" | "waiting" | "active" | "over-committed" | "idle";

export interface AgentStatusFacts {
  /** ≥1 open workstream or task belonging to the agent is `blocked`. */
  hasBlockedWorkstreamOrTask: boolean;
  /** Count of the agent's most-recently-ended runs that failed, before hitting a non-failure. */
  recentConsecutiveFailures: number;
  /** ≥1 run in `running`/`starting` across the agent's workstreams. */
  hasRunningOrStartingRun: boolean;
  /** ≥1 workstream `waiting` (on approval, answer, or dependency). */
  hasWaitingWorkstream: boolean;
  /** Open workstreams + open tasks assigned to the agent. */
  openCommitmentCount: number;
  /** Policy threshold above which openCommitmentCount reads as over-committed (E6 supplies the real per-agent value; this is a fixed default until then). */
  overCommittedThreshold: number;
}

/** Doc-02 precedence: blocked > degraded > waiting > active > over-committed > idle. */
export function deriveAgentStatus(facts: AgentStatusFacts): AgentStatus {
  if (facts.hasBlockedWorkstreamOrTask) return "blocked";
  if (facts.recentConsecutiveFailures >= 2) return "degraded";
  if (facts.hasWaitingWorkstream && !facts.hasRunningOrStartingRun) return "waiting";
  if (facts.hasRunningOrStartingRun) return "active";
  if (facts.openCommitmentCount > facts.overCommittedThreshold) return "over-committed";
  return "idle";
}

/** Precedence rank for "worst status wins" team roll-ups — lower is worse. */
const STATUS_RANK: Record<AgentStatus, number> = {
  blocked: 0,
  degraded: 1,
  waiting: 2,
  active: 3,
  "over-committed": 4,
  idle: 5,
};

export function worstStatus(statuses: readonly AgentStatus[]): AgentStatus {
  return statuses.reduce((worst, s) => (STATUS_RANK[s] < STATUS_RANK[worst] ? s : worst), "idle" as AgentStatus);
}

const OPEN_WORKSTREAM_STATES = ["open", "active", "waiting", "blocked", "review"];
const OPEN_RUN_STATES = ["queued", "starting", "running", "awaiting_input", "awaiting_approval"];
const OPEN_TASK_STATES = ["pending", "in_progress", "blocked"];

export function computeAgentStatusFacts(
  db: Db,
  agentId: AgentId,
  overCommittedThreshold = 5
): AgentStatusFacts {
  const workstreams = db
    .prepare(
      `SELECT state FROM workstreams WHERE agent_id = ? AND state IN (${OPEN_WORKSTREAM_STATES.map(() => "?").join(",")})`
    )
    .all(agentId, ...OPEN_WORKSTREAM_STATES) as { state: string }[];

  const tasks = db
    .prepare(
      `SELECT state FROM tasks WHERE assignee_agent_id = ? AND state IN (${OPEN_TASK_STATES.map(() => "?").join(",")})`
    )
    .all(agentId, ...OPEN_TASK_STATES) as { state: string }[];

  const hasBlockedWorkstreamOrTask =
    workstreams.some((w) => w.state === "blocked") || tasks.some((t) => t.state === "blocked");
  const hasWaitingWorkstream = workstreams.some((w) => w.state === "waiting");

  const openRuns = db
    .prepare(
      `SELECT r.state FROM runs r JOIN workstreams w ON w.id = r.workstream_id
       WHERE w.agent_id = ? AND r.state IN (${OPEN_RUN_STATES.map(() => "?").join(",")})`
    )
    .all(agentId, ...OPEN_RUN_STATES) as { state: string }[];
  const hasRunningOrStartingRun = openRuns.some((r) => r.state === "running" || r.state === "starting");

  const recentRuns = db
    .prepare(
      `SELECT r.state FROM runs r JOIN workstreams w ON w.id = r.workstream_id
       WHERE w.agent_id = ? AND r.state IN ('completed', 'failed') ORDER BY r.ended_at DESC LIMIT 10`
    )
    .all(agentId) as { state: string }[];
  let recentConsecutiveFailures = 0;
  for (const run of recentRuns) {
    if (run.state === "failed") recentConsecutiveFailures++;
    else break;
  }

  return {
    hasBlockedWorkstreamOrTask,
    recentConsecutiveFailures,
    hasRunningOrStartingRun,
    hasWaitingWorkstream,
    openCommitmentCount: workstreams.length + tasks.length,
    overCommittedThreshold,
  };
}

export function getAgentStatus(db: Db, agentId: AgentId, overCommittedThreshold?: number): AgentStatus {
  return deriveAgentStatus(computeAgentStatusFacts(db, agentId, overCommittedThreshold));
}
