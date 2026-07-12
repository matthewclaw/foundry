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
});
