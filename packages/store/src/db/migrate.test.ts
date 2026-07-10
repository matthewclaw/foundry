import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "./connection.js";
import { schemaVersion } from "./migrate.js";
import { MIGRATIONS } from "./migrations.js";

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("migration runner (E2.1)", () => {
  it("bootstraps a fresh directory to the current schema version", () => {
    dir = mkdtempSync(join(tmpdir(), "foundry-store-"));
    const dbPath = join(dir, "foundry.db");
    const db = openDb(dbPath);
    expect(existsSync(dbPath)).toBe(true);
    expect(schemaVersion(db)).toBe(MIGRATIONS.at(-1)!.version);

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((r) => (r as { name: string }).name);
    for (const expected of ["agents", "workstreams", "runs", "tasks", "events", "messages"]) {
      expect(tables).toContain(expected);
    }
    db.close();
  });

  it("is idempotent when reopened against an already-migrated file", () => {
    dir = mkdtempSync(join(tmpdir(), "foundry-store-"));
    const dbPath = join(dir, "foundry.db");
    const first = openDb(dbPath);
    first.close();

    const second = openDb(dbPath); // re-run must not error or re-apply
    expect(schemaVersion(second)).toBe(MIGRATIONS.at(-1)!.version);
    const count = second
      .prepare(`SELECT COUNT(*) AS c FROM schema_migrations`)
      .get() as { c: number };
    expect(count.c).toBe(MIGRATIONS.length);
    second.close();
  });

  it("records the applied version in-memory too", () => {
    const db = openDb(":memory:");
    expect(schemaVersion(db)).toBe(MIGRATIONS.at(-1)!.version);
    db.close();
  });
});
