/** E2.5 — costRollup(scope): sums workstream budget spend at org/team/agent/workstream granularity. */
import type { AgentId, Budget, TeamId, WorkstreamId } from "@foundry/core";
import type { Db } from "../db/connection.js";
import { fromJson } from "../row-mapping.js";

export type CostScope =
  | { level: "org" }
  | { level: "team"; team_id: TeamId }
  | { level: "agent"; agent_id: AgentId }
  | { level: "workstream"; workstream_id: WorkstreamId };

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

interface WorkstreamCostRow {
  id: string;
  title: string;
  agent_id: string;
  budget_json: string;
}

function loadWorkstreamCostRows(db: Db, scope: CostScope): WorkstreamCostRow[] {
  switch (scope.level) {
    case "org":
      return db.prepare(`SELECT id, title, agent_id, budget_json FROM workstreams`).all() as WorkstreamCostRow[];
    case "team":
      return db
        .prepare(
          `SELECT w.id, w.title, w.agent_id, w.budget_json FROM workstreams w
           JOIN agents a ON a.id = w.agent_id WHERE a.team_id = ?`
        )
        .all(scope.team_id) as WorkstreamCostRow[];
    case "agent":
      return db
        .prepare(`SELECT id, title, agent_id, budget_json FROM workstreams WHERE agent_id = ?`)
        .all(scope.agent_id) as WorkstreamCostRow[];
    case "workstream":
      return db
        .prepare(`SELECT id, title, agent_id, budget_json FROM workstreams WHERE id = ?`)
        .all(scope.workstream_id) as WorkstreamCostRow[];
  }
}

export function costRollup(db: Db, scope: CostScope): CostReport {
  const rows = loadWorkstreamCostRows(db, scope);
  let spent_usd = 0;
  let spent_tokens = 0;
  let limit_usd: number | null = 0;
  let limit_tokens: number | null = 0;
  const breakdown: CostBreakdownEntry[] = [];

  for (const row of rows) {
    const budget = fromJson<Budget>(row.budget_json, {
      limit_usd: null,
      limit_tokens: null,
      spent_usd: 0,
      spent_tokens: 0,
    });
    spent_usd += budget.spent_usd;
    spent_tokens += budget.spent_tokens;
    if (budget.limit_usd === null) limit_usd = null;
    else if (limit_usd !== null) limit_usd += budget.limit_usd;
    if (budget.limit_tokens === null) limit_tokens = null;
    else if (limit_tokens !== null) limit_tokens += budget.limit_tokens;
    breakdown.push({ label: row.title, spent_usd: budget.spent_usd, spent_tokens: budget.spent_tokens });
  }

  return { scope, spent_usd, spent_tokens, limit_usd, limit_tokens, breakdown };
}
