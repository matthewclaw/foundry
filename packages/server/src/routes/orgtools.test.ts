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

describe("E8.1 — delegation end-to-end: delegate -> spawn -> deliver -> accept/reject -> escalate", () => {
  it("A delegates to B: a workstream+run spawn for B, task goes in_progress immediately", async () => {
    const { agentId: aId, wsId: aWsId } = bootstrapAgent();
    const { agentId: bId } = bootstrapAgent();
    const a = server.store.agents.get(aId as never)!;
    const tokenA = server.tokens.mint({ runId: "run_a" as never, agentId: a.id, actorId: a.actor_id });

    const before = capturedSpecs.length;
    const res = await server.app.inject({
      method: "POST",
      url: "/api/org-tools/delegate_task",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { title: "Build X", spec_md: "build it", acceptance_criteria_md: "AC", assignee_agent_id: bId },
    });
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    const taskId = body.data.task_id;

    // A workstream was spawned for B, origin-tagged with the task, and a run enqueued
    // (bootstrapAgent already gave B one "human"-origin workstream — this is the new one).
    const bWs = server.store.workstreams.list({ agent_id: bId as never }).find((ws) => ws.task_id === taskId)!;
    expect(bWs.origin).toBe(`task:${taskId}`);
    expect(bWs.task_id).toBe(taskId);
    expect(capturedSpecs.length).toBeGreaterThan(before);

    // The task is already in_progress — the eager transition, not waiting on the run.
    expect(server.store.tasks.get(taskId)!.state).toBe("in_progress");
    void aWsId;
  });

  it("delegate_task via a routing spec resolves to the agent's id, not the whole Agent object (regression)", async () => {
    const { agentId: aId } = bootstrapAgent();
    const { agentId: bId } = bootstrapAgent();
    const a = server.store.agents.get(aId as never)!;
    const tokenA = server.tokens.mint({ runId: "run_a2" as never, agentId: a.id, actorId: a.actor_id });

    const res = await server.app.inject({
      method: "POST",
      url: "/api/org-tools/delegate_task",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { title: "Build Y", spec_md: "build it", acceptance_criteria_md: "AC", routing: { role: "Backend" } },
    });
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    const task = server.store.tasks.get(body.data.task_id)!;
    // Bug would have stored the serialized Agent object as assignee_agent_id.
    expect(task.assignee_agent_id === aId || task.assignee_agent_id === bId).toBe(true);
    expect(typeof task.assignee_agent_id).toBe("string");
  });

  it("B delivers: completion message posts, task -> delivered, A's workstream is re-triggered", async () => {
    const { agentId: aId } = bootstrapAgent();
    const { agentId: bId } = bootstrapAgent();
    const a = server.store.agents.get(aId as never)!;
    const b = server.store.agents.get(bId as never)!;
    const tokenA = server.tokens.mint({ runId: "run_a3" as never, agentId: a.id, actorId: a.actor_id });

    const delegateRes = await server.app.inject({
      method: "POST",
      url: "/api/org-tools/delegate_task",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { title: "Build Z", spec_md: "build it", acceptance_criteria_md: "AC", assignee_agent_id: bId },
    });
    const taskId = JSON.parse(delegateRes.body).data.task_id;
    await idle();

    const specsBeforeDeliver = capturedSpecs.length;
    const tokenB = server.tokens.mint({ runId: "run_b" as never, agentId: b.id, actorId: b.actor_id });
    const deliverRes = await server.app.inject({
      method: "POST",
      url: "/api/org-tools/deliver_task",
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { task_id: taskId, summary_md: "done", artifact_refs: [] },
    });
    expect(JSON.parse(deliverRes.body)).toMatchObject({ ok: true });
    expect(server.store.tasks.get(taskId)!.state).toBe("delivered");
    // A's own (root) workstream got re-triggered with a fresh run for the deliverable.
    expect(capturedSpecs.length).toBeGreaterThan(specsBeforeDeliver);

    // The completion message stays "normal" — A has a workstream to be re-triggered
    // into, it's not surfaced to the human inbox.
    const thread = server.store.messages.getThread(
      server.store.commands.getOrCreateThread("task", taskId).id
    )!;
    const msgs = server.store.messages.listByThread(thread.id);
    const completion = msgs.find((m) => m.type === "completion")!;
    expect(completion.visibility).toBe("normal");
  });

  it("A accepts the delivered task via the accept_task org-tool: task -> done", async () => {
    const { agentId: aId } = bootstrapAgent();
    const { agentId: bId } = bootstrapAgent();
    const a = server.store.agents.get(aId as never)!;
    const b = server.store.agents.get(bId as never)!;
    const tokenA = server.tokens.mint({ runId: "run_a4" as never, agentId: a.id, actorId: a.actor_id });

    const delegateRes = await server.app.inject({
      method: "POST",
      url: "/api/org-tools/delegate_task",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { title: "Build W", spec_md: "build it", acceptance_criteria_md: "AC", assignee_agent_id: bId },
    });
    const taskId = JSON.parse(delegateRes.body).data.task_id;
    await idle();

    const tokenB = server.tokens.mint({ runId: "run_b4" as never, agentId: b.id, actorId: b.actor_id });
    await server.app.inject({
      method: "POST",
      url: "/api/org-tools/deliver_task",
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { task_id: taskId, summary_md: "done", artifact_refs: [] },
    });

    const acceptRes = await server.app.inject({
      method: "POST",
      url: "/api/org-tools/accept_task",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { task_id: taskId },
    });
    expect(JSON.parse(acceptRes.body)).toMatchObject({ ok: true });
    expect(server.store.tasks.get(taskId)!.state).toBe("done");
  });

  it("rejecting under the cap sends the task back to in_progress and re-triggers B; hitting the cap escalates instead (F12)", async () => {
    const { agentId: aId } = bootstrapAgent();
    const { agentId: bId } = bootstrapAgent();
    const a = server.store.agents.get(aId as never)!;
    const b = server.store.agents.get(bId as never)!;
    const tokenA = server.tokens.mint({ runId: "run_a5" as never, agentId: a.id, actorId: a.actor_id });

    const delegateRes = await server.app.inject({
      method: "POST",
      url: "/api/org-tools/delegate_task",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { title: "Build V", spec_md: "build it", acceptance_criteria_md: "AC", assignee_agent_id: bId },
    });
    const taskId = JSON.parse(delegateRes.body).data.task_id;
    await idle();
    const tokenB = server.tokens.mint({ runId: "run_b5" as never, agentId: b.id, actorId: b.actor_id });

    // default max_rejections = 2 — reject twice (under cap both times: rejection_count
    // becomes 1, then 2 — checkRejection trips at >= max_rejections, so the 2nd rejection
    // is the one that escalates).
    for (let i = 0; i < 2; i++) {
      await server.app.inject({
        method: "POST",
        url: "/api/org-tools/deliver_task",
        headers: { authorization: `Bearer ${tokenB}` },
        payload: { task_id: taskId, summary_md: `attempt ${i}`, artifact_refs: [] },
      });
      const rejectRes = await server.app.inject({
        method: "POST",
        url: "/api/org-tools/reject_task",
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { task_id: taskId, reason: `not good enough (${i})` },
      });
      const body = JSON.parse(rejectRes.body);
      expect(body.ok).toBe(true);
      if (i === 0) {
        expect(body.data.escalated).toBe(false);
        expect(server.store.tasks.get(taskId)!.state).toBe("in_progress");
      } else {
        expect(body.data.escalated).toBe(true);
        // Stays rejected — no auto-resume once escalated (OPEN_ISSUES #7).
        expect(server.store.tasks.get(taskId)!.state).toBe("rejected");
      }
    }

    // The escalation message reached the human, surfaced.
    const thread = server.store.commands.getOrCreateThread("task", taskId);
    const escalation = server.store.messages.listByThread(thread.id).find((m) => m.type === "escalation");
    expect(escalation).toBeDefined();
    expect(escalation!.visibility).toBe("surfaced");
  });
});

