/** E13 — interactive session integration test over a scripted multi-turn fixture. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newRunId } from "@foundry/core";
import type { EngineEvent, RunSpec } from "@foundry/adapter-api";
import { spawnInteractiveClaudeSession } from "./interactive.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  dir = undefined;
});

function spec(extra: Partial<RunSpec & { sessionRef?: string }> = {}): RunSpec & { sessionRef?: string } {
  dir = mkdtempSync(join(tmpdir(), "foundry-cc-interactive-"));
  return {
    runId: newRunId(),
    agentName: "Orbit",
    contextFile: join(dir, "missing.md"),
    workspaceDir: dir,
    orgTools: {},
    engineConfig: { cliPath: process.execPath, cliArgs: [join(fixturesDir, "multi-turn-echo.mjs")] },
    limits: { wallClockMs: 30_000 },
    ...extra,
  };
}

/** Reads events up to and including the next `run_ended`-shaped event (one turn
 * boundary). Drives `.next()` directly rather than a `for await...of` loop — breaking
 * out of a `for await` early calls `.return()` on the iterator, which permanently ends
 * an async generator; this needs to leave it suspended so a later call can read the
 * *next* turn off the same long-lived session. */
async function collectOneTurn(iterator: AsyncIterator<EngineEvent>): Promise<EngineEvent[]> {
  const collected: EngineEvent[] = [];
  for (;;) {
    const result = await iterator.next();
    if (result.done) return collected;
    collected.push(result.value);
    if (result.value.t === "run_ended") return collected;
  }
}

/** After `close()`, drains the iterator until the underlying stream actually ends —
 * i.e. the process has exited — so the temp dir (its cwd) isn't still locked when the
 * test's `afterEach` tries to remove it (same reasoning as adapter.test.ts's own
 * `waitForExit`, just driven off the event stream instead of a pid). */
async function drainToEnd(iterator: AsyncIterator<EngineEvent>): Promise<void> {
  for (;;) {
    const result = await iterator.next();
    if (result.done) return;
  }
}

describe("spawnInteractiveClaudeSession — E13", () => {
  it("handles two turns on the same process without restarting", async () => {
    const session = spawnInteractiveClaudeSession(spec());
    const iterator = session.events();

    session.send("first message");
    const firstTurnEvents = await collectOneTurn(iterator);
    const firstEnded = firstTurnEvents.at(-1);
    expect(firstEnded).toMatchObject({ t: "run_ended", outcome: "completed", finalText: "turn 1: first message" });

    session.send("second message");
    const secondTurnEvents = await collectOneTurn(iterator);
    const secondEnded = secondTurnEvents.at(-1);
    expect(secondEnded).toMatchObject({ t: "run_ended", outcome: "completed", finalText: "turn 2: second message" });

    session.close();
    await drainToEnd(iterator);
  });

  it("passes --resume <sessionRef> when attaching to an existing session", async () => {
    const s = spec({
      sessionRef: "sess-prev-456",
      engineConfig: { cliPath: process.execPath, cliArgs: [join(fixturesDir, "echo-args.mjs")] },
    });
    const session = spawnInteractiveClaudeSession(s);
    session.send("hello");
    const iterator = session.events();
    const events = await collectOneTurn(iterator);
    const ended = events.at(-1);
    expect(ended?.t).toBe("run_ended");
    if (ended?.t === "run_ended") {
      expect(ended.finalText).toContain("--input-format stream-json");
      expect(ended.finalText).toContain("--resume sess-prev-456");
    }
    session.close();
    await drainToEnd(iterator);
  });
});
