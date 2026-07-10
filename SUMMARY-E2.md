# Phase 1 — `@foundry/store` (Epic E2)

Branch: `phase-1/store`. Scope: `packages/store` per `docs/implementation/roadmap.md`
E2.1–E2.7. No other package touched (the concurrent `phase-1/adapters` lane owns
`packages/adapter-api`, visible in this working tree but not part of this branch's diff).

## What's here

SQLite (WAL mode) via `better-sqlite3`, hand-written numbered forward-only migrations, no
ORM. `mutate()` is the only write path; entity queries; the event feed
(after/subscribe/compactRunDeltas); the six purpose-built projections; a content-addressed
artifact store; backup/restore.

- **E2.1** (`src/db/`): `openDb()` opens WAL-mode SQLite (or `:memory:` for tests) and runs
  `runMigrations()` — numbered, forward-only, idempotent, tracked in `schema_migrations`.
  Migration DDL lives as embedded TS string constants (`db/migrations.ts`), not loose
  `.sql` files, so `tsc` ships them in `dist` with no asset-copy step.
- **E2.2 ⚠ KEYSTONE** (`src/mutate.ts`): `mutate({ apply(tx), events })` runs `apply(tx)`
  and every event insert inside one better-sqlite3 transaction; event payloads are
  validated against the core catalogue (`getEventPayloadSchema`) before insert; a throw
  anywhere (including a caller simulating a crash) rolls back the *entire* transaction —
  neither the state change nor any event survives. Subscribers are notified only after
  commit, with `seq` assigned. A standalone enforced check
  (`src/no-other-write-path.test.ts`) scans every shipped source file for raw write-SQL
  keywords and asserts they only appear in `mutate.ts`, the mutation-helper/compaction
  files that call it, and the migration runner (schema DDL, not app state) — the "lint
  rule" the roadmap AC asks for, plus a second test guarding the allow-list itself
  against silently going stale.
- **Transition-enforcing mutation helpers** (`src/mutations/*.ts`): thin wrappers around
  `mutate()` for agents, teams, workstreams, runs, tasks, messages/threads, and
  approvals. Each state transition is validated via core's `canTransition`/
  `canTransitionDisposition` — never a store-local copy of the rules (OPEN_ISSUES.md
  #6–#8) — with a compare-and-swap re-check inside `apply()` since `mutate()`'s `events`
  array must be built before the transaction runs.
- **E2.3** (`src/queries/*.ts`): read-only CRUD per entity, incl. `tasks.tree(rootTaskId)`.
  Fixture-based tests per entity plus a 10k-row perf sanity check.
- **E2.4** (`src/events/feed.ts`): `after(seq, filter?)` replay, in-process `subscribe`,
  and `compactRunDeltas(runId)`. Replay-after-reconnect test proves no gaps, no dupes.
- **E2.5** (`src/projections/*.ts`): `orgView`, `agentPage`, `workstreamTimeline`,
  `delegationTree`, `inbox`, `costRollup`. `status.ts` is the single, pure definition of
  agent status (ADR-008): `deriveAgentStatus()` implements the doc-02 precedence table
  (`blocked > degraded > waiting > active > over-committed > idle`), tested case by case
  independent of SQLite; `computeAgentStatusFacts()` is the only place that turns live
  rows into its inputs. `worstStatus()` gives team roll-ups the same precedence.
- **E2.6** (`src/events/feed.ts` + `src/projections/workstreamTimeline.ts`):
  `compactRunDeltas` folds `run_output_delta` events into `<dataDir>/runs/<id>/transcript.md`
  and prunes those rows; `workstreamTimeline` reads live deltas when present and falls
  back to the transcript file otherwise (`transcriptSource: "live"|"file"|"none"`),
  verified by a test that compacts mid-test and re-renders the timeline.
- **E2.7** (`src/artifacts/store.ts`, `src/backup.ts`): content-addressed artifacts
  (sha256, deduplicated writes, path stored *relative* to `dataDir` — see OPEN_ISSUES.md
  #21); `readArtifact` re-hashes on read and throws on mismatch. `backupStore`/
  `restoreStore` wrap `db.backup()` plus a recursive copy of `artifacts/`/`runs/`; the
  round-trip test destroys the source `dataDir` before verifying the restored copy, to
  actually prove cross-location restore works.
- **`src/store.ts`**: `createStore(config)` assembles the exact `Store` interface from
  contracts.md (`mutate` + per-entity queries + `events` + `projections`), plus an
  additive `commands` namespace exposing the mutation helpers without ever handing
  callers a raw, writable `db` handle outside `mutate()`'s `apply(tx)`. `src/store.test.ts`
  exercises the whole assembled object through a full small-org scenario (team → agent →
  workstream → run → task delegation/delivery/acceptance → messages → approval →
  artifact → backup) end to end.

## Verified definition of done

From the shared workspace (`pnpm install` also picks up the concurrent adapter-api lane's
package, present in the working tree):

```
pnpm install    # green
pnpm run build  # green (tsc, core + store + adapter-api)
pnpm run test   # green — store: 11 files, 54 tests; core: 100; adapter-api: 44
pnpm run lint:deps  # green — 0 dependency-direction violations
```

Store package alone: `cd packages/store && npx vitest run` → 11 files, 54 tests, all green.

## Every E2 acceptance criterion, covered by a test

| Story | AC | Test |
|---|---|---|
| E2.1 | Fresh dir → current schema; re-run idempotent; version recorded | `db/migrate.test.ts` |
| E2.2 | Kill-mid-transaction: neither state nor event persists; monotonic seq; no other write path | `mutate.test.ts`, `no-other-write-path.test.ts` |
| E2.3 | Fixture-based query tests incl. 10k-row perf sanity | `queries/queries.test.ts` |
| E2.4 | Replay-after-reconnect: no gaps, no dupes | `events/feed.test.ts` |
| E2.5 | Fixture→snapshot tests per projection; status precedence case by case | `projections/status.test.ts`, `projections/projections.test.ts` |
| E2.6 | Post-compaction timeline still renders from transcript; rows pruned; audit fields retained | `events/feed.test.ts`, `projections/projections.test.ts` |
| E2.7 | sha256 verify on read; backup/restore round-trip | `artifacts/store.test.ts`, `backup.test.ts` |

## Open issues raised

Five items appended to `docs/implementation/OPEN_ISSUES.md` (#17–21): no catalogue event
for thread/team/artifact creation or compaction (core's catalogue has no type for these;
each is still auditable through what references it); the over-committed status threshold
has no specified numeric value anywhere (taken as a parameter defaulting to 5, pending
E6's real policy value); the six projection return shapes (`OrgView`, `AgentPage`,
`Timeline`, `TreeView`, `InboxItem`, `CostReport`) had to be invented since contracts.md
names them without a field list; and artifact paths are stored relative to `dataDir`
rather than absolute, so backup/restore survives a relocated `.foundry` directory.

## Delegated to Haiku

None. Given the shared working directory turned out to host a second, concurrent lane
(`phase-1/adapters`) with its own git operations (branch switches, stashes) landing in
the same checkout, adding a Haiku subagent into that mix risked a third set of hands in
an already-delicate shared index — the mechanical portions (per-entity queries, row
mappers, fixture tests) were fast enough to write directly while keeping commits tight
and immediately pushed after each story, which mattered more here than the delegation
would have saved.

## Note on the shared working directory

This branch was built in a working directory shared with the concurrent `phase-1/adapters`
(E3) lane — not a separate worktree. Its branch switches and a `git stash` (correctly
labelled "not mine to commit") were visible mid-session; no work was lost, but every
commit in this branch's history was staged file-by-file (`git add <exact paths>`) rather
than broadly, specifically to avoid sweeping the other lane's untracked/staged files into
this branch. `packages/adapter-api/` remains untracked in the working tree and is not part
of this branch's diff. `pnpm-lock.yaml` was regenerated once at the end and reflects both
lanes' dependencies, per the work order's note that this file is contested ground between
lanes; `main` had not moved by the time this branch was finished, so no rebase was needed.
