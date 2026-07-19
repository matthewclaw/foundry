/** Team routes: POST /api/teams. */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type FoundryServer } from "../server.js";
import { createFakeAdapter, loadScenario } from "@foundry/adapter-fake";

describe("Team routes", () => {
  let server: FoundryServer;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync("foundry-test-");
    server = createServer({
      dataDir: tempDir,
      dbPath: ":memory:",
      adapters: { fake: createFakeAdapter(loadScenario("happy-path")) },
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

  it("POST /api/teams 201 — creates a team with no default_policy given", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/teams",
      payload: { name: "Platform", description: "infra team" },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.name).toBe("Platform");
    expect(body.description).toBe("infra team");
    expect(body.default_policy).toEqual({});

    // Actually persisted — a subsequent agent can be created under it.
    expect(server.store.teams.get(body.id)).toMatchObject({ name: "Platform" });
  });

  it("POST /api/teams 201 — accepts a default_policy override", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/teams",
      payload: { name: "Core", description: "", default_policy: { max_depth: 2 } },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).default_policy).toMatchObject({ max_depth: 2 });
  });

  it("POST /api/teams 400 — rejects a missing name", async () => {
    const res = await server.app.inject({ method: "POST", url: "/api/teams", payload: { description: "x" } });
    expect(res.statusCode).toBe(400);
  });

  it("PATCH /api/teams/:id 200 — renames a team", async () => {
    const created = await server.app.inject({
      method: "POST",
      url: "/api/teams",
      payload: { name: "Platform", description: "infra team" },
    });
    const team = JSON.parse(created.body);

    const res = await server.app.inject({
      method: "PATCH",
      url: `/api/teams/${team.id}`,
      payload: { name: "Core Platform" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.name).toBe("Core Platform");
    expect(body.description).toBe("infra team");
    expect(server.store.teams.get(team.id)).toMatchObject({ name: "Core Platform" });
  });

  it("PATCH /api/teams/:id 404 — unknown team", async () => {
    const res = await server.app.inject({
      method: "PATCH",
      url: "/api/teams/01ARZ3NDEKTSV4RRFFQ69G5FAV",
      payload: { name: "X" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("DELETE /api/teams/:id 204 — deletes a team and unassigns member agents", async () => {
    const createdTeam = await server.app.inject({
      method: "POST",
      url: "/api/teams",
      payload: { name: "Platform", description: "infra team" },
    });
    const team = JSON.parse(createdTeam.body);

    const createdAgent = await server.app.inject({
      method: "POST",
      url: "/api/agents",
      payload: {
        name: "Orbit",
        role: "Backend Engineer",
        team_id: team.id,
        charter_md: "# Orbit",
        engine: { id: "fake" },
      },
    });
    const agent = JSON.parse(createdAgent.body);

    const res = await server.app.inject({ method: "DELETE", url: `/api/teams/${team.id}` });
    expect(res.statusCode).toBe(204);
    expect(server.store.teams.get(team.id)).toBeUndefined();
    expect(server.store.agents.get(agent.id)).toMatchObject({ team_id: null });
  });

  it("DELETE /api/teams/:id 404 — unknown team", async () => {
    const res = await server.app.inject({ method: "DELETE", url: "/api/teams/01ARZ3NDEKTSV4RRFFQ69G5FAV" });
    expect(res.statusCode).toBe(404);
  });
});
