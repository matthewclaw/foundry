/**
 * E9.1 — the Claude Code execution adapter: spawns `claude -p` headlessly with
 * stream-json output, feeds the composed context on stdin, maps the NDJSON stream to
 * normalized EngineEvents (stream.ts), captures the session id for resume, and reports
 * the child pid on its RunHandle so the runtime's pid registry (E4.5/F7) can sweep
 * orphans.
 *
 * Testing per contracts.md: the conformance suite runs against RECORDED fixtures
 * (replayed process output) — `engineConfig.cliPath` may point at any executable that
 * prints stream-json, which is exactly what fixtures/replay.mjs does. The live CLI is
 * only exercised in the manual/nightly lane (E9.5); no test here calls a paid engine.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { CapabilitySet, EngineEvent, ExecutionAdapter, RunHandle, RunSpec } from "@foundry/adapter-api";
import { mapLine, newMapperState } from "./stream.js";

export const ClaudeCodeConfigSchema = z.object({
  /** Executable to spawn — the real `claude`, or a fixture-replay script in tests. */
  cliPath: z.string().min(1).optional(),
  /** Extra argv prepended before the standard flags (fixture path, node script, …). */
  cliArgs: z.array(z.string()).optional(),
  model: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  permissionMode: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
});
export type ClaudeCodeConfig = z.infer<typeof ClaudeCodeConfigSchema>;

interface ClaudeRunHandle extends RunHandle {
  readonly child: ChildProcessWithoutNullStreams;
  cancelRequested: boolean;
}

function isClaudeHandle(h: RunHandle): h is ClaudeRunHandle {
  return typeof (h as ClaudeRunHandle).child === "object";
}

const CAPABILITIES: CapabilitySet = {
  resume: true,
  stream_events: true,
  tool_events: true,
  usage: true,
  // ponytail: reasoning summaries and permission hooks are real CLI features but their
  // Foundry wiring is E9.4/E6.4 — declared false until exercised (capability honesty).
  reasoning_summaries: false,
  permission_hooks: false,
  mcp: true,
};

export class ClaudeCodeAdapter implements ExecutionAdapter {
  readonly id = "claude-code";

  /**
   * `defaults` is the composition root's base config (or a test's fixture-replay
   * wiring); per-run `spec.engineConfig` fields override it. The conformance suite
   * passes an empty engineConfig, so the factory bakes fixtures in via defaults.
   */
  constructor(private readonly defaults: ClaudeCodeConfig = {}) {}

  capabilities(): CapabilitySet {
    return CAPABILITIES;
  }

  async start(spec: RunSpec): Promise<RunHandle> {
    return this.spawnRun(spec, []);
  }

  async resume(spec: RunSpec & { sessionRef: string }): Promise<RunHandle> {
    return this.spawnRun(spec, ["--resume", spec.sessionRef]);
  }

  async cancel(handle: RunHandle): Promise<void> {
    if (!isClaudeHandle(handle)) return;
    handle.cancelRequested = true;
    if (handle.child.exitCode === null && !handle.child.killed) {
      handle.child.kill(); // SIGTERM; on Windows terminates the process
    }
  }

  async *events(handle: RunHandle): AsyncIterable<EngineEvent> {
    if (!isClaudeHandle(handle)) {
      throw new Error("claude-code adapter: events() called with a handle it didn't issue");
    }
    const state = newMapperState();
    const rl = createInterface({ input: handle.child.stdout });
    for await (const line of rl) {
      for (const event of mapLine(state, line)) {
        if (event.t === "run_ended" && handle.cancelRequested) {
          // A graceful result raced our kill — report what actually happened to the
          // run from Foundry's point of view: it was cancelled.
          yield { ...event, outcome: "cancelled" };
          return;
        }
        yield event;
      }
      if (state.sawResult) return; // exactly one run_ended, then stop reading
    }
    // Stream ended without a result line: the process died or was killed.
    if (handle.cancelRequested) {
      // We asked it to stop and it did — acknowledge gracefully (cancel semantics).
      yield { t: "run_ended", outcome: "cancelled", sessionRef: state.sessionRef };
      return;
    }
    // Engine crash (F1): end abnormally, the run supervisor folds it.
  }

  private spawnRun(spec: RunSpec, extraArgs: string[]): ClaudeRunHandle {
    const perRun = ClaudeCodeConfigSchema.parse(spec.engineConfig ?? {});
    const config = { cliPath: "claude", cliArgs: [] as string[], ...definedOnly(this.defaults), ...definedOnly(perRun) };
    const args = [
      ...config.cliArgs,
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      ...extraArgs,
      ...(config.model ? ["--model", config.model] : []),
      ...(config.maxTurns ? ["--max-turns", String(config.maxTurns)] : []),
      ...(config.permissionMode ? ["--permission-mode", config.permissionMode] : []),
      ...(config.allowedTools?.length ? ["--allowedTools", config.allowedTools.join(",")] : []),
      ...(config.disallowedTools?.length ? ["--disallowedTools", config.disallowedTools.join(",")] : []),
      // E9.2 wires spec.orgTools.mcpConfig via --mcp-config here.
    ];
    const child = spawn(config.cliPath, args, {
      cwd: spec.workspaceDir && existsSync(spec.workspaceDir) ? spec.workspaceDir : undefined,
      env: { ...process.env, ...spec.orgTools.cliEnv },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    // The composed context is the prompt, fed on stdin (arbitrarily large, no argv
    // limit). A missing file (conformance suite uses a placeholder path) means an
    // empty prompt, not a crash.
    const context = spec.contextFile && existsSync(spec.contextFile) ? readFileSync(spec.contextFile, "utf8") : "";
    child.stdin.write(context);
    child.stdin.end();
    child.stderr.resume(); // drain so the child never blocks on a full stderr pipe

    const handle: ClaudeRunHandle = {
      runId: spec.runId,
      adapterId: this.id,
      pid: child.pid,
      child,
      cancelRequested: false,
    };
    return handle;
  }
}

export function createClaudeCodeAdapter(defaults: ClaudeCodeConfig = {}): ExecutionAdapter {
  return new ClaudeCodeAdapter(defaults);
}

/** Spread-merge helper: drops undefined fields so they don't clobber lower layers. */
function definedOnly<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
