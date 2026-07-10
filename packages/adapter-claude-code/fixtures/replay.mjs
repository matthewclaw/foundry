#!/usr/bin/env node
/**
 * Fixture replayer — stands in for the `claude` executable in tests (contracts.md:
 * "claude-code runs [the conformance suite] against recorded stream fixtures (replayed
 * process output)"). Prints each line of an NDJSON fixture to stdout with a tiny delay,
 * then exits 0. With --hang, it prints the fixture and then never exits (drives the
 * cancel-semantics test — the adapter's SIGTERM kills it, exactly like a stuck engine).
 *
 * Ignores the adapter's standard CLI flags (-p, --output-format, --resume <id>, …) so
 * the exact argv the adapter builds for the real CLI works here unchanged. Drains stdin
 * (the adapter pipes the composed context in) so the writer never blocks.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const fixture = args.find((a) => a.endsWith(".ndjson"));
const hang = args.includes("--hang");

process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => {});

if (!fixture) {
  process.stderr.write("replay.mjs: no .ndjson fixture in argv\n");
  process.exit(2);
}

const rl = createInterface({ input: createReadStream(fixture, "utf8") });
const lines = [];
rl.on("line", (l) => lines.push(l));
rl.on("close", async () => {
  for (const line of lines) {
    process.stdout.write(line + "\n");
    await new Promise((r) => setTimeout(r, 5));
  }
  if (hang) {
    setInterval(() => {}, 1000); // never exits; the adapter's cancel() kills us
  } else {
    process.exit(0);
  }
});
