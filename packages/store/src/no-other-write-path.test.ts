/**
 * E2.2 AC: "no other write path exists besides mutate() (lint rule)". This is that
 * enforced check: every shipped source file is scanned for raw write-SQL keywords
 * (`INSERT INTO`, `UPDATE <table>`, `DELETE FROM`) — written consistently uppercase in
 * this codebase's SQL, so a plain substring match doesn't false-positive on English
 * prose ("the update", "on delete") which is always lowercase in our comments/JSDoc.
 * Only files that implement mutate() itself, its mutation-helper callers, or the
 * migration bootstrap (schema DDL, not app state) may contain them.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

const ALLOWED_WRITE_FILES = new Set([
  "mutate.ts",
  "db/migrate.ts",
  "mutations/agents.ts",
  "mutations/teams.ts",
  "mutations/workstreams.ts",
  "mutations/runs.ts",
  "mutations/tasks.ts",
  "mutations/messages.ts",
  "mutations/approvals.ts",
  "artifacts/store.ts",
  // compactRunDeltas' DELETE runs inside a mutate() apply() callback, same as every
  // mutations/*.ts helper — it just lives here because contracts.md places compaction
  // under `events`, not a dedicated mutations file.
  "events/feed.ts",
]);

const WRITE_KEYWORDS = ["INSERT INTO", "UPDATE ", "DELETE FROM", "REPLACE INTO"];

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "node_modules") continue;
      out.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("E2.2: no write path exists besides mutate() (enforced check)", () => {
  it("only mutate() and its mutation-helper/migration files contain write SQL", () => {
    const offenders: { file: string; keyword: string }[] = [];

    for (const file of listTsFiles(SRC_DIR)) {
      const rel = relative(SRC_DIR, file).replace(/\\/g, "/");
      if (ALLOWED_WRITE_FILES.has(rel)) continue;

      const content = readFileSync(file, "utf-8");
      for (const keyword of WRITE_KEYWORDS) {
        if (content.includes(keyword)) offenders.push({ file: rel, keyword });
      }
    }

    expect(offenders).toEqual([]);
  });

  it("the allow-list itself is exhaustive: every file with write SQL is accounted for", () => {
    // Guards the guard: if a new mutation file is added and forgotten in
    // ALLOWED_WRITE_FILES above, this fails loudly instead of the first test just
    // silently reporting a spurious "offender" that's actually legitimate.
    const filesWithWriteSql = new Set<string>();
    for (const file of listTsFiles(SRC_DIR)) {
      const rel = relative(SRC_DIR, file).replace(/\\/g, "/");
      const content = readFileSync(file, "utf-8");
      if (WRITE_KEYWORDS.some((k) => content.includes(k))) filesWithWriteSql.add(rel);
    }
    for (const allowed of ALLOWED_WRITE_FILES) {
      expect(filesWithWriteSql.has(allowed), `${allowed} is allow-listed but has no write SQL — stale entry?`).toBe(
        true
      );
    }
  });
});
