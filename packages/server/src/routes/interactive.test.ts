/**
 * E13 — GET /api/workstreams/:id/interactive (WebSocket). Needs a real listening
 * server (unlike the other route tests' `app.inject()`) since Fastify's inject doesn't
 * do a WS upgrade — connects with Node's built-in `WebSocket` client.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineEvent, ExecutionAdapter, InteractiveEngineSession, RunSpec } from "@foundry/adapter-api";
import { createServer, type FoundryServer } from "../server.js";

const ZERO_BUDGET = { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 };

let dir: string | undefined;
let server: FoundryServer | undefined;
afterEach(async () => {
  if (server) await server.stop();
  server = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** Minimal scripted `InteractiveEngineSession` — no turns are actually exercised at
 * the wire level in these tests, so it never needs to emit anything. */
class InertSession implements InteractiveEngineSession {
  send(): void {}
  async *events(): AsyncIterable<EngineEvent> {}
  close(): void {}
}

function scriptedAdapter(interactive: boolean): ExecutionAdapter {
  return {
    id: "scripted",
    capabilities: () => ({
      resume: false,
      stream_events: true,
      tool_events: true,
      usage: true,
      reasoning_summaries: false,
      permission_hooks: false,
      mcp: false,
      interactive,
    }),
    start: async () => ({ runId: "" as never, adapterId: "scripted" }),
    cancel: async () => {},
    events: async function* () {},
    ...(interactive ? { attachInteractive: async (_s: RunSpec & { sessionRef?: string }) => new InertSession() } : {}),
  };
}

async function setupWorkstreamWithPriorSession(s: FoundryServer, interactive: boolean): Promise<string> {
  const team = s.store.commands.createTeam({ name: "Platform", description: "infra", default_policy: {} });
  const { agentId } = s.store.commands.createAgent({
    name: "Orbit",
    role: "Backend Engineer",
    team_id: team.id,
    engine_id: "scripted",
    memory_ref: "agents/orbit/memory",
    charter_body_md: "# Orbit",
  });
  s.store.commands.transitionAgentState({ id: agentId, to: "active", actorId: null });
  const ws = s.store.commands.createWorkstream({
    agent_id: agentId,
    title: "Bug #1",
    goal_md: "test goal",
    origin: "human",
    budget: ZERO_BUDGET,
  });
  if (interactive) {
    s.store.commands.transitionWorkstreamState({ id: ws.id, to: "active", actorId: null });
    const run = s.store.commands.createRun({
      workstream_id: ws.id,
      trigger: "human_message",
      input_context_ref: "ctx",
      engine_id: "scripted",
    });
    s.store.commands.transitionRunState({ id: run.id, workstreamId: ws.id, to: "starting", actorId: null });
    s.store.commands.transitionRunState({ id: run.id, workstreamId: ws.id, to: "running", actorId: null, engineSessionId: "sess-1" });
    s.store.commands.transitionRunState({
      id: run.id,
      workstreamId: ws.id,
      to: "completed",
      actorId: null,
      result: { outcome: "completed", final_text: "done", artifact_refs: [] },
    });
  }
  return ws.id;
}

function waitForMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    ws.addEventListener("message", (e) => resolve(JSON.parse(e.data as string)), { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
}

describe("GET /api/workstreams/:id/interactive — E13", () => {
  it("sends an attached frame with the engine session id on a successful attach", async () => {
    dir = mkdtempSync(join(tmpdir(), "foundry-interactive-route-"));
    server = createServer({ dataDir: dir, dbPath: ":memory:", adapters: { scripted: scriptedAdapter(true) } });
    const address = await server.start();
    const workstreamId = await setupWorkstreamWithPriorSession(server, true);

    const ws = new WebSocket(`${address.replace("http", "ws")}/api/workstreams/${workstreamId}/interactive`);
    const frame = await waitForMessage(ws);
    expect(frame).toEqual({ type: "attached", engineSessionId: "sess-1" });
    ws.close();
  });

  it("sends an error frame and closes when the engine doesn't support interactive attach", async () => {
    dir = mkdtempSync(join(tmpdir(), "foundry-interactive-route-"));
    server = createServer({ dataDir: dir, dbPath: ":memory:", adapters: { scripted: scriptedAdapter(false) } });
    const address = await server.start();
    const workstreamId = await setupWorkstreamWithPriorSession(server, true);

    const ws = new WebSocket(`${address.replace("http", "ws")}/api/workstreams/${workstreamId}/interactive`);
    const frame = await waitForMessage(ws);
    expect(frame).toMatchObject({ type: "error" });
    expect((frame as { message: string }).message).toContain("does not support interactive attach");
  });

  it("rejects a malformed client frame with an error, without dropping the connection", async () => {
    dir = mkdtempSync(join(tmpdir(), "foundry-interactive-route-"));
    server = createServer({ dataDir: dir, dbPath: ":memory:", adapters: { scripted: scriptedAdapter(true) } });
    const address = await server.start();
    const workstreamId = await setupWorkstreamWithPriorSession(server, true);

    const ws = new WebSocket(`${address.replace("http", "ws")}/api/workstreams/${workstreamId}/interactive`);
    await waitForMessage(ws); // attached

    const next = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "not-a-send", foo: "bar" }));
    const frame = await next;
    expect(frame).toMatchObject({ type: "error" });
    ws.close();
  });

  it("detaches (releasing the workstream) when the socket closes", async () => {
    dir = mkdtempSync(join(tmpdir(), "foundry-interactive-route-"));
    server = createServer({ dataDir: dir, dbPath: ":memory:", adapters: { scripted: scriptedAdapter(true) } });
    const address = await server.start();
    const workstreamId = await setupWorkstreamWithPriorSession(server, true);

    const ws = new WebSocket(`${address.replace("http", "ws")}/api/workstreams/${workstreamId}/interactive`);
    await waitForMessage(ws); // attached
    expect(server.store.workstreams.get(workstreamId as never)?.state).toBe("waiting");

    ws.close();
    await new Promise((resolve) => ws.addEventListener("close", resolve, { once: true }));
    // The detach() call happens synchronously in the server's own "close" handler,
    // which fires before/around the client's own close event — poll briefly.
    await vi_waitFor(() => server!.store.workstreams.get(workstreamId as never)?.state === "active");
  });
});

/** Tiny local poll helper — avoids pulling vitest's `vi` into a file that otherwise
 * has no other use for it. */
async function vi_waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await new Promise((r) => setTimeout(r, 10));
  }
}
