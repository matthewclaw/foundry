/** E11.3 — close with distillation: final run carries the distillation instruction, then the workstream closes. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeAdapter, loadScenario } from "@foundry/adapter-fake";
import { createServer, type FoundryServer } from "../server.js";

let server: FoundryServer;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "foundry-distill-"));
  server = createServer({ dataDir: tempDir, adapters: { fake: createFakeAdapter(loadScenario("happy-path")) } });
});

afterEach(() => {
  try {
    server.store.close();
  } catch {
    /* closed */
  }
  rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function idle(): Promise<void> {
  while (server.runtime.pendingCount() > 0 || server.runtime.activeCount() > 0) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("close with distillation — E11.3", () => {
  it("schedules the distillation run (instruction in context), then closes when it settles", async () => {
    const { agentId } = server.store.commands.createAgent({
      name: "Orbit",
      role: "Backend",
      team_id: null,
      engine_id: "fake",
      engine_config: { scenarioName: "happy-path" },
      memory_ref: "agents/{agent_id}/memory",
      charter_body_md: "# Orbit",
    });
    server.store.commands.transitionAgentState({ id: agentId, to: "active", actorId: null });
    const ws = server.store.commands.createWorkstream({
      agent_id: agentId,
      title: "T",
      goal_md: "g",
      origin: "human",
      budget: { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 },
    });
    // Prior work happened on this workstream.
    server.runtime.enqueue({ workstreamId: ws.id, trigger: "human_message" });
    await idle();

    const res = await server.app.inject({
      method: "POST",
      url: `/api/workstreams/${ws.id}/close`,
      payload: { distill: true, reason: "done" },
    });
    expect(res.statusCode).toBe(202);
    const { distillation_run_id } = JSON.parse(res.body);
    expect(distillation_run_id).toBeTruthy();

    await idle();
    const run = server.store.runs.get(distillation_run_id);
    expect(run?.state).toBe("completed");
    const context = readFileSync(join(tempDir, run!.input_context_ref), "utf8");
    expect(context).toContain("Distil durable lessons");
    // The workstream closed once the distillation run settled.
    expect(server.store.workstreams.get(ws.id)?.state).toBe("closed");
  });

  it("distill on a workstream with no runs closes immediately (nothing to distil)", async () => {
    const { agentId } = server.store.commands.createAgent({
      name: "Idle",
      role: "Backend",
      team_id: null,
      engine_id: "fake",
      memory_ref: "agents/{agent_id}/memory",
      charter_body_md: "# Idle",
    });
    server.store.commands.transitionAgentState({ id: agentId, to: "active", actorId: null });
    const ws = server.store.commands.createWorkstream({
      agent_id: agentId,
      title: "Empty",
      goal_md: "g",
      origin: "human",
      budget: { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 },
    });
    const res = await server.app.inject({
      method: "POST",
      url: `/api/workstreams/${ws.id}/close`,
      payload: { distill: true },
    });
    expect(res.statusCode).toBe(200);
    expect(server.store.workstreams.get(ws.id)?.state).toBe("closed");
  });
});
