import {
  newActorId,
  newAgentId,
  type Agent,
  type AgentState,
  type ActorId,
  type AgentId,
  type Policy,
  type WorkspaceRef,
} from "@foundry/core";
import type { Db } from "../db/connection.js";
import type { Mutate } from "../types.js";
import { fromJson, fromJsonNullable, toJson } from "../row-mapping.js";
import { readState, requireTransitionEvent, assertStateUnchanged } from "./transition-helper.js";

export interface CreateAgentInput {
  name: string;
  role: string;
  team_id: string | null;
  engine_id: string;
  engine_config?: unknown;
  memory_ref: string;
  default_workspace_ref?: WorkspaceRef | null;
  policy_overrides?: Policy;
  charter_body_md: string;
}

/** Creates the 1:1 Actor + Agent pair (02: "Agents additionally: 1:1 with an Agent record"). */
export function createAgent(mutate: Mutate, input: CreateAgentInput): { agentId: AgentId; actorId: ActorId } {
  const actorId = newActorId();
  const agentId = newAgentId();
  const now = new Date().toISOString();

  return mutate({
    apply: (tx) => {
      tx.db
        .prepare(`INSERT INTO actors (id, kind, display_name, created_at) VALUES (?, 'agent', ?, ?)`)
        .run(actorId, input.name, now);
      tx.db
        .prepare(
          `INSERT INTO agents (id, actor_id, name, role, team_id, charter_version, engine_id, engine_config_json, memory_ref, default_workspace_ref_json, policy_json, state, created_at, retired_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 'draft', ?, NULL)`
        )
        .run(
          agentId,
          actorId,
          input.name,
          input.role,
          input.team_id,
          input.engine_id,
          toJson(input.engine_config),
          input.memory_ref,
          toJson(input.default_workspace_ref ?? null),
          toJson(input.policy_overrides ?? {}),
          now
        );
      tx.db
        .prepare(
          `INSERT INTO agent_charters (agent_id, version, body_md, edited_by_actor, created_at) VALUES (?, 1, ?, ?, ?)`
        )
        .run(agentId, input.charter_body_md, actorId, now);
      return { agentId, actorId };
    },
    events: [
      {
        actor_id: actorId,
        entity_type: "agent",
        entity_id: agentId,
        type: "agent_created",
        payload: { name: input.name, role: input.role, team_id: input.team_id, engine_id: input.engine_id },
      },
    ],
  });
}

export function transitionAgentState(
  db: Db,
  mutate: Mutate,
  args: { id: AgentId; to: AgentState; actorId: ActorId | null; reason?: string }
): void {
  const from = readState(db, "agents", args.id, "agent");
  const event = requireTransitionEvent("agent", from, args.to);

  mutate({
    apply: (tx) => {
      assertStateUnchanged(tx.db, "agents", args.id, from, "agent");
      const retiredAt = args.to === "retired" ? new Date().toISOString() : null;
      tx.db
        .prepare(`UPDATE agents SET state = ?, retired_at = COALESCE(?, retired_at) WHERE id = ?`)
        .run(args.to, retiredAt, args.id);
    },
    events: [
      {
        actor_id: args.actorId,
        entity_type: "agent",
        entity_id: args.id,
        type: event,
        payload: event === "agent_activated" || event === "agent_resumed" ? {} : { reason: args.reason },
      },
    ],
  });
}

export interface AgentRow {
  id: string;
  actor_id: string;
  name: string;
  role: string;
  avatar_color: string | null;
  team_id: string | null;
  charter_version: number;
  engine_id: string;
  engine_config_json: string | null;
  memory_ref: string;
  default_workspace_ref_json: string | null;
  policy_json: string;
  state: string;
  created_at: string;
  retired_at: string | null;
}

export function rowToAgent(row: AgentRow): Agent {
  return {
    id: row.id as Agent["id"],
    actor_id: row.actor_id as Agent["actor_id"],
    name: row.name,
    role: row.role,
    avatar_color: row.avatar_color ?? undefined,
    team_id: row.team_id as Agent["team_id"],
    charter_version: row.charter_version,
    engine: { id: row.engine_id, config: fromJson(row.engine_config_json, undefined) },
    memory_ref: row.memory_ref,
    default_workspace_ref: fromJsonNullable(row.default_workspace_ref_json),
    policy_overrides: fromJson(row.policy_json, {}),
    state: row.state as AgentState,
    created_at: row.created_at,
    retired_at: row.retired_at,
  };
}
