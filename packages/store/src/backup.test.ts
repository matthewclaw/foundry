import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "./db/connection.js";
import { createEventBus } from "./events/bus.js";
import { createMutate } from "./mutate.js";
import { createAgent } from "./mutations/agents.js";
import { createWorkstream } from "./mutations/workstreams.js";
import { createRun } from "./mutations/runs.js";
import { putArtifact, readArtifact } from "./artifacts/store.js";
import { createAgentQueries } from "./queries/agents.js";
import { backupStore, restoreStore } from "./backup.js";

const ZERO_BUDGET = { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

describe("E2.7 backup/restore round-trip", () => {
  it("restores an identical store: rows present, artifact bytes verify, event emitted", async () => {
    const dataDir = tmp("foundry-backup-src-");
    const db = openDb(":memory:");
    const bus = createEventBus();
    const mutate = createMutate(db, bus);

    const { agentId } = createAgent(mutate, {
      name: "Orbit",
      role: "Backend",
      team_id: null,
      engine_id: "claude-code",
      memory_ref: "m",
      charter_body_md: "# Orbit",
    });
    const ws = createWorkstream(mutate, { agent_id: agentId, title: "T", goal_md: "g", origin: "human", budget: ZERO_BUDGET });
    const run = createRun(mutate, { workstream_id: ws.id, trigger: "human_message", input_context_ref: "a", engine_id: "claude-code" });
    const artifact = putArtifact(mutate, dataDir, { run_id: run.id, kind: "diff", content: "hello backup" });

    const destDir = tmp("foundry-backup-dest-");
    const events: string[] = [];
    bus.subscribe((e) => events.push(e.type));
    const result = await backupStore({ db, mutate, dataDir, destDir });
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(events).toContain("system_backup_completed");

    const targetDataDir = tmp("foundry-backup-restored-");
    restoreStore({ backupDir: destDir, targetDataDir });

    // Prove this is really reading the restored copy, not the original: destroy the
    // source dataDir first. Artifact paths are stored relative to dataDir (not
    // absolute), so lookups against targetDataDir must still resolve correctly even
    // though it's a different absolute location than the original.
    db.close();
    rmSync(dataDir, { recursive: true, force: true });

    const restoredDb = openDb(join(targetDataDir, "foundry.db"));
    const restoredAgents = createAgentQueries(restoredDb);
    expect(restoredAgents.get(agentId)?.name).toBe("Orbit");

    const { content } = readArtifact(restoredDb, targetDataDir, artifact.id);
    expect(content.toString("utf-8")).toBe("hello backup");
    restoredDb.close();
  });
});
