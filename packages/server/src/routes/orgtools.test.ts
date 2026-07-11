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

  it("get_task / get_thread read tools work; unknown tool 404; invalid input is a tool-level error", async () => {
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

    // E6.2: every catalogued tool now has a handler — malformed input is a 200
    // tool-level error (agent-visible), not an HTTP status.
    const invalid = await server.app.inject({ method: "POST", url: "/api/org-tools/delegate_task", headers: auth, payload: {} });
    expect(invalid.statusCode).toBe(200);
    expect(JSON.parse(invalid.body)).toMatchObject({ ok: false, error: { code: "policy_violation" } });
  });
});

/** A minted token whose run is bound to a real task-carrying workstream, for E6.2's sub-delegation and approval-payload wiring. */
function mintTokenForTaskRun(server: FoundryServer, task: { id: string }, agentId: string) {
  const agent = server.store.agents.get(agentId as never)!;
  const ws = server.store.commands.createWorkstream({
    agent_id: agent.id,
    title: "sub",
    goal_md: "g",
    origin: `task:${task.id}` as never,
    task_id: task.id as never,
    budget: { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 },
  });
  const run = server.store.commands.createRun({
    workstream_id: ws.id,
    trigger: "human_message",
    input_context_ref: "runs/{run_id}/context.md",
    engine_id: "fake",
  });
  const token = server.tokens.mint({ runId: run.id, agentId: agent.id, actorId: agent.actor_id });
  return { token, ws, run, agent };
}

describe("delegate_task — E6.2/E6.3: sub-delegation depth + parent wiring", () => {
  it("a delegation from a run executing a task becomes a real child (parent_task_id, depth+1), and the delegator's depth cap applies", async () => {
    const { agentId } = bootstrapAgent();
    const human = server.store.commands.getOrCreateHumanActor();
    const worker = server.store.agents.get(agentId as never)!;

    const parentTask = server.store.commands.createTask({
      parent_task_id: null,
      delegator_actor_id: human,
      assignee_agent_id: worker.id,
      spec_md: "parent",
      acceptance_criteria_md: "AC",
      budget: { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 },
    });
    const { token } = mintTokenForTaskRun(server, parentTask, agentId);

    const res = await server.app.inject({
      method: "POST",
      url: "/api/org-tools/delegate_task",
      headers: { authorization: `Bearer ${token}` },
      payload: { title: "child", spec_md: "do it", acceptance_criteria_md: "AC", assignee_agent_id: worker.id },
    });
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    const child = server.store.tasks.get(body.data.task_id);
    expect(child?.parent_task_id).toBe(parentTask.id);
    expect(child?.depth).toBe(parentTask.depth + 1);
  });
});

describe("request_approval — E6.2/E6.4: payload carries workstream_id so grant re-triggers the run", () => {
  it("an org-tool-requested approval's payload includes the caller's workstream_id", async () => {
    const { agentId } = bootstrapAgent();
    const human = server.store.commands.getOrCreateHumanActor();
    const worker = server.store.agents.get(agentId as never)!;
    const task = server.store.commands.createTask({
      parent_task_id: null,
      delegator_actor_id: human,
      assignee_agent_id: worker.id,
      spec_md: "parent",
      acceptance_criteria_md: "AC",
      budget: { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 },
    });
    const { token, ws } = mintTokenForTaskRun(server, task, agentId);

    const res = await server.app.inject({
      method: "POST",
      url: "/api/org-tools/request_approval",
      headers: { authorization: `Bearer ${token}` },
      payload: { kind: "budget_increase", description: "need more budget" },
    });
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    const approval = server.store.approvals.get(body.data.approval_id);
    expect((approval?.payload as { workstream_id?: string }).workstream_id).toBe(ws.id);
  });
});

describe("search_history — E6.2/E6.3: real store search, scope-clamped, Ref-shaped hits", () => {
  it("finds a matching message and returns a proper ref string; scope beyond policy is refused", async () => {
    const { agentId, wsId } = bootstrapAgent();
    const agent = server.store.agents.get(agentId as never)!;
    const token = server.tokens.mint({ runId: "run_search" as never, agentId: agent.id, actorId: agent.actor_id });
    const thread = server.store.commands.getOrCreateThread("workstream", wsId);
    server.store.commands.sendMessage({
      thread_id: thread.id,
      from_actor_id: agent.actor_id,
      to_actor_id: server.store.commands.getOrCreateHumanActor(),
      type: "status",
      body_md: "unobtainium levels are nominal",
      refs: [],
      visibility: "normal",
    });

    const res = await server.app.inject({
      method: "POST",
      url: "/api/org-tools/search_history",
      headers: { authorization: `Bearer ${token}` },
      payload: { query: "unobtainium" },
    });
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.data.hits.length).toBeGreaterThan(0);
    expect(body.data.hits[0].ref).toMatch(/^message:/);

    // Default policy scope is "self" — asking for "org" exceeds it.
    const refused = await server.app.inject({
      method: "POST",
      url: "/api/org-tools/search_history",
      headers: { authorization: `Bearer ${token}` },
      payload: { query: "unobtainium", scope: "org" },
    });
    expect(JSON.parse(refused.body)).toMatchObject({ ok: false, error: { code: "policy_violation" } });
  });

  it("a teamless agent granted 'team' scope sees only its own history, not the whole org", async () => {
    // Team-level search via a policy override at creation (default is "self").
    const { agentId } = server.store.commands.createAgent({
      name: "Scoped",
      role: "Backend",
      team_id: null,
      engine_id: "fake",
      engine_config: {},
      memory_ref: "agents/{agent_id}/memory",
      charter_body_md: "# Scoped",
      policy_overrides: { search_history_scope: "team" },
    });
    server.store.commands.transitionAgentState({ id: agentId, to: "active", actorId: null });
    const agent = server.store.agents.get(agentId as never)!;
    const token = server.tokens.mint({ runId: "run_team_scope" as never, agentId: agent.id, actorId: agent.actor_id });

    // A message from a wholly unrelated agent, elsewhere in the org.
    const { agentId: otherId } = bootstrapAgent();
    const other = server.store.agents.get(otherId as never)!;
    const otherThread = server.store.commands.getOrCreateThread("workstream", "other-anchor");
    server.store.commands.sendMessage({
      thread_id: otherThread.id,
      from_actor_id: other.actor_id,
      to_actor_id: server.store.commands.getOrCreateHumanActor(),
      type: "status",
      body_md: "unobtainium supply chain secured",
      refs: [],
      visibility: "normal",
    });

    const res = await server.app.inject({
      method: "POST",
      url: "/api/org-tools/search_history",
      headers: { authorization: `Bearer ${token}` },
      payload: { query: "unobtainium", scope: "team" },
    });
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    // A teamless agent's "team" is just itself — the other agent's message must not leak in.
    expect(body.data.hits.length).toBe(0);
  });
});
