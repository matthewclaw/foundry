#!/usr/bin/env node
/**
 * Argv-echo stand-in for the `claude` executable: emits a minimal valid stream whose
 * final result text is the argv it received — lets tests assert the exact flags the
 * adapter builds (e.g. `--resume <sessionRef>`). A separate file (not `node -e`)
 * because node would otherwise parse the adapter's flags as its own.
 */
const args = process.argv.slice(2).join(" ");
process.stdout.write(
  JSON.stringify({ type: "system", subtype: "init", session_id: "sess-echo" }) +
    "\n" +
    JSON.stringify({ type: "result", subtype: "success", result: args, session_id: "sess-echo", is_error: false }) +
    "\n"
);
