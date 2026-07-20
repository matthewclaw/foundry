/** E2.5 — agentPage(): charter, derived status, workstreams, open tasks, relationships (02). */
import type { Agent, AgentCharter, AgentId, ActorId, Task, Workstream } from "@foundry/core";
import type { Db } from "../db/connection.js";
import { rowToAgent, type AgentRow } from "../mutations/agents.js";
import { rowToWorkstream, type WorkstreamRow } from "../mutations/workstreams.js";
import { rowToTask, type TaskRow } from "../mutations/tasks.js";
import { getAgentStatus, type AgentStatus } from "./status.js";

export interface RelationshipSummary {
  actor_id: ActorId;
  /** Interaction count across tasks (as delegator/assignee) and messages (from/to) involving this actor. */
  weight: number;
  last_interaction_at: string;
  /** Human-readable counterpart: the agent's name, or the actor's display_name (e.g. the human). */
  counterpart_name: string;
  /** The counterpart's kind (e.g. "agent", "human") — for a label when there's nothing to link to. */
  counterpart_kind: string;
  /** The counterpart agent's id when the actor is an agent, so the UI can link to its page; null otherwise. */
  counterpart_agent_id: AgentId | null;
}

export interface AgentPage {
  agent: Agent;
  charter: AgentCharter | undefined;
  status: AgentStatus;
  workstreams: Workstream[];
  openTasks: Task[];
  relationships: RelationshipSummary[];
}

export function agentPage(db: Db, agentId: AgentId): AgentPage | undefined {
  const agentRow = db.prepare(`SELECT * FROM agents WHERE id = ?`).get(agentId) as AgentRow | undefined;
  if (!agentRow) return undefined;
  const agent = rowToAgent(agentRow);

  const charterRow = db
    .prepare(`SELECT * FROM agent_charters WHERE agent_id = ? ORDER BY version DESC LIMIT 1`)
    .get(agentId) as
    | { agent_id: string; version: number; body_md: string; edited_by_actor: string; created_at: string }
    | undefined;
  const charter: AgentCharter | undefined = charterRow
    ? {
        agent_id: charterRow.agent_id as AgentCharter["agent_id"],
        version: charterRow.version,
        body_md: charterRow.body_md,
        edited_by_actor: charterRow.edited_by_actor as AgentCharter["edited_by_actor"],
        created_at: charterRow.created_at,
      }
    : undefined;

  const workstreamRows = db
    .prepare(`SELECT * FROM workstreams WHERE agent_id = ? ORDER BY created_at DESC`)
    .all(agentId) as WorkstreamRow[];
  const workstreams = workstreamRows.map(rowToWorkstream);

  const taskRows = db
    .prepare(
      `SELECT * FROM tasks WHERE assignee_agent_id = ? AND state IN ('pending','in_progress','blocked') ORDER BY created_at`
    )
    .all(agentId) as TaskRow[];
  const openTasks = taskRows.map(rowToTask);

  // Relationships (02): "computed from tasks and messages, weighted by recency and
  // volume" — kept to a simple, honest interpretation: count of interactions per
  // counterpart actor, most recent interaction as the tiebreak/decay signal.
  // tasks.assignee_agent_id is an AgentId, not an ActorId — the second branch joins
  // through `agents` to translate the counterpart back to its actor id.
  const taskRelRows = db
    .prepare(
      `SELECT delegator_actor_id AS actor_id, created_at FROM tasks WHERE assignee_agent_id = ?
       UNION ALL
       SELECT a.actor_id AS actor_id, t.created_at AS created_at FROM tasks t
         JOIN agents a ON a.id = t.assignee_agent_id WHERE t.delegator_actor_id = ?`
    )
    .all(agentId, agent.actor_id) as { actor_id: string; created_at: string }[];
  const messageRelRows = db
    .prepare(
      `SELECT to_actor_id AS actor_id, created_at FROM messages WHERE from_actor_id = ? AND to_actor_id IS NOT NULL
       UNION ALL
       SELECT from_actor_id AS actor_id, created_at FROM messages WHERE to_actor_id = ?`
    )
    .all(agent.actor_id, agent.actor_id) as { actor_id: string; created_at: string }[];

  const byActor = new Map<string, { weight: number; last: string }>();
  for (const row of [...taskRelRows, ...messageRelRows]) {
    if (row.actor_id === agent.actor_id) continue; // self-delegation noise, if any
    const existing = byActor.get(row.actor_id) ?? { weight: 0, last: row.created_at };
    existing.weight += 1;
    if (row.created_at > existing.last) existing.last = row.created_at;
    byActor.set(row.actor_id, existing);
  }
  // Resolve each counterpart actor to a name (and, if it's an agent, its id to link to) —
  // a bare actor id is unreadable and unnavigable. LEFT JOIN so non-agent actors (the
  // human) still resolve via actors.display_name with a null agent id.
  const resolveActor = db.prepare(
    `SELECT ac.kind, ac.display_name, ag.id AS agent_id, ag.name AS agent_name
       FROM actors ac LEFT JOIN agents ag ON ag.actor_id = ac.id
      WHERE ac.id = ?`
  );
  const relationships: RelationshipSummary[] = [...byActor.entries()]
    .map(([actor_id, v]) => {
      const who = resolveActor.get(actor_id) as
        | { kind: string; display_name: string; agent_id: string | null; agent_name: string | null }
        | undefined;
      return {
        actor_id: actor_id as ActorId,
        weight: v.weight,
        last_interaction_at: v.last,
        counterpart_name: who?.agent_name ?? who?.display_name ?? actor_id,
        counterpart_kind: who?.kind ?? "unknown",
        counterpart_agent_id: (who?.agent_id ?? null) as AgentId | null,
      };
    })
    .sort((a, b) => b.weight - a.weight || (b.last_interaction_at > a.last_interaction_at ? 1 : -1));

  return {
    agent,
    charter,
    status: agent.state === "active" ? getAgentStatus(db, agentId) : "idle",
    workstreams,
    openTasks,
    relationships,
  };
}
