/**
 * E2.7 — Content-addressed artifact store (05: "content-addressed run outputs"; DB
 * stores references and hashes, never blobs). Layout: `<dataDir>/artifacts/<sha256
 * prefix>/<sha256>`, deduplicated by content — writing the same bytes twice is a no-op
 * on disk. The DB stores the path *relative to dataDir*, not an absolute path — a
 * `.foundry` directory (and its backup) can be restored under a different absolute
 * location and artifact lookups still resolve (E2.7 backup/restore round-trip AC).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { newArtifactId, type Artifact, type ArtifactId, type RunId } from "@foundry/core";
import type { Db } from "../db/connection.js";
import type { Mutate } from "../types.js";

function relativeArtifactPath(sha256: string): string {
  return join("artifacts", sha256.slice(0, 2), sha256);
}

/** Absolute on-disk path for a given content hash — for writing/direct file access. */
export function artifactPath(dataDir: string, sha256: string): string {
  return join(dataDir, relativeArtifactPath(sha256));
}

export interface PutArtifactInput {
  run_id: RunId;
  kind: string;
  content: Buffer | string;
}

/** No catalogue event: artifacts are referenced by task_delivered's deliverable_ref (04) when they matter organisationally; a bare content-addressed write is store-internal bookkeeping. */
export function putArtifact(mutate: Mutate, dataDir: string, input: PutArtifactInput): Artifact {
  const buf = typeof input.content === "string" ? Buffer.from(input.content, "utf-8") : input.content;
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const relPath = relativeArtifactPath(sha256);
  const absPath = join(dataDir, relPath);
  mkdirSync(dirname(absPath), { recursive: true });
  if (!existsSync(absPath)) writeFileSync(absPath, buf);

  const id = newArtifactId();
  const now = new Date().toISOString();
  return mutate({
    apply: (tx) => {
      tx.db
        .prepare(
          `INSERT INTO artifacts (id, run_id, kind, path, sha256, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, input.run_id, input.kind, relPath, sha256, buf.length, now);
      return {
        id,
        run_id: input.run_id,
        kind: input.kind,
        path: relPath,
        sha256,
        size: buf.length,
        created_at: now,
      } satisfies Artifact;
    },
    events: [],
  });
}

export interface ArtifactRow {
  id: string;
  run_id: string;
  kind: string;
  path: string;
  sha256: string;
  size: number;
  created_at: string;
}

export function rowToArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id as Artifact["id"],
    run_id: row.run_id as Artifact["run_id"],
    kind: row.kind,
    path: row.path,
    sha256: row.sha256,
    size: row.size,
    created_at: row.created_at,
  };
}

export class ArtifactCorruptionError extends Error {
  constructor(id: string, expected: string, actual: string) {
    super(`Artifact ${id} failed sha256 verification: expected ${expected}, got ${actual}`);
    this.name = "ArtifactCorruptionError";
  }
}

/** Reads an artifact's bytes (resolved against dataDir) and verifies them against the recorded sha256 (E2.7 AC). */
export function readArtifact(db: Db, dataDir: string, id: ArtifactId): { artifact: Artifact; content: Buffer } {
  const row = db.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(id) as ArtifactRow | undefined;
  if (!row) throw new Error(`Artifact not found: ${id}`);
  const content = readFileSync(join(dataDir, row.path));
  const actual = createHash("sha256").update(content).digest("hex");
  if (actual !== row.sha256) throw new ArtifactCorruptionError(id, row.sha256, actual);
  return { artifact: rowToArtifact(row), content };
}
