#!/usr/bin/env node
/**
 * Interactive stand-in for `claude -p --input-format stream-json --output-format
 * stream-json`: reads one NDJSON user-message per stdin line and, for each, emits a
 * `system/init` (first turn only) + `result` echoing that message's content back —
 * proving multiple turns are handled on the SAME process without exiting between them,
 * the exact behavior `spawnInteractiveClaudeSession` depends on.
 */
import { createInterface } from "node:readline";

let turn = 0;
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  turn++;
  if (turn === 1) {
    process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-multiturn" }) + "\n");
  }
  const content = msg.message?.content ?? "";
  process.stdout.write(
    JSON.stringify({
      type: "result",
      subtype: "success",
      result: `turn ${turn}: ${content}`,
      session_id: "sess-multiturn",
      is_error: false,
    }) + "\n"
  );
});
rl.on("close", () => process.exit(0));
