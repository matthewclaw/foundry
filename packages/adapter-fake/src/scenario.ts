/**
 * E3.3 — the scenario DSL (ADR-010: "reads a scenario file (emit these events, call these
 * org-tools, deliver this task, sleep, fail here, hang there…)"). JSON, not YAML: the
 * step list below is flat data with no need for YAML's extra syntax (comments, anchors),
 * and staying JSON avoids adding a parser dependency this repo doesn't otherwise need.
 *
 * Full DSL documentation: ../SCENARIO_DSL.md.
 */
import { z } from "zod";
import { EngineEventSchema } from "@foundry/adapter-api";

/** Emit one normalized engine event. */
export const ScenarioEventStepSchema = z.object({
  type: z.literal("event"),
  event: EngineEventSchema,
});

/** Wait before the next step (models realistic timing; also gives watchdog tests a window). */
export const ScenarioSleepStepSchema = z.object({
  type: z.literal("sleep"),
  ms: z.number().int().nonnegative(),
});

/**
 * F1 — engine process crashes mid-run: `events()` throws instead of yielding, so the
 * iterable ends abnormally rather than with a `run_ended` (03: "Adapter stream ends
 * abnormally").
 */
export const ScenarioCrashStepSchema = z.object({
  type: z.literal("crash"),
  message: z.string().optional(),
});

/**
 * F2 — engine hangs: the generator stalls indefinitely and yields nothing further until
 * either `cancel()` is called (unblocks and the scenario proceeds to its next step, if
 * any) or the caller simply stops awaiting (a true, uncancelled `hang` step with no
 * trailing step models a stall even cancel can't cleanly resolve — see `hang-stall.json`).
 */
export const ScenarioHangStepSchema = z.object({
  type: z.literal("hang"),
});

/**
 * F15 — a deliberately invalid payload, bypassing `EngineEventSchema` entirely (cast
 * straight through). This is the ONLY sanctioned way to produce a non-conformant event
 * from this adapter — it exists so runtime's ingest-side schema validation has something
 * real to reject. Never reachable from `describeAdapterContract`'s own driving.
 */
export const ScenarioMalformedEventStepSchema = z.object({
  type: z.literal("malformed_event"),
  payload: z.unknown(),
});

export const ScenarioStepSchema = z.discriminatedUnion("type", [
  ScenarioEventStepSchema,
  ScenarioSleepStepSchema,
  ScenarioCrashStepSchema,
  ScenarioHangStepSchema,
  ScenarioMalformedEventStepSchema,
]);
export type ScenarioStep = z.infer<typeof ScenarioStepSchema>;

export const ScenarioSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  steps: z.array(ScenarioStepSchema).min(1),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

export function parseScenario(json: unknown): Scenario {
  return ScenarioSchema.parse(json);
}

/**
 * Per-run override, threaded through `RunSpec.engineConfig` (contracts.md: "adapter-specific,
 * zod-validated by the adapter"). Lets a single adapter instance behave differently on
 * `start()` vs. `resume()` — e.g. the initial attempt crashes, the resumed attempt
 * completes — by naming (or inlining) a different scenario per call.
 */
export const FakeEngineConfigSchema = z
  .object({
    scenarioName: z.string().min(1).optional(),
    scenario: ScenarioSchema.optional(),
  })
  .optional();
export type FakeEngineConfig = z.infer<typeof FakeEngineConfigSchema>;