describe("E8.4 — thread round cap + auto-escalation (F5)", () => {
  it("agent-to-agent messages are capped at thread_round_cap; human-agent messages are never capped", async () => {
    const { agentId: aId } = bootstrapAgent();
    const { agentId: bId } = bootstrapAgent();
    const a = server.store.agents.get(aId as never)!;
    const b = server.store.agents.get(bId as never)!;
    const tokenA = server.tokens.mint({ runId: "run_e8_4_a" as never, agentId: a.id, actorId: a.actor_id });
    const tokenB = server.tokens.mint({ runId: "run_e8_4_b" as never, agentId: b.id, actorId: b.actor_id });
    const human = server.store.commands.getOrCreateHumanActor();

    // Send 4 agent-to-agent messages (should all succeed with default cap = 4)
    for (let i = 0; i < 4; i++) {
      const res = await server.app.inject({
        method: "POST",
        url: "/api/org-tools/send_message",
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { to_actor_id: b.actor_id, type: "status", body_md: `Message ${i}` },
      });
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true, `Message ${i} should succeed`);
    }

    // The 5th agent-to-agent message should be refused with thread_round_cap
    const res5 = await server.app.inject({
      method: "POST",
      url: "/api/org-tools/send_message",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { to_actor_id: b.actor_id, type: "status", body_md: "Message 5" },
    });
    const body5 = JSON.parse(res5.body);
    expect(body5.ok).toBe(false);
    expect(body5.error.code).toBe("thread_round_cap");

    // An escalation message should have been sent to the human
    const thread = server.store.commands.getOrCreateThread("workstream", b.actor_id);
    const messages = server.store.messages.listByThread(thread.id);
    const escalation = messages.find((m) => m.type === "escalation" && m.visibility === "surfaced");
    expect(escalation).toBeDefined();

    // Sending the same message again should be refused but NOT create another escalation
    const res6 = await server.app.inject({
      method: "POST",
      url: "/api/org-tools/send_message",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { to_actor_id: b.actor_id, type: "status", body_md: "Message 6" },
    });
    const body6 = JSON.parse(res6.body);
    expect(body6.ok).toBe(false);
    expect(body6.error.code).toBe("thread_round_cap");

    const messagesAfter = server.store.messages.listByThread(thread.id);
    const escalationsAfter = messagesAfter.filter((m) => m.type === "escalation" && m.visibility === "surfaced");
    expect(escalationsAfter.length).toBe(1); // Still just one escalation

    // Human-to-agent messages are never capped (no limit on human conversations)
    const tokenHuman = server.tokens.mint({ runId: "run_human_e8_4" as never, agentId: a.id, actorId: human });
    for (let i = 0; i < 10; i++) {
      const res = await server.app.inject({
        method: "POST",
        url: "/api/org-tools/send_message",
        headers: { authorization: `Bearer ${tokenHuman}` },
        payload: { to_actor_id: a.actor_id, type: "status", body_md: `Human message ${i}` },
      });
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true, `Human message ${i} should never be capped`);
    }
  });
});

