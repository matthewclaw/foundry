# Phase 2 — Release gate (Epic E12, mostly complete)

Built on `phase-2/org-tools`. E12.1/E12.3 Haiku-built in an isolated worktree and
reviewed/fixed; E12.2's runtime fix and E12.4's quickstart/CLI fix built directly. 134
server tests, 412 across the workspace, build/lint:deps clean.

## E12.1 — doc-01 "what success looks like," the three genuine gaps

Doc `01-executive-summary.md` lists six success criteria restated as tests. Three
already had automated coverage elsewhere (not rebuilt, just confirmed still present):
#1 (kill-and-restart persistence) in `packages/runtime/src/reconcile/reconcile.test.ts`;
#4 (answer everything about a completed task from the UI alone) is a UI-lane concern,
out of scope for this server-only branch; #6 (a new adapter reaches "runs end-to-end"
via one interface + one contract suite) is `adapter-api`'s conformance suite passing
against `adapter-fake`. Three gaps, now covered in
`packages/server/src/e2e-success-tests.test.ts`:

- **#2** (200 agents; org view loads fast; cost is zero until runs start) — 200 agents
  across 3 teams + unassigned, `orgView()` returns in well under a second, every agent
  accounted for under the right team, `costRollup({level:"org"})` genuinely zero (no
  run ever executed).
- **#3** (swap an agent's engine; identity/memory/history/workstreams unchanged) — a
  real `rebindAgentEngine` call after writing real memory and driving a real run to
  completion; every other field verified byte-for-byte unchanged.
- **#5** (an agent 3 levels deep escalates; reaches the inbox with the full chain) — a
  real 3-level delegation built through the HTTP org-tools surface, escalation from the
  deepest agent, verified in `store.projections.inbox()` with a genuinely walkable
  `parent_task_id` chain back to the root.

## E12.2 — failure-mode coverage (doc-07 F1–F15)

Rather than rebuild scenarios that already exist scattered across earlier epics'
tests, audited what's covered and closed the one real gap found:

| # | Failure mode | Covered by | Status |
|---|---|---|---|
| F1 | Engine crash mid-run | `runtime/supervisor/supervisor.test.ts` | ✅ |
| F2 | Engine hang/stall | `runtime/supervisor/supervisor.test.ts` | ✅ |
| F3 | Control-plane restart | `runtime/reconcile/reconcile.test.ts` | ✅ |
| F4 | Runaway delegation (depth/budget) | `server/policy/policy.test.ts` (+ E8.2 property test) | ✅ |
| F5 | Message ping-pong (thread round cap) | `server/routes/orgtools.test.ts` (E8.4) | ✅ |
| F6 | Cost blowout | Watchdog cutoff tested (E4.3); task→`blocked`→escalation **not built** | ⚠ open (OPEN_ISSUES #39) |
| F7 | Orphan processes | `runtime/reconcile/reconcile.test.ts` | ✅ |
| F8 | Dirty workspace | `runtime/workspace/manager.test.ts` | ✅ |
| F9 | Memory corruption / bad self-edits | Git versioning mechanism tested (`memory/git.test.ts`); recovery is `git revert` by a human, not a distinct code path to test | ✅ (mechanism proven; "corruption" itself is a human/git operation, not app logic) |
| F10 | Poisoned agent output | Architectural (provenance labelling + policy caps + human acceptance gates), not a single mechanism a fake scenario tests in isolation | N/A by design |
| F11 | Routing failure | `server/routes/orgtools.test.ts` (E8.5) | ✅ |
| F12 | Rejected-work loop | `server/policy/policy.test.ts`, `orgtools.test.ts` (E8.1) | ✅ |
| F13 | Event feed disconnect | `server/routes/feed.test.ts` | ✅ |
| F14 | SQLite contention/growth | WAL + compaction (E2.6) tested; contention itself is a config/infra property, not fake-scenario-testable | N/A by design |
| F15 | Adapter emits malformed events | **Was unimplemented** — fixed this session | ✅ |

**F15 fix**: the supervisor's event loop trusted `adapter.events()`'s TypeScript-declared
`EngineEvent` type at face value — erased at runtime, so a buggy adapter yielding a
malformed object would either silently fall through `handleEvent`'s switch or throw a
confusing, unrelated error deep in a handler that partially matched a valid shape.
Added `EngineEventSchema.safeParse` right after receiving each event
(`packages/runtime/src/supervisor/supervisor.ts`); a validation failure throws, which
the loop's existing `try/catch` already routes through the same abnormal-termination
fold F1/F2 use — no new state-transition code, reuses fully-tested logic. Regression
test drives a hand-rolled adapter (not the fake adapter's type-checked scenario DSL,
which couldn't construct genuinely malformed data) yielding one valid event then
garbage, confirming the run folds to `interrupted` rather than corrupting other state.

## E12.3 — 3-team/8-agent multi-level org scenario

One real, full scenario in `e2e-success-tests.test.ts`: 3 teams (3/3/2 agents),
human delegates a root task to L1, L1 → L2 → L3 (3 levels, spanning teams), L3
delivers, the cascade of accept/deliver runs back up through L2 and L1 to the human,
who accepts last. Verified against real projections at the end: `delegationTree`
shows exactly the 3-node chain with correctly incrementing depth, all three tasks
`"done"`, `costRollup` reflects the right workstream structure.

## E12.4 — Docs + a bug found by actually following them

`docs/implementation/quickstart.md`: init → daemon start → agent create → message →
observe → backup → stop, plus a short adapter-author guide. Every command in it was
run live against a real build, not written from reading the source — which is how a
real, quickstart-blocking bug turned up: `foundry daemon start`, run from a directory
outside this repo (the realistic case for anyone who actually installed the CLI),
failed outright. `locateDaemonScript()` (`packages/cli/src/foundry.ts`) only ever
searched relative to the *caller's* current working directory (walking up for
`node_modules/@foundry/server`, or a repo-root heuristic) — both strategies assume
`foundry` is invoked from inside this repo's own working tree. Fixed by adding a
resolution strategy based on the CLI script's own install location (two levels up from
`.../cli/dist` reaches the common parent of sibling packages, whether that's this
monorepo's `packages/` or a real install's `node_modules/@foundry/`), which is the
standard way an installed CLI finds a co-located package regardless of cwd. Regression
test spawns the real built CLI from a tmpdir outside the repo and confirms the daemon
actually starts.

## E12.5 — Dogfood

Explicitly out of scope for this session: doc-01's own text frames it as "one week of
real use," a process/practice activity, not something buildable as code in a single
sitting. Left for whoever operates this system going forward.

## Verified definition of done

```
pnpm install && pnpm run build && pnpm run test   # 412 green (server: 134)
pnpm run lint:deps                                # 0 violations (316 modules, 1143 deps)
```

## What's still open going into a real release

- OPEN_ISSUES #39 (budget spend never tracked from `usage_delta` — affects F6, E10.3's
  cost view, and any future per-task budget enforcement).
- OPEN_ISSUES #38 (Claude Code permission-hook wiring — needs a live CLI capture, not
  guessable).
- OPEN_ISSUES #40 (Claude Code native skill loading, agent-page skill display — other
  branches).
- `phase-2/ui` and `phase-2/claude-code` remain unmerged into `phase-2/org-tools` —
  the UI and real-engine work exist and are tested on their own branches but haven't
  converged with everything built this session. Merging all three into `main` (or
  each other) is the natural next step before an actual release.
