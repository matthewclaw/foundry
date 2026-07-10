import { newTeamId, type Policy, type Team } from "@foundry/core";
import type { Mutate } from "../types.js";
import { fromJson } from "../row-mapping.js";

/** Teams carry no state machine (02: "labels with defaults, not containers with behaviour"). */
export function createTeam(mutate: Mutate, input: { name: string; description: string; default_policy: Policy }): Team {
  const id = newTeamId();
  return mutate({
    apply: (tx) => {
      tx.db
        .prepare(`INSERT INTO teams (id, name, description, default_policy_json) VALUES (?, ?, ?, ?)`)
        .run(id, input.name, input.description, JSON.stringify(input.default_policy));
      return {
        id,
        name: input.name,
        description: input.description,
        default_policy: input.default_policy,
      } satisfies Team;
    },
    // No dedicated `team_*` prefix exists in the catalogue (contracts.md lists teams as
    // "labels with defaults" only) — no event emitted, mirroring thread creation
    // (see OPEN_ISSUES.md #12).
    events: [],
  });
}

export interface TeamRow {
  id: string;
  name: string;
  description: string;
  default_policy_json: string;
}

export function rowToTeam(row: TeamRow): Team {
  return {
    id: row.id as Team["id"],
    name: row.name,
    description: row.description,
    default_policy: fromJson(row.default_policy_json, {}),
  };
}
