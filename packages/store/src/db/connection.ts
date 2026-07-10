/**
 * E2.1 — SQLite bootstrap. WAL mode for file-backed databases (05: "SQLite (WAL mode)");
 * `:memory:` databases keep SQLite's own in-memory journal since WAL has no meaning there.
 */
import Database from "better-sqlite3";
import { runMigrations } from "./migrate.js";

export type Db = Database.Database;

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  if (path !== ":memory:") {
    db.pragma("journal_mode = WAL");
  }
  runMigrations(db);
  return db;
}
