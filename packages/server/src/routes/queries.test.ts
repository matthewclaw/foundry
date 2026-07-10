/**
 * E5.4 — query endpoints return store projections 1:1
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Store } from "@foundry/store";
import { createServer, type FoundryServer } from "../server.js";
import { createFakeAdapter, loadScenario } from "@foundry/adapter-fake";

const ZERO_BUDGET = { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 };

let dir: string | undefined;
let server: FoundryServer | undefined;

afterEach(async () => {
  if (server) {
    await server.stop();
    server = undefined;
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function setupServer(): FoundryServer {
  if (!dir) dir = mkdtempSync(join(tmpdir(), "foundry-queries-test-"));
  server = createServer({
    dataDir: dir,
    adapters: { fake: createFakeAdapter(loadScenario("happy-path")) },
  });
  return server;
}

describe("E5.4 — query endpoints", () => {
  it("GET /api/org returns orgView projection", async () => {
    const s = setupServer();
    const team = s.store.commands.createTeam({ name: "Platform", description: "infra", default_policy: {} });
    const { agentId } = s.store.commands.createAgent({
      name: "Alice",
      role: "Engineer",
      team_id: team.id,
      engine_id: "fake",
      memory_ref: "agents/alice/memory",
      charter_body_md: "Build things",
    });
    s.store.commands.transitionAgentState({ id: agentId, to: "active", actorId: null });

    const expected = s.store.projections.orgView();
    const res = await s.app.inject({ method: "GET", url: "/api/org" });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(expected);
  });

  it("GET /api/inbox returns inbox projection", async () => {
    const s = setupServer();
    const team = s.store.commands.createTeam({ name: "Platform", description: "infra", default_policy: {} });
    const { agentId, actorId } = s.store.commands.createAgent({
      name: "Bob",
      role: "Engineer",
      team_id: team.id,
      engine_id: "fake",
      memory_ref: "agents/bob/memory",
      charter_body_md: "Fix bugs",
    });
    s.store.commands.transitionAgentState({ id: agentId, to: "active", actorId: null });

    const workstream = s.store.commands.createWorkstream({
      agent_id: agentId,
      title: "Issue 1",
      goal_md: "Fix it",
      origin: "human",
      budget: ZERO_BUDGET,
    });
    const thread = s.store.commands.getOrCreateThread("workstream", workstream.id);
    s.store.commands.sendMessage({
      thread_id: thread.id,
      from_actor_id: actorId,
      to_actor_id: agentId,
      type: "question",
      body_md: "Can you help?",
    });

    const expected = s.store.projections.inbox();
    const res = await s.app.inject({ method: "GET", url: "/api/inbox" });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(expected);
  });

  it("GET /api/agents/:id returns agentPage projection", async () => {
    const s = setupServer();
    const team = s.store.commands.createTeam({ name: "Platform", description: "infra", default_policy: {} });
    const { agentId } = s.store.commands.createAgent({
      name: "Charlie",
      role: "Engineer",
      team_id: team.id,
      engine_id: "fake",
      memory_ref: "agents/charlie/memory",
      charter_body_md: "Deploy code",
    });
    s.store.commands.transitionAgentState({ id: agentId, to: "active", actorId: null });

    const expected = s.store.projections.agentPage(agentId)!;
    const res = await s.app.inject({ method: "GET", url: `/api/agents/${agentId}` });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(expected);
  });

  it("GET /api/agents/:id returns 404 for unknown agent", async () => {
    const s = setupServer();
    const res = await s.app.inject({ method: "GET", url: "/api/agents/unknown-id" });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toHaveProperty("title", "Not Found");
  });

  it("GET /api/workstreams/:id/timeline returns timeline projection", async () => {
    const s = setupServer();
    const team = s.store.commands.createTeam({ name: "Platform", description: "infra", default_policy: {} });
    const { agentId } = s.store.commands.createAgent({
      name: "Dana",
      role: "Engineer",
      team_id: team.id,
      engine_id: "fake",
      memory_ref: "agents/dana/memory",
      charter_body_md: "Test code",
    });
    s.store.commands.transitionAgentState({ id: agentId, to: "active", actorId: null });

    const workstream = s.store.commands.createWorkstream({
      agent_id: agentId,
      title: "Issue 2",
      goal_md: "Test it",
      origin: "human",
      budget: ZERO_BUDGET,
    });

    const expected = s.store.projections.workstreamTimeline(workstream.id);
    const res = await s.app.inject({ method: "GET", url: `/api/workstreams/${workstream.id}/timeline` });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(expected);
  });

  it("GET /api/workstreams/:id/timeline supports limit and before query params", async () => {
    const s = setupServer();
    const team = s.store.commands.createTeam({ name: "Platform", description: "infra", default_policy: {} });
    const { agentId } = s.store.commands.createAgent({
      name: "Eve",
      role: "Engineer",
      team_id: team.id,
      engine_id: "fake",
      memory_ref: "agents/eve/memory",
      charter_body_md: "Monitor",
    });
    s.store.commands.transitionAgentState({ id: agentId, to: "active", actorId: null });

    const workstream = s.store.commands.createWorkstream({
      agent_id: agentId,
      title: "Issue 3",
      goal_md: "Monitor it",
      origin: "human",
      budget: ZERO_BUDGET,
    });

    const expected = s.store.projections.workstreamTimeline(workstream.id, { limit: 10, before: 100 });
    const res = await s.app.inject({
      method: "GET",
      url: `/api/workstreams/${workstream.id}/timeline?limit=10&before=100`,
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(expected);
  });

  it("GET /api/workstreams/:id/timeline returns 404 for unknown workstream", async () => {
    const s = setupServer();
    const res = await s.app.inject({ method: "GET", url: "/api/workstreams/unknown-ws/timeline" });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toHaveProperty("title", "Not Found");
  });

  it("GET /api/tasks/:id/tree returns delegationTree projection", async () => {
    const s = setupServer();
    const team = s.store.commands.createTeam({ name: "Platform", description: "infra", default_policy: {} });
    const { agentId, actorId } = s.store.commands.createAgent({
      name: "Frank",
      role: "Engineer",
      team_id: team.id,
      engine_id: "fake",
      memory_ref: "agents/frank/memory",
      charter_body_md: "Delegate",
    });
    s.store.commands.transitionAgentState({ id: agentId, to: "active", actorId: null });

    const task = s.store.commands.createTask({
      title: "Task 1",
      spec_md: "Do it",
      acceptance_criteria_md: "Done",
      delegator_actor_id: actorId,
      assignee_agent_id: agentId,
      parent_task_id: null,
      budget: ZERO_BUDGET,
    });

    const expected = s.store.projections.delegationTree(task.id);
    const res = await s.app.inject({ method: "GET", url: `/api/tasks/${task.id}/tree` });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(expected);
  });

  it("GET /api/tasks/:id/tree returns 404 for unknown task", async () => {
    const s = setupServer();
    const res = await s.app.inject({ method: "GET", url: "/api/tasks/unknown-task/tree" });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toHaveProperty("title", "Not Found");
  });

  it("GET /api/cost?scope=org returns costRollup for org scope", async () => {
    const s = setupServer();
    const team = s.store.commands.createTeam({ name: "Platform", description: "infra", default_policy: {} });
    const { agentId } = s.store.commands.createAgent({
      name: "Grace",
      role: "Engineer",
      team_id: team.id,
      engine_id: "fake",
      memory_ref: "agents/grace/memory",
      charter_body_md: "Cost",
    });
    s.store.commands.transitionAgentState({ id: agentId, to: "active", actorId: null });

    s.store.commands.createWorkstream({
      agent_id: agentId,
      title: "Issue 4",
      goal_md: "Cost tracking",
      origin: "human",
      budget: ZERO_BUDGET,
    });

    const expected = s.store.projections.costRollup({ level: "org" });
    const res = await s.app.inject({ method: "GET", url: "/api/cost?scope=org" });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(expected);
  });

  it("GET /api/cost defaults to scope=org", async () => {
    const s = setupServer();
    const expected = s.store.projections.costRollup({ level: "org" });
    const res = await s.app.inject({ method: "GET", url: "/api/cost" });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(expected);
  });

  it("GET /api/cost?scope=agent:<id> returns costRollup for agent scope", async () => {
    const s = setupServer();
    const team = s.store.commands.createTeam({ name: "Platform", description: "infra", default_policy: {} });
    const { agentId } = s.store.commands.createAgent({
      name: "Hank",
      role: "Engineer",
      team_id: team.id,
      engine_id: "fake",
      memory_ref: "agents/hank/memory",
      charter_body_md: "Agent cost",
    });
    s.store.commands.transitionAgentState({ id: agentId, to: "active", actorId: null });

    s.store.commands.createWorkstream({
      agent_id: agentId,
      title: "Issue 5",
      goal_md: "Agent cost tracking",
      origin: "human",
      budget: ZERO_BUDGET,
    });

    const expected = s.store.projections.costRollup({ level: "agent", agent_id: agentId });
    const res = await s.app.inject({ method: "GET", url: `/api/cost?scope=agent:${agentId}` });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(expected);
  });

  it("GET /api/cost?scope=team:<id> returns costRollup for team scope", async () => {
    const s = setupServer();
    const team = s.store.commands.createTeam({ name: "Platform", description: "infra", default_policy: {} });
    const { agentId } = s.store.commands.createAgent({
      name: "Iris",
      role: "Engineer",
      team_id: team.id,
      engine_id: "fake",
      memory_ref: "agents/iris/memory",
      charter_body_md: "Team cost",
    });
    s.store.commands.transitionAgentState({ id: agentId, to: "active", actorId: null });

    s.store.commands.createWorkstream({
      agent_id: agentId,
      title: "Issue 6",
      goal_md: "Team cost tracking",
      origin: "human",
      budget: ZERO_BUDGET,
    });

    const expected = s.store.projections.costRollup({ level: "team", team_id: team.id });
    const res = await s.app.inject({ method: "GET", url: `/api/cost?scope=team:${team.id}` });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(expected);
  });

  it("GET /api/cost?scope=workstream:<id> returns costRollup for workstream scope", async () => {
    const s = setupServer();
    const team = s.store.commands.createTeam({ name: "Platform", description: "infra", default_policy: {} });
    const { agentId } = s.store.commands.createAgent({
      name: "Jack",
      role: "Engineer",
      team_id: team.id,
      engine_id: "fake",
      memory_ref: "agents/jack/memory",
      charter_body_md: "Workstream cost",
    });
    s.store.commands.transitionAgentState({ id: agentId, to: "active", actorId: null });

    const workstream = s.store.commands.createWorkstream({
      agent_id: agentId,
      title: "Issue 7",
      goal_md: "Workstream cost tracking",
      origin: "human",
      budget: ZERO_BUDGET,
    });

    const expected = s.store.projections.costRollup({ level: "workstream", workstream_id: workstream.id });
    const res = await s.app.inject({ method: "GET", url: `/api/cost?scope=workstream:${workstream.id}` });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(expected);
  });

  it("GET /api/cost?scope=invalid returns 400", async () => {
    const s = setupServer();
    const res = await s.app.inject({ method: "GET", url: "/api/cost?scope=invalid" });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toHaveProperty("title", "Bad Request");
  });

  it("GET /api/cost?scope=agent: with no id returns 400", async () => {
    const s = setupServer();
    const res = await s.app.inject({ method: "GET", url: "/api/cost?scope=agent:" });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toHaveProperty("title", "Bad Request");
  });
});
