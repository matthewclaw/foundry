/**
 * E2.7 — `foundry backup` primitive (05: "backup is `sqlite3 .backup` + rsync/snapshot
 * of `~/.foundry`"). The CLI command (E5.7) wraps this; here it's just the mechanism:
 * a live SQLite backup (safe to run against an open, in-use database) plus a plain
 * recursive copy of the artifacts/ and runs/ directories.
 */
import { cpSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db/connection.js";
import type { Mutate } from "./types.js";

export interface BackupResult {
  path: string;
  sizeBytes: number;
}

export async function backupStore(params: {
  db: Db;
  mutate: Mutate;
  dataDir: string;
  destDir: string;
}): Promise<BackupResult> {
  mkdirSync(params.destDir, { recursive: true });
  const dbBackupPath = join(params.destDir, "foundry.db");
  await params.db.backup(dbBackupPath);

  for (const sub of ["artifacts", "runs"]) {
    const src = join(params.dataDir, sub);
    if (existsSync(src)) cpSync(src, join(params.destDir, sub), { recursive: true });
  }

  const sizeBytes = statSync(dbBackupPath).size;
  params.mutate({
    apply: () => undefined,
    events: [
      {
        actor_id: null,
        entity_type: "system",
        entity_id: "system",
        type: "system_backup_completed",
        payload: { path: params.destDir, size_bytes: sizeBytes },
      },
    ],
  });
  return { path: params.destDir, sizeBytes };
}

/** Restores a backup produced by `backupStore` into a (normally fresh) data directory. */
export function restoreStore(params: { backupDir: string; targetDataDir: string }): void {
  mkdirSync(params.targetDataDir, { recursive: true });
  cpSync(join(params.backupDir, "foundry.db"), join(params.targetDataDir, "foundry.db"));
  for (const sub of ["artifacts", "runs"]) {
    const src = join(params.backupDir, sub);
    if (existsSync(src)) cpSync(src, join(params.targetDataDir, sub), { recursive: true });
  }
}
