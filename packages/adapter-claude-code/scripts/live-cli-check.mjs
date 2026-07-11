#!/usr/bin/env node
/**
 * E9.5 — the manual/nightly live-CLI lane (contracts.md: "against the real CLI in a
 * manual/nightly lane"; roadmap AC: "One real happy-path run green against installed
 * CLI"). NEVER run in CI — it spends real money. Spend-capped via --max-turns 2 and a
 * trivial prompt.
 *
 * Usage:  node scripts/live-cli-check.mjs   (requires `claude` on PATH and the package built)
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeCodeAdapter } from "../dist/index.js";

const dir = mkdtempSync(join(tmpdir(), "foundry-live-"));
const contextFile = join(dir, "context.md");
writeFileSync(contextFile, "Reply with exactly the word: pong. Do not use any tools.", "utf8");

const adapter = createClaudeCodeAdapter({ maxTurns: 2 });
const spec = {
  runId: "01LIVECHECKLIVECHECKLIVECK",
  agentName: "live-check",
  contextFile,
  workspaceDir: dir,
  orgTools: {},
  engineConfig: {},
  limits: { wallClockMs: 120_000 },
};

const handle = await adapter.start(spec);
console.log(`spawned claude (pid ${handle.pid})`);
let ended;
for await (const event of adapter.events(handle)) {
  console.log(JSON.stringify(event));
  if (event.t === "run_ended") ended = event;
}
rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

if (ended?.outcome === "completed" && ended.sessionRef) {
  console.log("LIVE CHECK OK");
} else {
  console.error(`LIVE CHECK FAILED: ${JSON.stringify(ended ?? "no run_ended")}`);
  process.exit(1);
}
