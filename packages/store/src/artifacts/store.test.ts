import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../db/connection.js";
import { createEventBus } from "../events/bus.js";
import { createMutate } from "../mutate.js";
import { createAgent } from "../mutations/agents.js";
import { createWorkstream } from "../mutations/workstreams.js";
import { createRun } from "../mutations/runs.js";
import { putArtifact, readArtifact, ArtifactCorruptionError, artifactPath } from "./store.js";
import { writeFileSync } from "node:fs";

const ZERO_BUDGET = { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 };

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function harness() {
  dir = mkdtempSync(join(tmpdir(), "foundry-artifacts-"));
  const db = openDb(":memory:");
  const bus = createEventBus();
  const mutate = createMutate(db, bus);
  const { agentId } = createAgent(mutate, {
    name: "A",
    role: "R",
    team_id: null,
    engine_id: "claude-code",
    memory_ref: "m",
    charter_body_md: "#",
  });
  const ws = createWorkstream(mutate, { agent_id: agentId, title: "T", goal_md: "g", origin: "human", budget: ZERO_BUDGET });
  const run = createRun(mutate, { workstream_id: ws.id, trigger: "human_message", input_context_ref: "a", engine_id: "claude-code" });
  return { db, mutate, dataDir: dir, runId: run.id };
}

describe("E2.7 artifact store", () => {
  it("writes content-addressed, is idempotent for identical content, and sha256-verifies on read", () => {
    const { db, mutate, dataDir, runId } = harness();
    const a1 = putArtifact(mutate, dataDir, { run_id: runId, kind: "diff", content: "diff --git a b\n" });
    const a2 = putArtifact(mutate, dataDir, { run_id: runId, kind: "diff", content: "diff --git a b\n" });

    expect(a1.sha256).toBe(a2.sha256); // same content -> same address
    expect(a1.path).toBe(a2.path);

    const { artifact, content } = readArtifact(db, dataDir, a1.id);
    expect(content.toString("utf-8")).toBe("diff --git a b\n");
    expect(artifact.sha256).toBe(a1.sha256);
    expect(artifact.path).not.toContain(dataDir); // stored relative to dataDir, not absolute
  });

  it("throws ArtifactCorruptionError if the file on disk no longer matches the recorded sha256", () => {
    const { db, mutate, dataDir, runId } = harness();
    const artifact = putArtifact(mutate, dataDir, { run_id: runId, kind: "diff", content: "original" });
    writeFileSync(artifactPath(dataDir, artifact.sha256), "tampered");

    expect(() => readArtifact(db, dataDir, artifact.id)).toThrow(ArtifactCorruptionError);
  });
});
