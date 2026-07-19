/**
 * E3.1 — the execution-adapter contract (contracts.md `@foundry/adapter-api`,
 * 03-system-architecture.md "Execution Adapters", ADR-003).
 *
 * This is the keystone every future engine adapter and the runtime build on. Mandatory
 * core (capabilities/start/cancel/events) is narrow by design; everything richer is an
 * opt-in, declared capability so the product isn't capped at the weakest engine.
 */
import { z } from "zod";
import type { RunId } from "@foundry/core";
import { RunResultSchema } from "@foundry/core";

// --- CapabilitySet (contracts.md, ADR-003) ---

export interface CapabilitySet {
  /** Session continuation across runs via `resume(sessionRef, input)`. */
  resume: boolean;
  /** Live tool-call/output timeline in the UI (vs. start/end + final output only). */
  stream_events: boolean;
  /** Tool-level audit: which files/commands the engine touched. */
  tool_events: boolean;
  /** Token/cost accounting per run. */
  usage: boolean;
  /** "Why" summaries on the timeline. */
  reasoning_summaries: boolean;
  /** Engine permission prompts surfaced as Foundry approvals. */
  permission_hooks: boolean;
  /** Org-tools delivered via MCP (else CLI-shim fallback). */
  mcp: boolean;
  /** Live multi-turn attach via `attachInteractive` (E13 "drop in") — a human can send
   * further messages to an already-running session and get real-time turns back,
   * instead of only ever queuing a fresh headless run. Opt-in like every other
   * capability here: an engine that doesn't implement it just doesn't offer "Drop in". */
  interactive: boolean;
}

export const CAPABILITY_KEYS = [
  "resume",
  "stream_events",
  "tool_events",
  "usage",
  "reasoning_summaries",
  "permission_hooks",
  "mcp",
  "interactive",
] as const satisfies readonly (keyof CapabilitySet)[];

export const CapabilitySetSchema = z.object({
  resume: z.boolean(),
  stream_events: z.boolean(),
  tool_events: z.boolean(),
  usage: z.boolean(),
  reasoning_summaries: z.boolean(),
  permission_hooks: z.boolean(),
  mcp: z.boolean(),
  interactive: z.boolean(),
});

// --- RunSpec (contracts.md, literal) ---

export interface RunSpec {
  runId: RunId;
  agentName: string;
  /** Absolute path: composed context (server writes it). */
  contextFile: string;
  workspaceDir: string;
  /** Per-run credential lives inside; see contracts.md "Org-tools contract". */
  orgTools: { mcpConfig?: object; cliEnv?: Record<string, string> };
  /** Adapter-specific, zod-validated by the adapter itself. */
  engineConfig: unknown;
  limits: { wallClockMs: number };
}

/**
 * RunHandle — contracts.md names this type as the return of `start`/`resume` and the
 * argument to `cancel`/`events` but never pins its shape (OPEN_ISSUES.md #12). Minimal
 * public shape: enough for the runtime to correlate a handle back to its run without
 * assuming anything about how an adapter tracks the underlying process. Adapters may
 * carry extra fields on the concrete object they return (structural typing allows it);
 * nothing outside the adapter should depend on more than what's declared here.
 */
export interface RunHandle {
  readonly runId: RunId;
  readonly adapterId: string;
  /**
   * OS process id of the spawned engine, when there is a real one (E9 claude-code).
   * Additive amendment to the #12 shape (E4.5/F7): the runtime registers it in the
   * pid-file registry so a startup sweep can kill orphans. Adapters with no real
   * process (fake) simply omit it.
   */
  readonly pid?: number;
}

// --- EngineEvent (contracts.md, literal union) ---

/**
 * Reuse core's RunResult outcome enum verbatim (contracts.md `run_ended.outcome` matches
 * `RunResultSchema.outcome` exactly) rather than redefining the four-value enum here.
 */
const RunOutcomeSchema = RunResultSchema.shape.outcome;
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;

export const EngineEventSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("run_started"), sessionRef: z.string().optional() }),
  z.object({ t: z.literal("output_delta"), text: z.string() }),
  z.object({ t: z.literal("reasoning_summary"), text: z.string() }),
  z.object({
    t: z.literal("tool_call"),
    phase: z.enum(["start", "end"]),
    name: z.string(),
    detail: z.unknown().optional(),
  }),
  z.object({
    t: z.literal("usage_delta"),
    tokensIn: z.number().int().nonnegative().optional(),
    tokensOut: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
  }),
  z.object({ t: z.literal("awaiting_input"), prompt: z.string() }),
  z.object({
    t: z.literal("permission_request"),
    requestId: z.string().min(1),
    description: z.string(),
  }),
  z.object({
    t: z.literal("run_ended"),
    outcome: RunOutcomeSchema,
    finalText: z.string().optional(),
    error: z.string().optional(),
    sessionRef: z.string().optional(),
  }),
]);

export type EngineEvent = z.infer<typeof EngineEventSchema>;
export type EngineEventType = EngineEvent["t"];

// --- InteractiveEngineSession (E13 "drop in") ---

/**
 * A live, multi-turn session a human can send further messages into and get
 * real-time turns back from — the engine-agnostic counterpart to the batch
 * `start`/`resume`/`events` triad above, which is shaped for exactly one
 * call-to-`run_ended` per invocation and can't represent "still open, more input
 * welcome." Deliberately minimal: the runtime owns turn bookkeeping (creating a `Run`
 * row per message, folding events into store state); this only owns the underlying
 * process/channel.
 */
export interface InteractiveEngineSession {
  /** Sends one turn's worth of new user input. */
  send(userText: string): void;
  /** Long-lived — a `run_ended`-shaped event marks a turn boundary, not the end of
   * the iterable. Ends only when `close()` is called (or the process dies). */
  events(): AsyncIterable<EngineEvent>;
  /** Graceful shutdown (e.g. closes stdin and lets the process exit on its own). */
  close(): void;
}

// --- ExecutionAdapter (contracts.md, literal) ---

export interface ExecutionAdapter {
  readonly id: string;
  capabilities(): CapabilitySet;
  start(spec: RunSpec): Promise<RunHandle>;
  /** Present only if `capabilities().resume` is true (capability honesty, E3.2). */
  resume?(spec: RunSpec & { sessionRef: string }): Promise<RunHandle>;
  cancel(handle: RunHandle): Promise<void>;
  /** Ends with exactly one `run_ended`; a crashed engine (F1) ends the iterable abnormally instead. */
  events(handle: RunHandle): AsyncIterable<EngineEvent>;
  /** Present only if `capabilities().interactive` is true (same capability-honesty
   * rule as `resume` above) — an engine that doesn't implement live attach simply
   * doesn't offer it, rather than the runtime assuming any one engine everywhere. */
  attachInteractive?(spec: RunSpec & { sessionRef?: string }): Promise<InteractiveEngineSession>;
}
