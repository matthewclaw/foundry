# Phase 1 — `@foundry/adapter-api` + `@foundry/adapter-fake` (Epic E3)

Branch: `phase-1/adapters`. Scope: `packages/adapter-api` (E3.1–E3.2, keystone) and
`packages/adapter-fake` (E3.3) per `docs/implementation/roadmap.md`. No other package
touched.

## What's here

### `packages/adapter-api` — the execution-adapter contract (E3.1, E3.2)

`src/types.ts`: `ExecutionAdapter`, `RunSpec`, `RunHandle`, `CapabilitySet`, and
`EngineEventSchema` (Zod + TS) exactly as specified in contracts.md, reusing core's
`RunResultSchema.shape.outcome` for `run_ended.outcome` rather than redefining the
four-value enum.

`src/conformance.ts`: `describeAdapterContract(makeAdapter)` — a Vitest suite covering
full lifecycle, event ordering, exactly-one `run_ended`, cancel semantics, and capability
honesty (declared capabilities exercised at least once; undeclared capabilities' event
types never appear, checked across every collected stream). The assertions
(`assertWellFormedStream`, `assertCapabilityHonesty`, `assertDeclaredCapabilitiesExercised`)
are exported as plain functions, not buried inside `it()` blocks, so this package's own
tests prove the suite has teeth — it rejects deliberately-broken event streams
(`conformance.assertions.test.ts`) — independent of any adapter under test. A minimal
hand-written reference adapter (`conformance.contract.test.ts`) proves the suite runs
end-to-end against a conformant implementation, before the fake adapter proves it again
for real in its own package.

### `packages/adapter-fake` — the scripted engine (E3.3, ADR-010)

`FakeExecutionAdapter` declares every optional capability and plays back a JSON
**scenario**'s step list (`event | sleep | crash | hang | malformed_event`) as its
`EngineEvent` stream. Scenario selection is per-call via `RunSpec.engineConfig`
(`{ scenarioName }` or `{ scenario }`, falling back to a default bound at construction) —
this is what lets one adapter instance behave differently across a `start()`/`resume()`
pair, e.g. crash on the initial attempt and complete on the resumed one, sharing a
`sessionRef`. Full DSL: `packages/adapter-fake/SCENARIO_DSL.md`.

13 canned scenarios ship in `scenarios/*.json` — every doc-07 failure mode expressible at
the adapter level (F1 engine-crash, F2 hang-stall, F6 budget-burn-cutoff, F15
malformed-event) plus cancel-mid-run, awaiting-input, permission-request
(granted/denied), the resume-after-interrupt pair, an org-tool call represented as a
`tool_call` event (delegate-task-call), and a multi-capability timeline
(reasoning-multi-tool-timeline). `scenarios.test.ts` parses every shipped file and drives
each to its documented terminal state (well-formed for most; abnormal-end/uncancellable/
malformed for the three that say so in their own `description`).

`FakeExecutionAdapter` passes `describeAdapterContract` in CI
(`src/conformance.test.ts`) — the proof the suite and the reference implementation agree
(ADR-010).

## Verified definition of done

Confirmed twice: once in this working directory, once from a throwaway `git clone` of
this branch into an unrelated directory (no shared state, no other packages present).

```
pnpm install    # green — workspace resolves to exactly core + adapter-api + adapter-fake + root
pnpm run build  # green (tsc, all three packages)
pnpm run test   # green — core: 100 tests; adapter-api: 44 tests; adapter-fake: 37 tests (181 total)
pnpm run lint:deps  # green — 0 dependency-direction violations
```

## Every E3 acceptance criterion, covered by a test

| Story | AC | Where |
|---|---|---|
| E3.1 | Types compile against core; documented per contracts.md | `types.ts` + `types.test.ts` (EngineEventSchema accept/reject cases, CapabilitySet round-trip) |
| E3.2 | Covers lifecycle, cancel, event ordering, exactly-one `run_ended`, capability honesty | `conformance.ts` + `conformance.assertions.test.ts` (teeth-proving negative cases) + `conformance.contract.test.ts` (positive end-to-end run) |
| E3.3 | Passes conformance; scenario DSL documented; ships ≥12 canned scenarios incl. every expressible doc-07 failure mode | `conformance.test.ts` (fake adapter passes the suite); `SCENARIO_DSL.md`; `scenarios/` (13 files) + `scenarios.test.ts` |

## Open issues raised

Five, in `docs/implementation/OPEN_ISSUES.md` #12–16 (numbered continuing from E1's,
architect review pending) — each is a place contracts.md names a concept without pinning
its exact shape, resolved with a concrete choice rather than a silent deviation:

- **#12** `RunHandle` shape (contracts.md never gives one, unlike `RunSpec`/`EngineEvent`)
- **#13** `describeAdapterContract(makeAdapter)`'s signature (contracts.md names the
  export and its coverage in prose only) — the `ConformanceBehavior`-driven factory
  design, and why a generic suite can't script adapter-specific behaviour any other way
  given `engineConfig`'s opacity
- **#14** `EngineEventSchema`'s home — contracts.md's core section prose lists it among
  core's exports, but frozen core doesn't define it and the dedicated adapter-api section
  defines `EngineEvent` with no cross-reference; adapter-api owns it
- **#15** `stream_events`/`mcp` have no dedicated `EngineEvent` type to honesty-check
  against (unlike the other five capabilities)
- **#16** the fake adapter's "org-tools call" is simulated as a `tool_call` event, not a
  live HTTP round trip — no org-tools server exists yet (E5/E6 are later epics)

None touch `@foundry/core`, which stayed untouched throughout.

## Delegated to Haiku

Two of the thirteen scenario files — `delegate-task-call.json` and
`reasoning-multi-tool-timeline.json` — were written by a Haiku subagent once the DSL was
fixed, against a complete spec (exact JSON shapes, exact EngineEvent field requirements,
exact file paths, exact step sequences). Reviewed against `ScenarioSchema` and exercised
by `scenarios.test.ts` before this commit; no changes were needed. Everything else
(E3.1/E3.2 keystone, `FakeExecutionAdapter`, the remaining 11 scenarios, all tests, both
`.md` docs) was written directly.

## Shared-workspace note

This working directory was shared, mid-session, with the concurrent E2 (`phase-1/store`)
lane — not via separate branches in isolation, but the *same checked-out working tree*,
including a live `git checkout` that swapped the shared `HEAD` out from under this branch
partway through. No content was lost (verified: everything the resulting stash held was
already superseded by newer files the other session had since written), but it did mean
one round of unstaging and re-applying the `OPEN_ISSUES.md` E3 section after switching
back to `phase-1/adapters`. `packages/store` is never referenced by this branch's
lockfile or commits — confirmed by the fresh-clone verification above, which had no
`packages/store` directory at all.