describe("E8.5 — routing failure surfaces to inbox (F11)", () => {
  it("delegate_task with unmatched routing spec both returns error and fires surfaced escalation", async () => {
    const { agentId: delegatorId } = bootstrapAgent();
    const delegator = server.store.agents.get(delegatorId as never)!;
    const token = server.tokens.mint({ runId: "run_e8_5" as never, agentId: delegator.id, actorId: delegator.actor_id });

    const res = await server.app.inject({
      method: "POST",
      url: "/api/org-tools/delegate_task",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: "Impossible routing",
        spec_md: "find someone impossible",
        acceptance_criteria_md: "AC",
        routing: { role: "NonexistentRole" },
      },
    });
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("routing_failed");

    // The delegator's run also got a surfaced escalation message on their workstream thread
    const thread = server.store.commands.getOrCreateThread("workstream", delegator.id as string);
    const messages = server.store.messages.listByThread(thread.id);
    const escalation = messages.find((m) => m.type === "escalation" && m.visibility === "surfaced");
    expect(escalation).toBeDefined();
    expect(escalation!.body_md).toContain("Delegation routing failed");
    expect(escalation!.body_md).toContain("NonexistentRole");
  });
});

describe("cancel_task — E8.6", () => {
  it("an agent can cancel its own subordinate's task via the org-tool", async () => {
    const { agentId: aId } = bootstrapAgent();
    const { agentId: bId } = bootstrapAgent();
    const a = server.store.agents.get(aId as never)!;
    const b = server.store.agents.get(bId as never)!;
    const tokenA = server.tokens.mint({ runId: "run_cancel_a" as never, agentId: a.id, actorId: a.actor_id });

    // Agent A delegates to Agent B
    const delegateRes = await server.app.inject({
      method: "POST",
      url: "/api/org-tools/delegate_task",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { title: "Task", spec_md: "work", acceptance_criteria_md: "AC", assignee_agent_id: bId },
    });
    const taskId = JSON.parse(delegateRes.body).data.task_id;
    await idle();

    // Agent A cancels the task
    const cancelRes = await server.app.inject({
      method: "POST",
      url: "/api/org-tools/cancel_task",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { task_id: taskId, reason: "no longer needed" },
    });
    expect(cancelRes.statusCode).toBe(200);
    const body = JSON.parse(cancelRes.body);
    expect(body.ok).toBe(true);

    // Task is cancelled
    expect(server.store.tasks.get(taskId)!.state).toBe("cancelled");

    // Notification was sent to B
    const thread = server.store.commands.getOrCreateThread("task", taskId);
    const notification = server.store.messages.listByThread(thread.id).find(
      (m) => m.type === "status" && m.body_md.includes("cancelled")
    );
    expect(notification).toBeDefined();
    expect(notification!.to_actor_id).toBe(b.actor_id);
  });

  it("cancels a task subtree when called with a parent task", async () => {
    const { agentId: rootId } = bootstrapAgent();
    const { agentId: childId } = bootstrapAgent();
    const root = server.store.agents.get(rootId as never)!;
    const child = server.store.agents.get(childId as never)!;
    const tokenRoot = server.tokens.mint({ runId: "run_root_cancel" as never, agentId: root.id, actorId: root.actor_id });

    // Root delegates to Child
    const delegateRes = await server.app.inject({
      method: "POST",
      url: "/api/org-tools/delegate_task",
      headers: { authorization: `Bearer ${tokenRoot}` },
      payload: { title: "Parent", spec_md: "work", acceptance_criteria_md: "AC", assignee_agent_id: childId },
    });
    const parentTaskId = JSON.parse(delegateRes.body).data.task_id;
    await idle();

    // Child's token must resolve (via its run's workstream) back to parentTaskId, or
    // its own further delegation below would land as an unrelated root task instead of
    // parentTaskId's child — mint it against the real workstream/run delegate_task spawned.
    const childWs = server.store.workstreams.list({ agent_id: childId as never }).find((ws) => ws.task_id === parentTaskId)!;
    const childRun = server.store.runs.list({ workstream_id: childWs.id })[0]!;
    const tokenChild = server.tokens.mint({ runId: childRun.id, agentId: child.id, actorId: child.actor_id });

    // Child further delegates to another agent
    const { agentId: grandchildId } = bootstrapAgent();
    const grandchild = server.store.agents.get(grandchildId as never)!;
    const delegateRes2 = await server.app.inject({
      method: "POST",
      url: "/api/org-tools/delegate_task",
      headers: { authorization: `Bearer ${tokenChild}` },
      payload: {
        title: "Child",
        spec_md: "subwork",
        acceptance_criteria_md: "AC2",
        assignee_agent_id: grandchildId,
      },
    });
    const childTaskId = JSON.parse(delegateRes2.body).data.task_id;
    await idle();

    // Root cancels the parent task — should cascade to child
    const cancelRes = await server.app.inject({
      method: "POST",
      url: "/api/org-tools/cancel_task",
      headers: { authorization: `Bearer ${tokenRoot}` },
      payload: { task_id: parentTaskId, reason: "cascade test" },
    });
    expect(cancelRes.statusCode).toBe(200);

    // Both tasks are cancelled
    expect(server.store.tasks.get(parentTaskId)!.state).toBe("cancelled");
    expect(server.store.tasks.get(childTaskId)!.state).toBe("cancelled");

    // Notifications sent to both assignees
    const parentThread = server.store.commands.getOrCreateThread("task", parentTaskId);
    const parentNotif = server.store.messages
      .listByThread(parentThread.id)
      .find((m) => m.type === "status" && m.body_md.includes("cancelled"));
    expect(parentNotif!.to_actor_id).toBe(child.actor_id);

    const childThread = server.store.commands.getOrCreateThread("task", childTaskId);
    const childNotif = server.store.messages
      .listByThread(childThread.id)
      .find((m) => m.type === "status" && m.body_md.includes("cancelled"));
    expect(childNotif!.to_actor_id).toBe(grandchild.actor_id);
  });
});
