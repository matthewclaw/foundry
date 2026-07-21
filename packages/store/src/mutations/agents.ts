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
  // Callers can't know the id before it exists, so the doc-05 conventional layout
  // (`agents/<agent-id>/memory`) is expressible via a token — same pattern as
  // createRun's `{run_id}` (OPEN_ISSUES #29).
  const memoryRef = input.memory_ref.replace("{agent_id}", agentId);
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
          memoryRef,
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

export interface TransitionAgentStateArgs {
  id: AgentId;
  to: AgentState;
  actorId: ActorId | null;
  reason?: string;
}

export function transitionAgentState(db: Db, mutate: Mutate, args: TransitionAgentStateArgs): void {
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

/** E5.2: charter edit = a new immutable version + `agent_charter_updated` (doc-02). */
export function updateAgentCharter(
  db: Db,
  mutate: Mutate,
  args: { agentId: AgentId; bodyMd: string; editedByActor: ActorId }
): { version: number } {
  const row = db.prepare(`SELECT charter_version FROM agents WHERE id = ?`).get(args.agentId) as
    | { charter_version: number }
    | undefined;
  if (!row) throw new Error(`agent not found: ${args.agentId}`);
  const version = row.charter_version + 1;
  const now = new Date().toISOString();
  mutate({
    apply: (tx) => {
      tx.db
        .prepare(`INSERT INTO agent_charters (agent_id, version, body_md, edited_by_actor, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(args.agentId, version, args.bodyMd, args.editedByActor, now);
      tx.db.prepare(`UPDATE agents SET charter_version = ? WHERE id = ?`).run(version, args.agentId);
    },
    events: [
      {
        actor_id: args.editedByActor,
        entity_type: "agent",
        entity_id: args.agentId,
        type: "agent_charter_updated",
        payload: { version, edited_by_actor: args.editedByActor },
      },
    ],
  });
  return { version };
}

/** E5.2 / doc-01 success test #3: swap the engine binding, identity/memory/history untouched. */
export function rebindAgentEngine(
  db: Db,
  mutate: Mutate,
  args: { agentId: AgentId; engine: { id: string; config?: unknown }; actorId: ActorId | null }
): void {
  const row = db.prepare(`SELECT engine_id FROM agents WHERE id = ?`).get(args.agentId) as
    | { engine_id: string }
    | undefined;
  if (!row) throw new Error(`agent not found: ${args.agentId}`);
  mutate({
    apply: (tx) => {
      tx.db
        .prepare(`UPDATE agents SET engine_id = ?, engine_config_json = ? WHERE id = ?`)
        .run(args.engine.id, toJson(args.engine.config), args.agentId);
    },
    events: [
      {
        actor_id: args.actorId,
        entity_type: "agent",
        entity_id: args.agentId,
        type: "agent_engine_rebound",
        payload: { previous_engine_id: row.engine_id, new_engine_id: args.engine.id },
      },
    ],
  });
}

/** Set (or clear, with null) the agent's default working directory — the fallback the
 * runtime uses for any of its workstreams that don't set their own workspace_ref. */
export function setAgentDefaultWorkspace(
  db: Db,
  mutate: Mutate,
  args: { agentId: AgentId; workspaceRef: WorkspaceRef | null; actorId: ActorId | null }
): void {
  const row = db.prepare(`SELECT id FROM agents WHERE id = ?`).get(args.agentId);
  if (!row) throw new Error(`agent not found: ${args.agentId}`);
  mutate({
    apply: (tx) => {
      tx.db
        .prepare(`UPDATE agents SET default_workspace_ref_json = ? WHERE id = ?`)
        .run(toJson(args.workspaceRef), args.agentId);
    },
    events: [
      {
        actor_id: args.actorId,
        entity_type: "agent",
        entity_id: args.agentId,
        type: "agent_default_workspace_set",
        payload: { workspace_ref: args.workspaceRef },
      },
    ],
  });
}

/**
 * The single human operator's Actor row (v1 is single-human; doc-03: "Agents and humans
 * are both actors"). Created lazily with no event — same catalogue gap/precedent as
 * threads/teams (OPEN_ISSUES #17).
 */
export function getOrCreateHumanActor(db: Db, mutate: Mutate, displayName = "Human"): ActorId {
  const existing = db.prepare(`SELECT id FROM actors WHERE kind = 'human' ORDER BY created_at LIMIT 1`).get() as
    | { id: string }
    | undefined;
  if (existing) return existing.id as ActorId;
  const id = newActorId();
  mutate({
    apply: (tx) => {
      tx.db
        .prepare(`INSERT INTO actors (id, kind, display_name, created_at) VALUES (?, 'human', ?, ?)`)
        .run(id, displayName, new Date().toISOString());
    },
    events: [],
  });
  return id;
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
