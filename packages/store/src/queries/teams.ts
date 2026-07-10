/** E2.3 — Team reads. Read-only. */
import type { Team, TeamId } from "@foundry/core";
import type { Db } from "../db/connection.js";
import { rowToTeam, type TeamRow } from "../mutations/teams.js";

export interface TeamQueries {
  get(id: TeamId): Team | undefined;
  list(): Team[];
}

export function createTeamQueries(db: Db): TeamQueries {
  return {
    get(id) {
      const row = db.prepare(`SELECT * FROM teams WHERE id = ?`).get(id) as TeamRow | undefined;
      return row ? rowToTeam(row) : undefined;
    },
    list() {
      const rows = db.prepare(`SELECT * FROM teams ORDER BY name`).all() as TeamRow[];
      return rows.map(rowToTeam);
    },
  };
}
