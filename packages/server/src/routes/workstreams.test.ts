/**
 * E5.3 — workstream command API tests
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type FoundryServer } from "../server.js";
import { createFakeAdapter, loadScenario } from "@foundry/adapter-fake";
import { newAgentId } from "@foundry/core";

describe("Workstream routes (E5.3)", () => {
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

  async function createAgent() {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/agents",
      payload: {
        name: "Test Agent",
        role: "worker",
        charter_md: "# Charter",
        engine: { id: "fake", config: { scenarioName: "happy-path" } },
      },
    });
    return JSON.parse(res.body).id;
  }

  it("POST /api/workstreams 201 — creates a workstream", async () => {
    const agentId = await createAgent();

    const res = await server.app.inject({
      method: "POST",
      url: "/api/workstreams",
      payload: {
        agent_id: agentId,
        title: "My Workstream",
        goal_md: "# Goal\n\nDo something.",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("id");
    expect(body.agent_id).toBe(agentId);
    expect(body.title).toBe("My Workstream");
    expect(body.goal_md).toBe("# Goal\n\nDo something.");
    expect(body.state).toBe("open");
    expect(body.origin).toBe("human");
    expect(body.budget).toEqual({
      limit_usd: null,
      limit_tokens: null,
      spent_usd: 0,
      spent_tokens: 0,
    });

    // Verify stored
    const stored = server.store.workstreams.get(body.id);
    expect(stored).toBeDefined();
  });

  it("POST /api/workstreams with budget", async () => {
    const agentId = await createAgent();

    const res = await server.app.inject({
      method: "POST",
      url: "/api/workstreams",
      payload: {
        agent_id: agentId,
        title: "Budgeted WS",
        goal_md: "# Goal",
        budget: {
          limit_usd: 10,
          limit_tokens: 5000,
          spent_usd: 0,
          spent_tokens: 0,
        },
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.budget).toEqual({
      limit_usd: 10,
      limit_tokens: 5000,
      spent_usd: 0,
      spent_tokens: 0,
    });
  });

  it("POST /api/workstreams 404 — agent not found", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/workstreams",
      payload: {
        // Well-formed but nonexistent id: passes schema validation, hits the 404 path.
        agent_id: newAgentId(),
        title: "WS",
        goal_md: "# Goal",
      },
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.title).toContain("Agent not found");
  });

  it("POST /api/workstreams 400 — invalid body", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/workstreams",
      payload: {
        // missing required fields
        title: "",
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it("POST /api/workstreams/:id/messages 202 — sends message and enqueues run", async () => {
    const agentId = await createAgent();

    // Create workstream
    const wsRes = await server.app.inject({
      method: "POST",
      url: "/api/workstreams",
      payload: {
        agent_id: agentId,
        title: "WS",
        goal_md: "# Goal",
      },
    });
    const workstreamId = JSON.parse(wsRes.body).id;

    // Send message
    const res = await server.app.inject({
      method: "POST",
      url: `/api/workstreams/${workstreamId}/messages`,
      payload: {
        kind: "message",
        body_md: "# Please do this",
      },
    });

    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("message_id");
    expect(body).toHaveProperty("run_id");

    // Verify message stored
    const message = server.store.messages.get(body.message_id);
    expect(message).toBeDefined();
    expect(message?.type).toBe("status");
    expect(message?.body_md).toBe("# Please do this");

    // Verify run was created
    const run = server.store.runs.get(body.run_id);
    expect(run).toBeDefined();
    expect(run?.workstream_id).toBe(workstreamId);
  });

  it("POST /api/workstreams/:id/messages with kind='redirect'", async () => {
    const agentId = await createAgent();

    const wsRes = await server.app.inject({
      method: "POST",
      url: "/api/workstreams",
      payload: {
        agent_id: agentId,
        title: "WS",
        goal_md: "# Goal",
      },
    });
    const workstreamId = JSON.parse(wsRes.body).id;

    const res = await server.app.inject({
      method: "POST",
      url: `/api/workstreams/${workstreamId}/messages`,
      payload: {
        kind: "redirect",
        body_md: "# Redirecting you elsewhere",
      },
    });

    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    const message = server.store.messages.get(body.message_id);
    expect(message?.type).toBe("redirect");
  });

  it("POST /api/workstreams/:id/messages 404 — workstream not found", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/workstreams/nonexistent/messages",
      payload: {
        kind: "message",
        body_md: "# Test",
      },
    });

    expect(res.statusCode).toBe(404);
  });

  it("POST /api/workstreams/:id/messages 400 — invalid body", async () => {
    const agentId = await createAgent();

    const wsRes = await server.app.inject({
      method: "POST",
      url: "/api/workstreams",
      payload: {
        agent_id: agentId,
        title: "WS",
        goal_md: "# Goal",
      },
    });
    const workstreamId = JSON.parse(wsRes.body).id;

    const res = await server.app.inject({
      method: "POST",
      url: `/api/workstreams/${workstreamId}/messages`,
      payload: {
        kind: "invalid",
        body_md: "# Test",
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it("E5.3 AC: human message on idle workstream schedules a fake run end-to-end", async () => {
    const agentId = await createAgent();

    const wsRes = await server.app.inject({
      method: "POST",
      url: "/api/workstreams",
      payload: {
        agent_id: agentId,
        title: "WS",
        goal_md: "# Goal",
      },
    });
    const workstreamId = JSON.parse(wsRes.body).id;

    // Send message to trigger run
    const msgRes = await server.app.inject({
      method: "POST",
      url: `/api/workstreams/${workstreamId}/messages`,
      payload: {
        kind: "message",
        body_md: "# Please work on this",
      },
    });

    expect(msgRes.statusCode).toBe(202);
    const { run_id } = JSON.parse(msgRes.body);

    // Poll run until completed (up to 5 seconds, 10ms interval)
    const maxAttempts = 500;
    let run = server.store.runs.get(run_id);
    let attempts = 0;

    while (run && run.state !== "completed" && attempts < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      run = server.store.runs.get(run_id);
      attempts++;
    }

    expect(run).toBeDefined();
    expect(run?.state).toBe("completed");
    expect(run?.result?.outcome).toBe("completed");
  });

  it("POST /api/workstreams/:id/close 200 — closes workstream", async () => {
    const agentId = await createAgent();

    const wsRes = await server.app.inject({
      method: "POST",
      url: "/api/workstreams",
      payload: {
        agent_id: agentId,
        title: "WS",
        goal_md: "# Goal",
      },
    });
    const workstreamId = JSON.parse(wsRes.body).id;

    const res = await server.app.inject({
      method: "POST",
      url: `/api/workstreams/${workstreamId}/close`,
      payload: { reason: "Done" },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.state).toBe("closed");

    // Verify stored
    const stored = server.store.workstreams.get(workstreamId);
    expect(stored?.state).toBe("closed");
  });

  it("POST /api/workstreams/:id/close 404 — workstream not found", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/workstreams/nonexistent/close",
      payload: {},
    });

    expect(res.statusCode).toBe(404);
  });

  it("POST /api/workstreams/:id/close twice → 409 invalid_transition", async () => {
    const agentId = await createAgent();

    const wsRes = await server.app.inject({
      method: "POST",
      url: "/api/workstreams",
      payload: {
        agent_id: agentId,
        title: "WS",
        goal_md: "# Goal",
      },
    });
    const workstreamId = JSON.parse(wsRes.body).id;

    // First close
    const first = await server.app.inject({
      method: "POST",
      url: `/api/workstreams/${workstreamId}/close`,
      payload: {},
    });
    expect(first.statusCode).toBe(200);

    // Second close
    const second = await server.app.inject({
      method: "POST",
      url: `/api/workstreams/${workstreamId}/close`,
      payload: {},
    });
    expect(second.statusCode).toBe(409);
    const body = JSON.parse(second.body);
    expect(body.code).toBe("invalid_transition");
  });

  it("POST /api/runs/:id/cancel 202 — cancels a run", async () => {
    const agentId = await createAgent();

    const wsRes = await server.app.inject({
      method: "POST",
      url: "/api/workstreams",
      payload: {
        agent_id: agentId,
        title: "WS",
        goal_md: "# Goal",
      },
    });
    const workstreamId = JSON.parse(wsRes.body).id;

    const msgRes = await server.app.inject({
      method: "POST",
      url: `/api/workstreams/${workstreamId}/messages`,
      payload: {
        kind: "message",
        body_md: "# Test",
      },
    });
    const { run_id } = JSON.parse(msgRes.body);

    const res = await server.app.inject({
      method: "POST",
      url: `/api/runs/${run_id}/cancel`,
      payload: { reason: "User cancelled" },
    });

    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
  });

  it("POST /api/runs/:id/cancel 404 — run not found", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/runs/nonexistent/cancel",
      payload: {},
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.title).toContain("Run not found");
  });

  it("POST /api/runs/:id/cancel 400 — invalid body", async () => {
    const agentId = await createAgent();

    const wsRes = await server.app.inject({
      method: "POST",
      url: "/api/workstreams",
      payload: {
        agent_id: agentId,
        title: "WS",
        goal_md: "# Goal",
      },
    });
    const workstreamId = JSON.parse(wsRes.body).id;

    const msgRes = await server.app.inject({
      method: "POST",
      url: `/api/workstreams/${workstreamId}/messages`,
      payload: {
        kind: "message",
        body_md: "# Test",
      },
    });
    const { run_id } = JSON.parse(msgRes.body);

    const res = await server.app.inject({
      method: "POST",
      url: `/api/runs/${run_id}/cancel`,
      payload: { reason: 123 }, // invalid
    });

    expect(res.statusCode).toBe(400);
  });
});
