/**
 * E13 — "drop in": this engine's implementation of `InteractiveEngineSession`
 * (`@foundry/adapter-api`). `claude -p --input-format stream-json --output-format
 * stream-json --verbose [--resume <id>]` stays alive across many turns over plain
 * stdin/stdout pipes — no PTY needed (verified live: a second stdin write after the
 * first turn's `result` line produces a second full turn on the same process). Reuses
 * `stream.ts`'s `mapLine` completely unchanged — it doesn't care whether the process
 * exits after one turn or keeps going; only the read loop here doesn't stop at the
 * first `run_ended`-shaped event the way the batch adapter's `events()` does.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import type { EngineEvent, InteractiveEngineSession, RunSpec } from "@foundry/adapter-api";
import { ClaudeCodeConfigSchema, type ClaudeCodeConfig } from "./adapter.js";
import { mapLine, newMapperState } from "./stream.js";

export function spawnInteractiveClaudeSession(
  spec: RunSpec & { sessionRef?: string },
  defaults: ClaudeCodeConfig = {}
): InteractiveEngineSession {
  const perRun = ClaudeCodeConfigSchema.parse(spec.engineConfig ?? {});
  const config = { cliPath: "claude", cliArgs: [] as string[], ...definedOnly(defaults), ...definedOnly(perRun) };
  const args = [
    ...config.cliArgs,
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    ...(spec.sessionRef ? ["--resume", spec.sessionRef] : []),
    ...(config.model ? ["--model", config.model] : []),
    ...(config.permissionMode ? ["--permission-mode", config.permissionMode] : []),
    ...(config.allowedTools?.length ? ["--allowedTools", config.allowedTools.join(",")] : []),
    ...(config.disallowedTools?.length ? ["--disallowedTools", config.disallowedTools.join(",")] : []),
    ...(spec.orgTools.mcpConfig ? ["--mcp-config", JSON.stringify(spec.orgTools.mcpConfig)] : []),
  ];
  // Same Windows `.cmd`-shim wrapper as the batch adapter's spawnRun — see its comment
  // for why cmd.exe /d /s /c rather than shell:true.
  const cwd = spec.workspaceDir && existsSync(spec.workspaceDir) ? spec.workspaceDir : undefined;
  const env = { ...process.env, ...spec.orgTools.cliEnv };
  const child: ChildProcessWithoutNullStreams =
    process.platform === "win32"
      ? spawn("cmd.exe", ["/d", "/s", "/c", config.cliPath, ...args], {
          cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        })
      : spawn(config.cliPath, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  child.stderr.resume(); // drain so the child never blocks on a full stderr pipe

  return {
    send(userText: string): void {
      const line = JSON.stringify({ type: "user", message: { role: "user", content: userText } });
      child.stdin.write(line + "\n");
    },
    async *events(): AsyncIterable<EngineEvent> {
      const state = newMapperState();
      const rl = createInterface({ input: child.stdout });
      for await (const line of rl) {
        for (const event of mapLine(state, line)) yield event;
        // Deliberately no `if (state.sawResult) return` here — that's what makes this
        // interactive rather than one-shot: a `result` line ends one turn, not the
        // stream. The loop only ends when the process itself exits (close()) or dies.
      }
    },
    close(): void {
      if (child.exitCode === null && !child.killed) child.stdin.end();
    },
  };
}

/** Spread-merge helper: drops undefined fields so they don't clobber lower layers
 * (same behavior as adapter.ts's private copy — small enough not to share). */
function definedOnly<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
