# Fake adapter scenario DSL

`@foundry/adapter-fake` is a scripted `ExecutionAdapter` (ADR-010): every event it emits
comes from a **scenario** — a small JSON document describing a sequence of steps. This is
a first-class product component, not test scaffolding, so scenarios are documented and
versioned the same as any other contract.

**JSON, not YAML.** The DSL is a flat step list with no need for comments, anchors, or
multi-document files — JSON is sufficient, and staying JSON avoids adding a parser
dependency this repo doesn't otherwise need.

## Shape

```jsonc
{
  "name": "happy-path",              // non-empty, identifies the scenario
  "description": "...",              // non-empty, explains what it demonstrates and why
  "steps": [ /* at least one step */ ]
}
```

Zod source of truth: `src/scenario.ts` (`ScenarioSchema`). A scenario file that doesn't
parse against it fails loudly at `loadScenario()` time.

## Steps

| `type` | Fields | Effect |
|---|---|---|
| `event` | `event: EngineEvent` | Emit one normalized engine event (see below). |
| `sleep` | `ms: number` | Wait before the next step. Models realistic timing and gives watchdog-style tests a window to act. |
| `crash` | `message?: string` | **F1** — `events()` *throws* instead of yielding, ending the stream abnormally rather than with `run_ended`. |
| `hang` | — | **F2** — blocks indefinitely. Resolves only when `cancel()` is called, at which point iteration proceeds to the *next* step (if any). A `hang` with no step after it models a true stall that not even cancel resolves cleanly (see `hang-stall.json`) — the well-behaved counterpart is a `hang` followed by an `event` step ending the run (see `cancel-mid-run.json`). |
| `malformed_event` | `payload: unknown` | **F15**, deliberate only — bypasses `EngineEventSchema` entirely and yields the raw payload. The *only* sanctioned way to produce a non-conformant event from this adapter; exists so runtime's ingest-side schema validation has something real to reject. `describeAdapterContract` never exercises this step. |

### `EngineEvent` (the `event` field of an `event` step)

Re-exported from `@foundry/adapter-api`; see `packages/adapter-api/src/types.ts` for the
authoritative union. Summary:

```ts
| { t: 'run_started'; sessionRef?: string }
| { t: 'output_delta'; text: string }
| { t: 'reasoning_summary'; text: string }
| { t: 'tool_call'; phase: 'start' | 'end'; name: string; detail?: unknown }
| { t: 'usage_delta'; tokensIn?: number; tokensOut?: number; costUsd?: number }
| { t: 'awaiting_input'; prompt: string }
| { t: 'permission_request'; requestId: string; description: string }
| { t: 'run_ended'; outcome: 'completed'|'needs_input'|'failed'|'cancelled'; finalText?: string; error?: string; sessionRef?: string }
```

A well-behaved scenario's steps start with `run_started` and end with exactly one
`run_ended` as the last step — the adapter contract's core invariant. `crash`, `hang`
(unterminated), and `malformed_event` are the only sanctioned exceptions, and each says so
in its own `description`.

## Selecting a scenario

Two ways to choose which scenario an adapter instance runs:

1. **Default, at construction**: `createFakeAdapter(scenario)` — every `start()`/`resume()`
   call on that instance replays this scenario unless overridden (below).
2. **Per call, via `RunSpec.engineConfig`** (contracts.md: "adapter-specific, zod-validated
   by the adapter"): pass `{ scenarioName: "happy-path" }` (loaded from `scenarios/`) or
   `{ scenario: {...inline...} }`. This is what lets **one adapter instance** behave
   differently across a `start()`/`resume()` pair — e.g. the initial attempt crashes, the
   resumed attempt completes (`resume-after-interrupt-initial.json` /
   `resume-after-interrupt-continuation.json`), exactly like a real engine would.

```ts
import { createFakeAdapter, loadScenario } from "@foundry/adapter-fake";

const adapter = createFakeAdapter(loadScenario("happy-path")); // default
await adapter.start({ ...spec, engineConfig: { scenarioName: "engine-crash" } }); // override
```

## Shipped scenarios (`scenarios/*.json`)

| File | Demonstrates |
|---|---|
| `happy-path` | Baseline successful run. |
| `engine-crash` | **F1** — process crash mid-run (abnormal stream end). |
| `hang-stall` | **F2** — true stall; no graceful end even after cancel. |
| `cancel-mid-run` | Cooperative cancel: hangs, then gracefully ends `cancelled` once cancelled. |
| `budget-burn-cutoff` | **F6** — climbing `usage_delta`s past a nominal cap, then `failed(budget_exhausted)` on cancel. |
| `malformed-event` | **F15** — a deliberately schema-invalid event, for ingest-validation tests. |
| `awaiting-input` | Engine asks a question and ends the run `needs_input`. |
| `permission-request-granted` | Permission asked, granted, run continues to completion. |
| `permission-request-denied` | Permission asked, denied, run ends `failed`. |
| `resume-after-interrupt-initial` / `-continuation` | Crash-then-resume pair sharing a `sessionRef`. |
| `delegate-task-call` | An org-tool call represented as a `tool_call` event (OPEN_ISSUES.md #16 — no live org-tools server exists yet, so this is simulated, not a real round trip). |
| `reasoning-multi-tool-timeline` | Reasoning summaries interleaved with multiple tool calls and accumulating usage, for UI-timeline tests. |

## Loading scenarios programmatically

```ts
import { listScenarioNames, loadScenario, loadAllScenarios } from "@foundry/adapter-fake";

listScenarioNames();       // ["awaiting-input", "budget-burn-cutoff", ...]
loadScenario("happy-path"); // parsed Scenario
loadAllScenarios();         // Record<string, Scenario>
```

## Adding a scenario

1. Add `scenarios/<name>.json` matching `ScenarioSchema`.
2. If it deliberately isn't well-formed (crash/hang/malformed), say so in `description` and
   add it to `DELIBERATELY_NOT_WELL_FORMED` in `src/scenarios.test.ts`.
3. `pnpm test` — `scenarios.test.ts` parses every file and runs the well-formed ones to a
   terminal `run_ended`.
