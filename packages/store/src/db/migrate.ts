/**
 * E2.1 — Migration runner: numbered, forward-only, applied on startup, idempotent on
 * re-run (contracts.md "DB migrations"; roadmap E2.1 AC).
 */
import type { Db } from "./connection.js";
import { MIGRATIONS } from "./migrations.js";

function currentVersion(db: Db): number {
  const row = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`
    )
    .get();
  if (!row) return 0;
  const result = db.prepare(`SELECT MAX(version) AS v FROM schema_migrations`).get() as
    | { v: number | null }
    | undefined;
  return result?.v ?? 0;
}

export function runMigrations(db: Db): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`
  );
  const applied = currentVersion(db);
  const pending = MIGRATIONS.filter((m) => m.version > applied).sort(
    (a, b) => a.version - b.version
  );
  for (const migration of pending) {
    const apply = db.transaction(() => {
      db.exec(migration.up);
      db.prepare(
        `INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`
      ).run(migration.version, migration.name, new Date().toISOString());
    });
    apply();
  }
}

export function schemaVersion(db: Db): number {
  return currentVersion(db);
}
