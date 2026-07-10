/**
 * E9.1 AC — the shared adapter conformance suite, green on recorded fixtures
 * (contracts.md testing strategy: "claude-code runs it against recorded stream fixtures
 * (replayed process output) in CI, against the real CLI in a manual/nightly lane").
 * `cliPath` points at node running fixtures/replay.mjs — the adapter's spawn/parse path
 * is identical to driving the real CLI; only the executable differs.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describeAdapterContract, type ConformanceBehavior } from "@foundry/adapter-api";
import { createClaudeCodeAdapter } from "./adapter.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const replay = join(fixturesDir, "replay.mjs");

function fixtureFor(behavior: ConformanceBehavior): string[] {
  if (behavior.neverEnds) return [join(fixturesDir, "hang.ndjson"), "--hang"];
  if (behavior.exerciseDeclaredCapabilities) return [join(fixturesDir, "tool-use.ndjson")];
  switch (behavior.outcome) {
    case "failed":
      return [join(fixturesDir, "api-error.ndjson")];
    case "needs_input":
      return [join(fixturesDir, "max-turns.ndjson")];
    default:
      return [join(fixturesDir, "happy-path.ndjson")];
  }
}

describeAdapterContract((behavior) =>
  createClaudeCodeAdapter({ cliPath: process.execPath, cliArgs: [replay, ...fixtureFor(behavior)] })
);
