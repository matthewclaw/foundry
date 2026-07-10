/** E6.1 — per-run scoped tokens: mint at start, expire at end, 401 for anything else. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecutionAdapter, RunSpec } from "@foundry/adapter-api";
import { createFakeAdapter, loadScenario } from "@foundry/adapter-fake";
import { createServer, type FoundryServer } from "../server.js";

let server: FoundryServer;
let tempDir: string;
let capturedSpecs: RunSpec[];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "foundry-orgtools-"));
  capturedSpecs = [];
  const inner = createFakeAdapter(loadScenario("happy-path"));
  const capturing: ExecutionAdapter = {
    id: inner.id,
    capabilities: () => inner.capabilities(),
    start: (spec) => {
      capturedSpecs.push(spec);
      return inner.start(spec);
    },
    resume: inner.resume ? (spec) => inner.resume!(spec) : undefined,
    cancel: (h) => inner.cancel(h),
    events: (h) => inner.events(h),
  };
  server = createServer({ dataDir: tempDir, dbPath: ":memory:", adapters: { fake: capturing } });
});

afterEach(() => {
  try {
    server.store.close();
  } catch {
    /* closed */
  }
  rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function bootstrapAgent(): { agentId: string; wsId: string } {
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
  return { agentId, wsId: ws.id };
}

async function idle(): Promise<void> {
  while (server.runtime.pendingCount() > 0 || server.runtime.activeCount() > 0) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("org-tools auth — E6.1", () => {
  it("a live token calls tools; the same token is dead after its run ends", async () => {
    const { agentId, wsId } = bootstrapAgent();
    server.runtime.enqueue({ workstreamId: wsId as never, trigger: "human_message" });
    await idle();

    // The adapter received a per-run credential…
    expect(capturedSpecs).toHaveLength(1);
    const env = capturedSpecs[0]!.orgTools.cliEnv!;
    expect(env.FOUNDRY_ORG_TOOLS_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    // …which was scoped to exactly this (agent, run) while live — and the run has
    // ended, so it is now dead (run end IS expiry):
    expect(server.tokens.resolve(env.FOUNDRY_ORG_TOOLS_TOKEN)).toBeUndefined();
    const res = await server.app.inject({
      method: "POST",
      url: "/api/org-tools/list_org",
      headers: { authorization: `Bearer ${env.FOUNDRY_ORG_TOOLS_TOKEN}` },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    void agentId;
  });

  it("a minted (still-live) token authenticates and attributes to its (agent, run)", async () => {
    const { agentId } = bootstrapAgent();
    const agent = server.store.agents.get(agentId as never)!;
    const token = server.tokens.mint({ runId: "run_x" as never, agentId: agent.id, actorId: agent.actor_id });

    const res = await server.app.inject({
      method: "POST",
      url: "/api/org-tools/list_org",
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.data.agents.some((a: { id: string }) => a.id === agent.id)).toBe(true);
  });

  it("missing, garbage, and revoked tokens are all 401 problem+json", async () => {
    const { agentId } = bootstrapAgent();
    const agent = server.store.agents.get(agentId as never)!;
    const revoked = server.tokens.mint({ runId: "run_y" as never, agentId: agent.id, actorId: agent.actor_id });
    server.tokens.revokeRun("run_y" as never);

    for (const headers of [
      {},
      { authorization: "Bearer deadbeef" },
      { authorization: `Bearer ${revoked}` },
    ]) {
      const res = await server.app.inject({ method: "POST", url: "/api/org-tools/list_org", headers, payload: {} });
      expect(res.statusCode).toBe(401);
      expect(res.headers["content-type"]).toContain("application/problem+json");
    }
  });

  it("get_task / get_thread read tools work; unknown tool 404; unimplemented tool 501", async () => {
    const { agentId } = bootstrapAgent();
    const agent = server.store.agents.get(agentId as never)!;
    const token = server.tokens.mint({ runId: "run_z" as never, agentId: agent.id, actorId: agent.actor_id });
    const auth = { authorization: `Bearer ${token}` };

    const thread = server.store.commands.getOrCreateThread("workstream", "anchor-1");
    const got = await server.app.inject({
      method: "POST",
      url: "/api/org-tools/get_thread",
      headers: auth,
      payload: { thread_id: thread.id },
    });
    expect(JSON.parse(got.body)).toMatchObject({ ok: true, data: { thread: { id: thread.id } } });

    const unknown = await server.app.inject({ method: "POST", url: "/api/org-tools/frobnicate", headers: auth, payload: {} });
    expect(unknown.statusCode).toBe(404);

    const pending = await server.app.inject({ method: "POST", url: "/api/org-tools/delegate_task", headers: auth, payload: {} });
    expect(pending.statusCode).toBe(501);
  });
});
