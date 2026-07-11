/** E9.1 — adapter integration tests over replayed fixtures (spawn + parse + session capture). */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newRunId } from "@foundry/core";
import type { EngineEvent, RunSpec } from "@foundry/adapter-api";
import { createClaudeCodeAdapter } from "./adapter.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const replay = join(fixturesDir, "replay.mjs");

let dir: string | undefined;
afterEach(() => {
  // The dir is the just-exited child's cwd — Windows can hold the lock a beat longer.
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  dir = undefined;
});

function spec(fixture: string, extra: Partial<RunSpec> = {}): RunSpec {
  dir = mkdtempSync(join(tmpdir(), "foundry-cc-"));
  const contextFile = join(dir, "context.md");
  writeFileSync(contextFile, "# Charter\ntest context", "utf8");
  return {
    runId: newRunId(),
    agentName: "Orbit",
    contextFile,
    workspaceDir: dir,
    orgTools: {},
    engineConfig: { cliPath: process.execPath, cliArgs: [replay, join(fixturesDir, fixture)] },
    limits: { wallClockMs: 30_000 },
    ...extra,
  };
}

async function collect(adapter: ReturnType<typeof createClaudeCodeAdapter>, s: RunSpec): Promise<EngineEvent[]> {
  const handle = await adapter.start(s);
  const events: EngineEvent[] = [];
  for await (const e of adapter.events(handle)) events.push(e);
  await waitForExit(handle.pid); // the child's cwd is the temp dir — let it release the lock
  return events;
}

/** The mapper stops reading at run_ended, which can be before the child exits. */
async function waitForExit(pid: number | undefined): Promise<void> {
  if (typeof pid !== "number") return;
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // gone
    }
    if (Date.now() > deadline) throw new Error(`child ${pid} did not exit`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("ClaudeCodeAdapter — E9.1", () => {
  it("maps a full tool-using run: session, deltas, tool pairs, usage, completed", async () => {
    const adapter = createClaudeCodeAdapter();
    const events = await collect(adapter, spec("tool-use.ndjson"));
    expect(events[0]).toEqual({ t: "run_started", sessionRef: "sess-cc-tools" });
    expect(events.filter((e) => e.t === "tool_call" && e.phase === "start").map((e) => (e as { name: string }).name)).toEqual(["Read", "Edit"]);
    expect(events.filter((e) => e.t === "tool_call" && e.phase === "end")).toHaveLength(2);
    const usage = events.find((e) => e.t === "usage_delta");
    expect(usage).toEqual({ t: "usage_delta", tokensIn: 2411, tokensOut: 905, costUsd: 0.1174 });
    const ended = events.at(-1);
    expect(ended).toMatchObject({ t: "run_ended", outcome: "completed", sessionRef: "sess-cc-tools" });
  });

  it("the handle carries the child pid (E4.5/F7 orphan sweep hookup)", async () => {
    const adapter = createClaudeCodeAdapter();
    const handle = await adapter.start(spec("happy-path.ndjson"));
    expect(typeof handle.pid).toBe("number");
    for await (const _ of adapter.events(handle)) void _; // drain
    await waitForExit(handle.pid);
  });

  it("cancel() during a hung run kills the process and yields run_ended{cancelled}", async () => {
    const adapter = createClaudeCodeAdapter();
    const handle = await adapter.start(
      spec("hang.ndjson", {
        engineConfig: { cliPath: process.execPath, cliArgs: [replay, join(fixturesDir, "hang.ndjson"), "--hang"] },
      })
    );
    const events: EngineEvent[] = [];
    for await (const e of adapter.events(handle)) {
      events.push(e);
      if (e.t === "run_started") await adapter.cancel(handle);
    }
    expect(events.at(-1)).toMatchObject({ t: "run_ended", outcome: "cancelled" });
    // The child is actually dead, not orphaned.
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(handle.pid!, 0)).toThrow();
  });

  it("E9.2: spec.orgTools.mcpConfig is injected via --mcp-config", async () => {
    const adapter = createClaudeCodeAdapter();
    dir = mkdtempSync(join(tmpdir(), "foundry-cc-"));
    const mcpConfig = { mcpServers: { foundry: { type: "http", url: "http://127.0.0.1:4180/api/mcp" } } };
    const handle = await adapter.start({
      runId: newRunId(),
      agentName: "Orbit",
      contextFile: join(dir, "missing.md"),
      workspaceDir: dir,
      orgTools: { mcpConfig },
      engineConfig: { cliPath: process.execPath, cliArgs: [join(fixturesDir, "echo-args.mjs")] },
      limits: { wallClockMs: 30_000 },
    });
    const events: EngineEvent[] = [];
    for await (const e of adapter.events(handle)) events.push(e);
    await waitForExit(handle.pid);
    const ended = events.at(-1);
    expect(ended?.t).toBe("run_ended");
    if (ended?.t === "run_ended") {
      expect(ended.finalText).toContain("--mcp-config");
      expect(ended.finalText).toContain(JSON.stringify(mcpConfig));
    }
  });

  it("resume() passes --resume <sessionRef> to the CLI", async () => {
    // echo-args.mjs prints the argv it received as the result text — proving the exact
    // flag wiring without a real CLI.
    const adapter = createClaudeCodeAdapter();
    dir = mkdtempSync(join(tmpdir(), "foundry-cc-"));
    const s: RunSpec & { sessionRef: string } = {
      runId: newRunId(),
      agentName: "Orbit",
      contextFile: join(dir, "missing.md"), // tolerated: composes to empty stdin
      workspaceDir: dir,
      orgTools: {},
      engineConfig: { cliPath: process.execPath, cliArgs: [join(fixturesDir, "echo-args.mjs")] },
      limits: { wallClockMs: 30_000 },
      sessionRef: "sess-prev-123",
    };
    const handle = await (adapter.resume as NonNullable<typeof adapter.resume>)(s);
    const events: EngineEvent[] = [];
    for await (const e of adapter.events(handle)) events.push(e);
    await waitForExit(handle.pid);
    const ended = events.at(-1);
    expect(ended?.t).toBe("run_ended");
    if (ended?.t === "run_ended") {
      expect(ended.finalText).toContain("--resume sess-prev-123");
    }
  });
});
