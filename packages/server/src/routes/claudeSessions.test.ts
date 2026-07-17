/**
 * GET /api/claude-sessions · GET /api/claude-sessions/:projectDir/:sessionId ·
 * POST .../reveal
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type FoundryServer } from "../server.js";
import { createFakeAdapter, loadScenario } from "@foundry/adapter-fake";

// revealInFileExplorer launches a real OS file browser — stub it so tests don't pop
// windows open, while every other discover.ts export stays real.
vi.mock("../claudeSessions/discover.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../claudeSessions/discover.js")>();
  return { ...actual, revealInFileExplorer: vi.fn() };
});
import { revealInFileExplorer } from "../claudeSessions/discover.js";

let dir: string | undefined;
let sessionsRoot: string | undefined;
let server: FoundryServer | undefined;

afterEach(async () => {
  vi.mocked(revealInFileExplorer).mockClear();
  if (server) {
    await server.stop();
    server = undefined;
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
  sessionsRoot = undefined;
});

function writeJsonl(path: string, lines: Record<string, unknown>[]): void {
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
}

function setupServer(): FoundryServer {
  dir = mkdtempSync(join(tmpdir(), "foundry-claude-sessions-test-"));
  sessionsRoot = join(dir, "claude-projects");
  mkdirSync(sessionsRoot, { recursive: true });
  server = createServer({
    dataDir: join(dir, "data"),
    adapters: { fake: createFakeAdapter(loadScenario("happy-path")) },
    claudeSessionsRoot: sessionsRoot,
  });
  return server;
}

describe("claude session routes", () => {
  it("GET /api/claude-sessions lists sessions grouped by folder", async () => {
    const s = setupServer();
    const projDir = join(sessionsRoot!, "c--repos-projA");
    mkdirSync(projDir, { recursive: true });
    writeJsonl(join(projDir, "11111111-1111-1111-1111-111111111111.jsonl"), [
      { type: "user", isSidechain: false, cwd: "C:\\repos\\projA", message: { role: "user", content: "Hello" } },
    ]);

    const res = await s.app.inject({ method: "GET", url: "/api/claude-sessions" });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].repoPath).toBe("C:\\repos\\projA");
    expect(body.groups[0].sessions).toHaveLength(1);
    expect(body.groups[0].sessions[0].preview).toBe("Hello");
    expect(body.groups[0].sessions[0].filePath).toBe(
      join(projDir, "11111111-1111-1111-1111-111111111111.jsonl")
    );
  });

  it("GET /api/claude-sessions returns an empty group list when the root has no projects", async () => {
    const s = setupServer();
    const res = await s.app.inject({ method: "GET", url: "/api/claude-sessions" });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ groups: [] });
  });

  it("GET /api/claude-sessions/:projectDir/:sessionId returns the full parsed transcript", async () => {
    const s = setupServer();
    const projDir = join(sessionsRoot!, "c--repos-projA");
    mkdirSync(projDir, { recursive: true });
    const sessionId = "22222222-2222-2222-2222-222222222222";
    writeJsonl(join(projDir, `${sessionId}.jsonl`), [
      { type: "user", isSidechain: false, timestamp: "2026-07-15T00:00:00Z", message: { role: "user", content: "Hi" } },
      {
        type: "assistant",
        isSidechain: false,
        timestamp: "2026-07-15T00:00:01Z",
        message: { role: "assistant", content: [{ type: "text", text: "Hello back" }] },
      },
      { type: "user", isSidechain: true, message: { role: "user", content: "subagent-only, must not appear" } },
    ]);

    const res = await s.app.inject({ method: "GET", url: `/api/claude-sessions/c--repos-projA/${sessionId}` });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.turns).toEqual([
      { role: "user", text: "Hi", timestamp: "2026-07-15T00:00:00Z" },
      { role: "assistant", text: "Hello back", timestamp: "2026-07-15T00:00:01Z" },
    ]);
  });

  it("GET /api/claude-sessions/:projectDir/:sessionId returns 400 for a path-traversal attempt", async () => {
    const s = setupServer();
    const res = await s.app.inject({
      method: "GET",
      url: "/api/claude-sessions/..%2F..%2Fetc/22222222-2222-2222-2222-222222222222",
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toHaveProperty("title", "Bad Request");
  });

  it("GET /api/claude-sessions/:projectDir/:sessionId returns 404 for a well-formed but absent id", async () => {
    const s = setupServer();
    const projDir = join(sessionsRoot!, "c--repos-projA");
    mkdirSync(projDir, { recursive: true });

    const res = await s.app.inject({
      method: "GET",
      url: "/api/claude-sessions/c--repos-projA/99999999-9999-9999-9999-999999999999",
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toHaveProperty("title", "Not Found");
  });

  it("POST .../reveal validates the same way as GET and calls revealInFileExplorer with the resolved path", async () => {
    const s = setupServer();
    const projDir = join(sessionsRoot!, "c--repos-projA");
    mkdirSync(projDir, { recursive: true });
    const sessionId = "33333333-3333-3333-3333-333333333333";
    writeJsonl(join(projDir, `${sessionId}.jsonl`), [{ type: "user", message: { role: "user", content: "hi" } }]);

    const res = await s.app.inject({ method: "POST", url: `/api/claude-sessions/c--repos-projA/${sessionId}/reveal` });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(revealInFileExplorer).toHaveBeenCalledWith(join(projDir, `${sessionId}.jsonl`));
  });

  it("POST .../reveal returns 404 for a well-formed but absent id and never calls revealInFileExplorer", async () => {
    const s = setupServer();
    const projDir = join(sessionsRoot!, "c--repos-projA");
    mkdirSync(projDir, { recursive: true });

    const res = await s.app.inject({
      method: "POST",
      url: "/api/claude-sessions/c--repos-projA/99999999-9999-9999-9999-999999999999/reveal",
    });

    expect(res.statusCode).toBe(404);
    expect(revealInFileExplorer).not.toHaveBeenCalled();
  });
});
