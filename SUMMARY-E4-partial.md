# Phase 1 — `@foundry/runtime` (Epic E4, partial: E4.1–E4.4 of 6)

Merged to `main` via PR #5 (`phase-1/runtime`, squashed by GitHub UI into merge commit
`64f1ff3`). **This is a checkpoint, not a completed-epic summary** — E4.5 and E4.6 are
still open. Written so a fresh session can pick up E4 without re-deriving context from
git log / roadmap.md.

## What's here

### E4.1 — Run queue (`src/scheduler/queue.ts`)

`createRunQueue({ store, limits?, execute })`: per-workstream serialization (at most one
active run per workstream), org/agent/team concurrency caps, human-triggered-first
priority (FIFO within tier). `enqueue(job)` persists the `Run` row via the store's
existing `createRun` mutation (which emits `run_queued`) — the queue itself never emits
events directly. Doesn't invoke adapters; that's the caller-supplied `execute(run, job)`
callback, wired to the E4.2 supervisor.

### E4.2 — Run supervisor (`src/supervisor/supervisor.ts`)

`createRunSupervisor({ store, adapters, ... })`: drives an `ExecutionAdapter` through
`start()` → consume `events()` → map each normalized `EngineEvent` onto run-state
transitions + append-only detail events (`output_delta`→`run_output_delta`,
`tool_call`→`run_tool_call`, `usage_delta`→`run_usage_updated`) → fold the terminal
outcome (`run_ended{outcome}`) into both run and workstream state. Also folds **abnormal**
stream termination (adapter throws, or the iterable just ends without a `run_ended` —
F1 engine crash, or a watchdog-forced cancel the adapter doesn't acknowledge gracefully):
reads the run's current state and transitions to `failed` (still `starting`, never got
going) or `interrupted` (was `running`/`awaiting_input`/`awaiting_approval` — resumable,
E4.6's job). `reasoning_summary` and `permission_request` are recognized but intentionally
dropped (OPEN_ISSUES #23, #24).

### E4.3 — Watchdogs (`src/supervisor/supervisor.ts`, same file)

Wall-clock timeout (`RunSpec.limits.wallClockMs`), stall detection (no event for
`defaultStallMs`), budget cutoff (cumulative `usage_delta` tokens/cost vs. configured
caps). Manually drives the adapter's async iterator via `Promise.race` against timers
(can't race `for await...of` sugar) — on any trip, calls `adapter.cancel(handle)` and
keeps consuming (a well-behaved adapter may still yield a graceful final `run_ended`, e.g.
after a budget cutoff; a stuck one just falls through to the abnormal-termination fold
above). **This file was built by a Haiku subagent and had a real concurrency bug I found
and fixed on review** — see "Delegated to Haiku" below; read that before trusting any
future changes to the watchdog loop without equally careful review.

### E4.4 — Workspace manager (`src/workspace/manager.ts`, standalone)

`createWorkspaceManager({ store, worktreesRoot })`: `acquireGitWorktree(workstreamId,
repoPath)` creates/reuses a per-workstream `git worktree` at a deterministic path; on
re-acquire, a dirty worktree (`git status --porcelain`) refuses (`ok: false`) and
transitions the workstream to `blocked`. `acquireScratchDir` is the plain-directory
fallback for non-code workstreams. `release` best-effort `git worktree remove`s / rmdirs.
**Not wired into the run supervisor** — `RunSpec.workspaceDir` is still whatever the
caller passes on `RunQueueJob` (OPEN_ISSUES #22, #26). Built via `execFileSync("git", [...])`
argument arrays (no shell string interpolation — command-injection-safe), no new npm deps.

## Verified definition of done

```
pnpm install    # green
pnpm run build  # green (tsc, all 5 packages: core, store, adapter-api, adapter-fake, runtime)
pnpm run test   # green — core 100, adapter-api 44, store 54, adapter-fake 37, runtime 16 (251 total)
pnpm run lint:deps  # green — 0 dependency-direction violations (209 modules, 750 deps cruised)
```

## Every built E4 story's acceptance criterion, covered by a test

| Story | AC | Where |
|---|---|---|
| E4.1 | 3 jobs on one workstream execute strictly serially; caps honoured under load; queueing emits events | `scheduler/queue.test.ts` (4 tests) |
| E4.2 | Fake "happy path" ⇒ run rows, events, workstream state all correct | `supervisor/supervisor.test.ts` (happy-path, needs_input, engine-crash, closed-workstream-refusal — 4 of the 8 tests in this file) |
| E4.3 | Fake "hang" ⇒ interrupted at stall cap with events; fake "burn" ⇒ cut at budget with `budget_exhausted` | `supervisor/supervisor.test.ts` `describe("watchdogs — E4.3")` (stall, budget, wall-clock, happy-path-no-false-positive — 4 tests; stall/wall-clock tests also assert `adapter.cancel()` was actually called, not just that the run ended up in the right state) |
| E4.4 | Two workstreams on one repo get isolated worktrees; dirty worktree ⇒ run refused + workstream blocked | `workspace/manager.test.ts` (4 tests, real temp git repos) |

**Not built**: E4.5 (⚠ startup reconciliation + pid sweep), E4.6 (resume flow) — see "Next up."

## Open issues raised

Six, in `docs/implementation/OPEN_ISSUES.md` #22–27 (continuing from E1/E2/E3's): `RunSpec`
fields the supervisor can't resolve itself yet (#22), `reasoning_summary` has no catalogue
slot (#23), `permission_request` deliberately unhandled pending E6.4 (#24),
`workstream_waiting`'s `waiting_on_ref` is always `null` pending E8.3 (#25), the workspace
manager isn't wired into the supervisor yet (#26), and a new test-only dependency-cruiser
carve-out for `runtime → adapter-fake` (#27, needed because contracts.md's testing
strategy explicitly wants "runtime + store + fake adapter scenarios" integration tests,
which the original blanket layer rule didn't allow for).

## Delegated to Haiku — and what review caught

E4.3 (watchdogs) and E4.4 (workspace manager) were built by two Haiku subagents in
parallel, each in its own isolated `git worktree` (to avoid the shared-workspace collision
that hit E2/E3 — see their SUMMARY docs), after I built the shared abnormal-termination
fold myself first (both E4.3 and E4.6 depend on it, and it's the kind of shared
correctness-sensitive plumbing that shouldn't be split across two parallel agents editing
the same function).

**E4.4 was clean.** One dead-import nit (`accessSync`/`constants` imported, never used) —
fixed, nothing else.

**E4.3 had two real bugs**, both found only by reading the diff line by line, not by the
tests (which were green either way):

1. The `Promise.race` timeout used a fake `{done: true}` sentinel indistinguishable from
   genuine iterator exhaustion. A timeout race win `break`-ed the consume loop immediately
   — **`adapter.cancel()` was never actually called** for the stall/wall-clock paths (only
   the budget-cutoff path, which trips synchronously inside event handling, worked
   correctly). The run still ended up `interrupted` because the independent
   abnormal-termination fold caught it anyway, so every test passed despite the underlying
   engine process never being told to stop. Fixed by using a distinct `Symbol` sentinel and
   `continue`-ing (not `break`-ing) on a timeout, so the top-of-loop check gets a chance to
   fire the cancel. Added a `spyOnCancel` wrapper in the tests to assert `cancel()` is
   actually invoked — this exact bug class can't silently reappear now.
2. The `failed` `run_ended` outcome folded its error message into `result` instead of the
   `error` field `transitionRunState`'s `run_failed` event payload actually reads from
   (`packages/store/src/mutations/runs.ts`), silently dropping it from the event log. The
   agent's own test asserted against the new (wrong) location instead of the actual
   contract, so it passed too. Reverted to the original `error:` field; fixed the test to
   check the emitted event's payload instead.

Lesson banked in memory: green tests from a Haiku swarm are a start, not a stopping point,
especially for anything touching concurrency/timers.

## Next up: E4.5 and E4.6

**E4.5 — Startup reconciliation + pid sweep (⚠ KEYSTONE, F3/F7).** Not started. On control-
plane restart: scan `running` runs → mark `interrupted`, re-queue queued work, resume
watchdogs (F3 — this is doc-01's success test #1). Pid sweep (F7, killing orphaned engine
processes) is **greenfield** — no pid-registry code exists anywhere yet, and the fake
adapter has no real OS process to track, so this part may need to wait until E9
(claude-code adapter, which does spawn real processes) exists, or be built against an
adapter-agnostic "did this run's adapter say `run_ended`? no? sweep it" check instead of
literal PIDs. Worth resolving that scope question before starting.

**E4.6 — Resume flow.** Haiku-sized once picked up. Mechanics needed: when a run lands in
`interrupted` (via the abnormal-termination fold above), if
`adapter.capabilities().resume` is true and this is the *first* interruption for this
run's lineage, automatically schedule exactly one resume attempt via `adapter.resume({
...spec, sessionRef: run.engine_session_id })`; if that resume attempt *also* ends up
interrupted/failed, do not resume again (stay human-visible). **The "second failure →
`degraded` + inbox" part of the AC needs no new code**: `degraded` is already a derived
agent-status value in `packages/store/src/projections/status.ts`
(`recentConsecutiveFailures >= 2`, built in E2.5) — it'll just start showing up correctly
once E4.6's resume-once behavior feeds it real consecutive-failure data. Test fixtures
already exist and are unused so far: `resume-after-interrupt-initial.json` +
`resume-after-interrupt-continuation.json` in `packages/adapter-fake/scenarios/`.

## Branch/worktree hygiene note

Unlike E2/E3 (built in a shared working directory, per their SUMMARY docs' "shared-
workspace note" sections), this epic used isolated `git worktree`s throughout — one for
the main `phase-1/runtime` line of work, one each for the two parallel Haiku subagents
(`phase-1/runtime-watchdogs`, `phase-1/runtime-workspace`, both merged and deleted after
landing). No cross-lane collisions this time.
