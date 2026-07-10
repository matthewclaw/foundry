/**
 * E5.2 — agent CRUD + lifecycle API tests
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type FoundryServer } from "../server.js";
import { createFakeAdapter, loadScenario } from "@foundry/adapter-fake";

describe("Agent routes (E5.2)", () => {
  let server: FoundryServer;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync("foundry-test-");
    server = createServer({
      dataDir: tempDir,
      dbPath: ":memory:",
      adapters: {
        fake: createFakeAdapter(loadScenario("happy-path")),
      },
    });
  });

  afterEach(() => {
    try {
      server.store.close();
    } catch {
      /* double close ok */
    }
    try {
      rmSync(tempDir, { recursive: true });
    } catch {
      /* already removed ok */
    }
  });

  it("POST /api/agents 201 — creates an agent in active state", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/agents",
      payload: {
        name: "Test Agent",
        role: "researcher",
        charter_md: "# Agent Charter\n\nA test agent.",
        engine: { id: "fake" },
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("id");
    expect(body.name).toBe("Test Agent");
    expect(body.role).toBe("researcher");
    expect(body.state).toBe("active");
    expect(body.engine.id).toBe("fake");
    expect(body.memory_ref).toContain("agents/");
    expect(body.memory_ref).toContain("/memory");

    // Verify it was stored
    const stored = server.store.agents.get(body.id);
    expect(stored).toBeDefined();
    expect(stored?.state).toBe("active");
  });

  it("POST /api/agents 201 — events include agent_created + agent_activated", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/agents",
      payload: {
        name: "Test Agent",
        role: "analyst",
        charter_md: "## Test",
        engine: { id: "fake" },
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    const agentId = body.id;

    // Read events from store
    const events = server.store.events.after(0, {
      entity_id: agentId,
      entity_type: "agent",
    });
    const types = events.map((e) => e.type);
    expect(types).toContain("agent_created");
    expect(types).toContain("agent_activated");
  });

  it("POST /api/agents 400 — rejects invalid body", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/agents",
      payload: {
        name: "",
        // missing required fields
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.title).toContain("Validation");
    expect(body.issues).toBeDefined();
  });

  it("PATCH /api/agents/:id 200 — updates charter only", async () => {
    // Create an agent first
    const createRes = await server.app.inject({
      method: "POST",
      url: "/api/agents",
      payload: {
        name: "Original",
        role: "worker",
        charter_md: "# Original Charter",
        engine: { id: "fake" },
      },
    });
    const agentId = JSON.parse(createRes.body).id;

    // Update charter
    const patchRes = await server.app.inject({
      method: "PATCH",
      url: `/api/agents/${agentId}`,
      payload: {
        charter_md: "# Updated Charter\n\nNew content.",
      },
    });

    expect(patchRes.statusCode).toBe(200);
    const body = JSON.parse(patchRes.body);
    expect(body.charter_version).toBe(2);

    // Verify events
    const events = server.store.events.after(0, {
      entity_id: agentId,
      entity_type: "agent",
    });
    const types = events.map((e) => e.type);
    expect(types).toContain("agent_charter_updated");

    // Verify charter body
    const charter = server.store.agents.getCharter(agentId, 2);
    expect(charter?.body_md).toBe("# Updated Charter\n\nNew content.");
  });

  it("PATCH /api/agents/:id 200 — rebinds engine, memory_ref unchanged", async () => {
    // Create an agent
    const createRes = await server.app.inject({
      method: "POST",
      url: "/api/agents",
      payload: {
        name: "Agent",
        role: "worker",
        charter_md: "# Charter",
        engine: { id: "fake", config: { test: true } },
      },
    });
    const agent = JSON.parse(createRes.body);
    const agentId = agent.id;
    const originalMemoryRef = agent.memory_ref;
    const originalCreatedAt = agent.created_at;

    // Rebind engine
    const patchRes = await server.app.inject({
      method: "PATCH",
      url: `/api/agents/${agentId}`,
      payload: {
        engine: { id: "claude-code", config: { other: false } },
      },
    });

    expect(patchRes.statusCode).toBe(200);
    const body = JSON.parse(patchRes.body);
    expect(body.engine.id).toBe("claude-code");
    expect(body.engine.config).toEqual({ other: false });
    expect(body.memory_ref).toBe(originalMemoryRef);
    expect(body.created_at).toBe(originalCreatedAt);

    // Verify event
    const events = server.store.events.after(0, {
      entity_id: agentId,
      entity_type: "agent",
    });
    const types = events.map((e) => e.type);
    expect(types).toContain("agent_engine_rebound");
  });

  it("PATCH /api/agents/:id 422 — rejects name change", async () => {
    const createRes = await server.app.inject({
      method: "POST",
      url: "/api/agents",
      payload: {
        name: "Original",
        role: "worker",
        charter_md: "# Charter",
        engine: { id: "fake" },
      },
    });
    const agentId = JSON.parse(createRes.body).id;

    const patchRes = await server.app.inject({
      method: "PATCH",
      url: `/api/agents/${agentId}`,
      payload: {
        name: "New Name",
      },
    });

    expect(patchRes.statusCode).toBe(422);
    const body = JSON.parse(patchRes.body);
    expect(body.title).toContain("Unprocessable");
    expect(body.code).toBe("policy_violation");
    expect(body.detail).toContain("OPEN_ISSUES #31");
  });

  it("PATCH /api/agents/:id 422 — rejects role change", async () => {
    const createRes = await server.app.inject({
      method: "POST",
      url: "/api/agents",
      payload: {
        name: "Agent",
        role: "analyst",
        charter_md: "# Charter",
        engine: { id: "fake" },
      },
    });
    const agentId = JSON.parse(createRes.body).id;

    const patchRes = await server.app.inject({
      method: "PATCH",
      url: `/api/agents/${agentId}`,
      payload: {
        role: "researcher",
      },
    });

    expect(patchRes.statusCode).toBe(422);
  });

  it("PATCH /api/agents/:id 422 — rejects team_id change", async () => {
    const createRes = await server.app.inject({
      method: "POST",
      url: "/api/agents",
      payload: {
        name: "Agent",
        role: "worker",
        charter_md: "# Charter",
        engine: { id: "fake" },
      },
    });
    const agentId = JSON.parse(createRes.body).id;

    // A well-formed team id, so the request passes schema validation and reaches the
    // route's #31 rejection (a malformed id would 400 at the Zod layer instead).
    const team = server.store.commands.createTeam({ name: "T2", description: "", default_policy: {} });
    const patchRes = await server.app.inject({
      method: "PATCH",
      url: `/api/agents/${agentId}`,
      payload: {
        team_id: team.id,
      },
    });

    expect(patchRes.statusCode).toBe(422);
  });

  it("PATCH /api/agents/:id 422 — rejects policy_overrides change", async () => {
    const createRes = await server.app.inject({
      method: "POST",
      url: "/api/agents",
      payload: {
        name: "Agent",
        role: "worker",
        charter_md: "# Charter",
        engine: { id: "fake" },
      },
    });
    const agentId = JSON.parse(createRes.body).id;

    const patchRes = await server.app.inject({
      method: "PATCH",
      url: `/api/agents/${agentId}`,
      payload: {
        policy_overrides: { max_depth: 5 },
      },
    });

    expect(patchRes.statusCode).toBe(422);
  });

  it("PATCH /api/agents/:id 404 — agent not found", async () => {
    const patchRes = await server.app.inject({
      method: "PATCH",
      url: "/api/agents/nonexistent",
      payload: {
        charter_md: "# New",
      },
    });

    expect(patchRes.statusCode).toBe(404);
  });

  it("POST /api/agents/:id/suspend → resume → retire flow", async () => {
    // Create agent
    const createRes = await server.app.inject({
      method: "POST",
      url: "/api/agents",
      payload: {
        name: "Lifecycle Agent",
        role: "worker",
        charter_md: "# Charter",
        engine: { id: "fake" },
      },
    });
    const agentId = JSON.parse(createRes.body).id;

    // Suspend
    const suspendRes = await server.app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/suspend`,
      payload: { reason: "Maintenance" },
    });
    expect(suspendRes.statusCode).toBe(200);
    let body = JSON.parse(suspendRes.body);
    expect(body.state).toBe("suspended");

    // Resume
    const resumeRes = await server.app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/resume`,
      payload: {},
    });
    expect(resumeRes.statusCode).toBe(200);
    body = JSON.parse(resumeRes.body);
    expect(body.state).toBe("active");

    // Retire
    const retireRes = await server.app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/retire`,
      payload: { reason: "End of service" },
    });
    expect(retireRes.statusCode).toBe(200);
    body = JSON.parse(retireRes.body);
    expect(body.state).toBe("retired");

    // Verify events
    const events = server.store.events.after(0, {
      entity_id: agentId,
      entity_type: "agent",
    });
    const types = events.map((e) => e.type);
    expect(types).toContain("agent_suspended");
    expect(types).toContain("agent_resumed");
    expect(types).toContain("agent_retired");
  });

  it("POST /api/agents/:id/suspend when already suspended → 409 invalid_transition", async () => {
    // Create and suspend
    const createRes = await server.app.inject({
      method: "POST",
      url: "/api/agents",
      payload: {
        name: "Agent",
        role: "worker",
        charter_md: "# Charter",
        engine: { id: "fake" },
      },
    });
    const agentId = JSON.parse(createRes.body).id;

    await server.app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/suspend`,
      payload: {},
    });

    // Try suspend again
    const res = await server.app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/suspend`,
      payload: {},
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("invalid_transition");
  });

  it("POST /api/agents/:id/retire with open tasks → 409 policy_violation", async () => {
    // Create agent
    const createRes = await server.app.inject({
      method: "POST",
      url: "/api/agents",
      payload: {
        name: "Agent",
        role: "worker",
        charter_md: "# Charter",
        engine: { id: "fake" },
      },
    });
    const agentId = JSON.parse(createRes.body).id;

    // Create an open task
    const human = server.store.commands.getOrCreateHumanActor();
    server.store.commands.createTask({
      delegator_actor_id: human,
      assignee_agent_id: agentId,
      spec_md: "# Task spec",
      acceptance_criteria_md: "# AC",
      budget: {
        limit_usd: null,
        limit_tokens: null,
        spent_usd: 0,
        spent_tokens: 0,
      },
    });

    // Try retire
    const res = await server.app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/retire`,
      payload: {},
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("policy_violation");
    expect(body.detail).toContain("open task");
  });

  it("POST /api/agents/:id/retire with no open tasks → 200", async () => {
    // Create agent
    const createRes = await server.app.inject({
      method: "POST",
      url: "/api/agents",
      payload: {
        name: "Agent",
        role: "worker",
        charter_md: "# Charter",
        engine: { id: "fake" },
      },
    });
    const agentId = JSON.parse(createRes.body).id;

    // Retire (no tasks)
    const res = await server.app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/retire`,
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.state).toBe("retired");
  });

  it("POST /api/agents/:id/retire then retire again → 409 invalid_transition", async () => {
    const createRes = await server.app.inject({
      method: "POST",
      url: "/api/agents",
      payload: {
        name: "Agent",
        role: "worker",
        charter_md: "# Charter",
        engine: { id: "fake" },
      },
    });
    const agentId = JSON.parse(createRes.body).id;

    // First retire
    const first = await server.app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/retire`,
      payload: {},
    });
    expect(first.statusCode).toBe(200);

    // Second retire
    const second = await server.app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/retire`,
      payload: {},
    });
    expect(second.statusCode).toBe(409);
  });

  it("Lifecycle endpoints 404 when agent not found", async () => {
    const res1 = await server.app.inject({
      method: "POST",
      url: "/api/agents/nonexistent/suspend",
      payload: {},
    });
    expect(res1.statusCode).toBe(404);

    const res2 = await server.app.inject({
      method: "POST",
      url: "/api/agents/nonexistent/resume",
      payload: {},
    });
    expect(res2.statusCode).toBe(404);

    const res3 = await server.app.inject({
      method: "POST",
      url: "/api/agents/nonexistent/retire",
      payload: {},
    });
    expect(res3.statusCode).toBe(404);
  });
});
