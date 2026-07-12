# Phase 2 — Memory & self-improvement (Epic E11, complete)

Built on `phase-2/org-tools`. E11.1–E11.3 (git-versioned memory, composition inclusion,
close-with-distillation) landed in a prior session; this session added E11.4 (skills
directories) and E11.5 (FTS5 recall), each Haiku-built in an isolated worktree and
reviewed line by line before merging. 130 server tests, 61 store tests green; workspace
build/lint:deps clean.

## What's here (this session's additions)

- **E11.4** Skills directories (`packages/server/src/skills/`): `SKILL.md` parsing
  (flat YAML frontmatter — `name`/`description` required, unknown keys tolerated —
  verified against a real agentskills.io file already on this machine, not guessed at)
  and discovery (`agents/<id>/skills/<name>/SKILL.md`, silently skipping malformed
  entries). A new "# Skills" section appended to composed context (fixed section order
  preserved — new sections go at the end, never reordered) lists each discovered
  skill's name + description. Git versioning extended to the skills directory
  (`commitAgentSkills`, factored out of E11.1's `commitAgentMemory` via a shared
  `commitDirectory` helper), wired into the same `afterRun` hook.
- **E11.5** FTS5-backed `search_history` (`packages/store/src/queries/search.ts`,
  `db/migrations.ts` version 2): replaces the LIKE-scan placeholder with real FTS5
  virtual tables over messages/workstreams/runs, kept in sync inside the same
  `mutate()` transactions as the base-table writes (no second write path), with a
  one-time backfill for pre-existing data. User query input is escaped as an FTS5
  phrase match so special characters (quotes, hyphens, asterisks, boolean keywords)
  can't throw a syntax error.

## Delegated to Haiku — and what review caught

**E11.4 was clean** — real behavioral tests throughout (a genuine `SKILL.md` file
written to a temp dir, real context composed and asserted against, a real run driven
through `createServer` to prove the git commit actually appears), no bugs found.

**E11.5 had a bug serious enough to be worse than the placeholder LIKE-scan it
replaced**: every one of the three FTS joins (`messages_fts`, `workstreams_fts`,
`runs_fts`) keyed on SQLite's implicit `rowid` (`messages_fts.rowid = m.rowid`) instead
of the `id UNINDEXED` column each FTS table already stored specifically for this
purpose — that column was written on every insert but never once read. `rowid` is
assigned independently by each table; the join only coincidentally holds when both
tables are populated in exact, gap-free lockstep. Verified empirically (a throwaway
repro script, not just reasoning about it) that after any divergence — the migration's
one-time backfill re-populating from existing data with no `ORDER BY` guarantee, or a
future deletion — the join silently pairs the wrong base row with the wrong FTS match.
This is a worse failure mode than "no results": a real ref and excerpt, pointing at
content that isn't what actually matched. Fixed all three joins to key on `.id = .id`
and added a regression test that manufactures the divergence directly (no
delete-message command exists in this system to trigger it naturally) — it fails
against the original join and passes against the fix. Also hardened a related latent
issue: `runs_fts`'s `INSERT OR REPLACE` doesn't actually replace anything (FTS5 virtual
tables can't declare a `UNIQUE` constraint on a plain column for it to conflict
against — also verified empirically) so a run whose result got set more than once
would have accumulated stale duplicate FTS rows; changed to an explicit
delete-then-insert.

Lesson this time isn't about missing tests (E11.5's suite was reasonably thorough) —
it's that passing tests over happy-path insert-then-immediately-search sequences can't
catch a correctness assumption that only breaks under reordering, which is exactly the
scenario a one-time data-migration backfill is prone to.

## Verified definition of done

```
pnpm install && pnpm run build && pnpm run test   # 130 server, 61 store, 384 total green
pnpm run lint:deps                                # 0 violations (314 modules, 1131 deps)
```

## Deliberately not built

Documented in OPEN_ISSUES #40/#41: Claude Code's native skill-directory loading (needs
live CLI verification, same posture as #38's permission-hook gap — not guessed at) and
agent-page skill display (a different, unmerged UI branch); FTS5 `snippet()`-highlighted
excerpts (a nice-to-have, not required by doc-05's AC).

## Next up

E12 (release gate): the six doc-01 success tests automated full-stack, every expressible
doc-07 failure mode, the 3-team/8-agent multi-level org scenario, quickstart docs,
dogfood.
