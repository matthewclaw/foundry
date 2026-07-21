import { newTeamId, type Policy, type Team, type TeamId, type WorkspaceRef } from "@foundry/core";
import type { Db } from "../db/connection.js";
import type { Mutate } from "../types.js";
import { fromJson } from "../row-mapping.js";

export interface CreateTeamInput {
  name: string;
  description: string;
  default_policy: Policy;
  default_workspace_ref?: WorkspaceRef | null;
}

/** Teams carry no state machine (02: "labels with defaults, not containers with behaviour"). */
export function createTeam(mutate: Mutate, input: CreateTeamInput): Team {
  const id = newTeamId();
  const default_workspace_ref = input.default_workspace_ref ?? null;
  return mutate({
    apply: (tx) => {
      tx.db
        .prepare(
          `INSERT INTO teams (id, name, description, default_policy_json, default_workspace_ref_json) VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.name,
          input.description,
          JSON.stringify(input.default_policy),
          default_workspace_ref ? JSON.stringify(default_workspace_ref) : null
        );
      return {
        id,
        name: input.name,
        description: input.description,
        default_policy: input.default_policy,
        default_workspace_ref,
      } satisfies Team;
    },
    // No dedicated `team_*` prefix exists in the catalogue (contracts.md lists teams as
    // "labels with defaults" only) — no event emitted, mirroring thread creation
    // (see OPEN_ISSUES.md #12).
    events: [],
  });
}

export interface UpdateTeamInput {
  id: TeamId;
  name?: string;
  description?: string;
  /** undefined = leave as-is; null = clear (unassign the team's repo). */
  default_workspace_ref?: WorkspaceRef | null;
}

/** Same "labels with defaults" exemption as createTeam — no catalogue event (#17). */
export function updateTeam(db: Db, mutate: Mutate, input: UpdateTeamInput): Team {
  const row = db.prepare(`SELECT * FROM teams WHERE id = ?`).get(input.id) as TeamRow | undefined;
  if (!row) throw new Error(`team not found: ${input.id}`);
  const name = input.name ?? row.name;
  const description = input.description ?? row.description;
  const ref =
    input.default_workspace_ref !== undefined ? input.default_workspace_ref : rowToTeam(row).default_workspace_ref;
  mutate({
    apply: (tx) => {
      tx.db
        .prepare(`UPDATE teams SET name = ?, description = ?, default_workspace_ref_json = ? WHERE id = ?`)
        .run(name, description, ref ? JSON.stringify(ref) : null, input.id);
    },
    events: [],
  });
  return { ...rowToTeam(row), name, description, default_workspace_ref: ref };
}

/**
 * Deletes the team label itself. Member agents aren't deleted or blocked — their
 * `team_id` is cleared to NULL (the same "Unassigned" bucket OrgView already renders),
 * since a team is just a grouping label, not a container whose removal should touch the
 * audited agent/workstream/run history those agents own.
 */
export function deleteTeam(db: Db, mutate: Mutate, id: TeamId): void {
  const row = db.prepare(`SELECT id FROM teams WHERE id = ?`).get(id);
  if (!row) throw new Error(`team not found: ${id}`);
  mutate({
    apply: (tx) => {
      tx.db.prepare(`UPDATE agents SET team_id = NULL WHERE team_id = ?`).run(id);
      tx.db.prepare(`DELETE FROM teams WHERE id = ?`).run(id);
    },
    events: [],
  });
}

export interface TeamRow {
  id: string;
  name: string;
  description: string;
  default_policy_json: string;
  default_workspace_ref_json: string | null;
}

export function rowToTeam(row: TeamRow): Team {
  return {
    id: row.id as Team["id"],
    name: row.name,
    description: row.description,
    default_policy: fromJson(row.default_policy_json, {}),
    default_workspace_ref: row.default_workspace_ref_json
      ? fromJson(row.default_workspace_ref_json, null)
      : null,
  };
}
