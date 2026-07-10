# Phase 1 — `@foundry/runtime` (Epic E4, complete)

E4.1–E4.4 merged to `main` via PR #5 (`phase-1/runtime`, squash commit `64f1ff3`).
E4.5 + E4.6 completed 2026-07-10 on `phase-1/runtime-reconcile` (this branch), closing
the epic. Sections below describe all six stories; the "Delegated to Haiku" section
records what line-by-line review caught in each delegated story (E4.3, E4.4, E4.6 — a
real bug each round in the timer/state-machine code, never surfaced by the green tests).

### E4.5 — Startup reconciliation + pid sweep (`src/reconcile/reconcile.ts`) ⚠ KEYSTONE

`reconcileOnStartup({ store, pids?, requeue })` — F3: on control-plane restart, every
non-terminal run folds to what the restart means for it (`starting` → `failed` — no
`starting → interrupted` edge exists and there is no session to resume; `running` /
`awaiting_input` / `awaiting_approval` → `interrupted`, keeping `engine_session_id` so
E4.6/a human can resume; `queued` → handed to `requeue`, re-injected via the new
`RunQueue.restore(run, job)` which schedules an already-persisted run without a second
row/`run_queued` event). Emits `system_reconciled`. F7: `createPidRegistry(dir)` is the
pid-file registry — the supervisor registers `handle.pid` (new **additive optional**
`RunHandle.pid` field, OPEN_ISSUES #28) while a stream is live; at startup every
still-registered pid is by definition an orphan: killed if alive
(`system_orphan_process_killed` recorded), cleared silently if already dead. Tested
against a file-backed store across a simulated process death and a **real spawned orphan
process**. The scope question the checkpoint flagged (nothing real to track until E9) was
resolved *adapter-agnostically*: the fake adapter exposes no pid so registration is a
no-op today, and E9 gets sweeping for free by putting `pid` on its handles.

### E4.6 — Resume flow (`src/supervisor/supervisor.ts`)

When a stream ends without `run_ended` and the run folds to `interrupted`, the
supervisor auto-resumes **exactly once**: gates are adapter `capabilities().resume` +
`resume()` present, non-null `engine_session_id`, and no prior `run_resumed` event for
this run in the event log (the log makes once-only hold across control-plane restarts).
The resume reuses the *same run row* via the `interrupted → starting` edge
(`run_resumed`), then `adapter.resume({ ...spec, sessionRef })` feeds the same watchdog
loop (`superviseStream`, extracted unchanged from E4.3's execute body). Budget totals
carry across attempts (a resume can't double the caps); wall-clock/stall restart fresh.
If the resumed stream also dies, the shared `foldTerminalState` dispatches by current
state — `failed` if it never reached `run_started` again, `interrupted` otherwise — and
never resumes twice. The "second failure ⇒ `degraded`" half of the AC needed **zero new
code**, as predicted: `deriveAgentStatus` (E2.5) counts consecutive `failed` runs, and
the test proves two graceful `run_ended{failed}` runs flip the agent's projected status
to `degraded`. Fixtures `resume-after-interrupt-{initial,continuation}.json` are now
exercised.

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
pnpm run test   # green — core 100, adapter-api 44, store 54, adapter-fake 37, runtime 27 (262 total)
pnpm run lint:deps  # green — 0 dependency-direction violations (213 modules, 771 deps cruised)
```

Environment note: this machine runs Node 18 (repo `engines` wants ≥20 — warning only);
better-sqlite3's native binary must match the Node ABI — if tests fail with
`ERR_DLOPEN_FAILED`, re-run `npm run install` inside
`node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3` (per worktree).

## Every built E4 story's acceptance criterion, covered by a test

| Story | AC | Where |
|---|---|---|
| E4.1 | 3 jobs on one workstream execute strictly serially; caps honoured under load; queueing emits events | `scheduler/queue.test.ts` (4 tests) |
| E4.2 | Fake "happy path" ⇒ run rows, events, workstream state all correct | `supervisor/supervisor.test.ts` (happy-path, needs_input, engine-crash, closed-workstream-refusal — 4 of the 8 tests in this file) |
| E4.3 | Fake "hang" ⇒ interrupted at stall cap with events; fake "burn" ⇒ cut at budget with `budget_exhausted` | `supervisor/supervisor.test.ts` `describe("watchdogs — E4.3")` (stall, budget, wall-clock, happy-path-no-false-positive — 4 tests; stall/wall-clock tests also assert `adapter.cancel()` was actually called, not just that the run ended up in the right state) |
| E4.4 | Two workstreams on one repo get isolated worktrees; dirty worktree ⇒ run refused + workstream blocked | `workspace/manager.test.ts` (4 tests, real temp git repos) |
| E4.5 | Kill control plane mid-fake-run; restart ⇒ run `interrupted`, orphan killed, queued work requeued (doc-01 success test #1) | `reconcile/reconcile.test.ts` (4 tests: file-backed store abandoned mid-flight + reopened; real spawned orphan killed and recorded; stale pid cleared silently; session id survives for resume) + `queue.test.ts` restore() test |
| E4.6 | Interrupted fake run auto-resumes once with sessionRef; second failure ⇒ degraded | `supervisor/supervisor.test.ts` `describe("resume flow — E4.6")` (6 tests: happy resume incl. event ordering; resume-also-dies stays interrupted, one attempt; resume dying pre-run_started folds to failed; no-capability and no-sessionRef skip; two failed runs ⇒ projected agent status `degraded`) |

## Open issues raised

Seven, in `docs/implementation/OPEN_ISSUES.md` #22–28 (continuing from E1/E2/E3's): `RunSpec`
fields the supervisor can't resolve itself yet (#22), `reasoning_summary` has no catalogue
slot (#23), `permission_request` deliberately unhandled pending E6.4 (#24),
`workstream_waiting`'s `waiting_on_ref` is always `null` pending E8.3 (#25), the workspace
manager isn't wired into the supervisor yet (#26), a new test-only dependency-cruiser
carve-out for `runtime → adapter-fake` (#27, needed because contracts.md's testing
strategy explicitly wants "runtime + store + fake adapter scenarios" integration tests,
which the original blanket layer rule didn't allow for), and the E4.5 pid-sweep scope
resolution incl. the additive `RunHandle.pid` field (#28).

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

**E4.6 (resume flow) was also Haiku-built** (single agent, isolated worktree, stacked on
the E4.5 branch since both touch `supervisor.ts`), against a brief that pre-pinned the two
subtleties (same-run-row resume via the `interrupted → starting` edge; `degraded` counts
only `failed` runs, so its test must use two graceful `run_ended{failed}` runs). Review
again caught **one real bug the green tests couldn't see**: the resume-failure path
hardcoded a transition to `interrupted`, an invalid edge when the resumed stream died
before its `run_started` (run still `starting`) — `transitionRunState` would have thrown
and stranded the run in `starting`. Fixed by extracting the state-dispatching
`foldTerminalState` shared by both attempts, plus a regression test (instant-crash resume
scenario). Two nits: `handle: any` → `RunHandle`, dead comment block.

Lesson banked in memory (now 3-for-3 across E4.3/E4.4/E4.6): green tests from a Haiku
swarm are a start, not a stopping point, especially for anything touching
concurrency/timers/state-machine edges.

## Next up: E5 (`@foundry/server`)

E4 is done; the store lane's next epic is E5 (control-plane server: API + SSE feed +
CLI). The two integration seams E5 must close are already flagged: OPEN_ISSUES #22
(the `Runtime` facade — resolving agentName/workspaceDir/orgTools/engineConfig from the
store + policy so `enqueue({workstreamId, trigger})` works as contracts.md specifies) and
#26 (wiring the E4.4 workspace manager into that facade: acquire before `adapter.start`,
release on terminal, refuse the run if acquisition fails). E5.1's startup orchestration
is where `reconcileOnStartup` gets called (migrate → reconcile → listen), passing
`RunQueue.restore` as the `requeue` callback and a `createPidRegistry(<dataDir>/pids)`.
Technology per doc-08: Fastify + SSE — note the Node-18 environment constraint above
(Fastify 4, not 5, until Node is upgraded).

## Branch/worktree hygiene note

Unlike E2/E3 (built in a shared working directory, per their SUMMARY docs' "shared-
workspace note" sections), this epic used isolated `git worktree`s throughout — one for
the main `phase-1/runtime` line of work, one each for the two parallel Haiku subagents
(`phase-1/runtime-watchdogs`, `phase-1/runtime-workspace`, both merged and deleted after
landing), and one for E4.6's Haiku agent (`phase-1/runtime-resume`, stacked on
`phase-1/runtime-reconcile` because both stories touch `supervisor.ts` — stacking instead
of parallelizing was the collision-avoidance this time). No cross-lane collisions.
