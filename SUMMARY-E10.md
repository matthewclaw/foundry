# Phase 2 — Inbox, delegation tree, cost (Epic E10, complete)

Built on `phase-2/org-tools` (E10.4, server-side) and `phase-2/ui` (E10.1–E10.3, all UI).
All Haiku-built across four isolated worktrees, each reviewed line by line and fixed
before merging. 108 server tests, 31 UI tests green; both workspaces' build/lint:deps clean.

## What's here

- **E10.1** Inbox view (`packages/ui/src/views/Inbox.tsx`): replaces the E7.1 placeholder
  with severity-then-age sorted items (approvals before messages, oldest first within
  each tier), inline Grant/Deny actions on `approval_pending` items (parsing the
  approval id from `item.ref` via `@foundry/core`'s `parseRef`), and honest scope-limiting
  on `message_surfaced` items — no fake action buttons where the `InboxItem` projection
  doesn't carry enough data (message type, thread ref) to support one yet.
- **E10.2** Delegation tree view (`packages/ui/src/views/TaskTreeView.tsx`, new
  `/tasks/:id/tree` route): recursive renderer over the already-live
  `GET /api/tasks/:id/tree`, one row per task indented by depth, status badges,
  budget meters (uncapped-aware, locale-pinned token formatting), and a red
  left-border/background highlight on `rejected`/`blocked` nodes as the escalation-path
  cue. Workstream deep-linking and cancel/raise-budget actions are explicitly out of
  scope and documented inline (the tree projection carries no `workstream_id`, and
  round-tripping cancel/raise-budget needs live workstream context this read-only view
  doesn't have) — noted, not faked.
- **E10.3** Cost view (`packages/ui/src/views/CostView.tsx`, new `/cost` route): org-wide
  spend/limit stat blocks (USD + tokens, "uncapped" when a limit is null) and a
  breakdown table over `GET /api/cost`. The "unreported" capability-degradation
  indicator from the roadmap's AC is deliberately not built — no such flag exists on
  `CostReport` yet (would need a store-side change), noted inline rather than invented.
- **E10.4** Three anomaly rules escalating to the inbox (`packages/server/src/server.ts`'s
  `afterRun` hook, `routes/orgtools.ts`'s `delegate_task`):
  - **Crash loop** (F1): the moment an agent's 2nd consecutive run ends `failed` (crossing
    into `"degraded"` status), a surfaced escalation fires — exactly once, not on every
    subsequent failure.
  - **Budget %**: a workstream crossing 80% of either budget axis (USD or tokens) for
    the first time fires a surfaced, workstream-scoped escalation naming which
    workstream and its current percentage.
  - **Cap hits** (F4-adjacent): `delegate_task` rejections for `depth_cap` or
    `budget_exceeded` now also escalate to the human (mirroring E8.5's `routing_failed`
    pattern) in addition to returning the error to the calling run.

## Delegated to Haiku — and what review caught

**E10.1/E10.3** were clean beyond two real bugs in `CostView.tsx`: the token-axis stat
block's limit was formatted with `formatUsd` regardless of which axis was being shown
(`"$10000000.00"` instead of `"10,000,000"`), and `toLocaleString()` with no locale
argument follows the runtime's default locale — this environment renders `"5 000 000"`,
not `"5,000,000"`, so a comma-formatted-number test failed on a clean run. Both fixed;
the locale-pin (`toLocaleString("en-US")`) became the standing rule for every later
number-formatting story this session (E10.2 applied it correctly from the start, having
been told about it explicitly in its brief).

**E10.2** was clean on review — the agent hit the session's API rate limit mid-batch but
had already finished both the implementation and its 9 tests before being cut off.

**E10.4 had the two most severe bugs of any batch this session**, both hidden behind
tests that were entirely vacuous ("infrastructure compiles and is wired" placeholders
that created a thread and asserted it existed, never driving the actual rule):

1. **Crash-loop detection never fired, at all, ever.** The code checked
   `run.state === "failed"` on the `run` object `afterRun` receives — but that's the
   *pre-execution* snapshot `runtime/facade.ts`'s `execute()` resolves before the
   supervisor runs; nothing updates it in place as the run progresses (state changes go
   through the store, not this in-memory reference). The check's `if` body was
   unreachable in practice. Fixed by re-fetching `store.runs.get(run.id)` fresh inside
   the hook — confirmed by a real test (two clean failed runs on one workstream) that
   failed before the fix and passes after.
2. **The same staleness bug on `workstream.budget`** for the budget-% rule, plus a wrong
   thread anchor: budget escalations were anchored to `("workstream", agent.id)` — the
   same thread crash-loop and cap-hits use — instead of the specific workstream that
   crossed the threshold, which both conflated unrelated workstreams' alerts into one
   thread and let one workstream's escalation wrongly suppress (via the "already
   escalated" dedup check) a different workstream's genuine first-time crossing. Fixed
   to re-fetch fresh and anchor/name the message per-workstream.
3. Cap-hits (the third rule) had no staleness bug, but also had a placeholder test;
   replaced with two real ones exercising actual `depth_cap` and `budget_exceeded`
   rejections through the HTTP route.

While fixing #2, found and documented (OPEN_ISSUES #39, not fixed — a real feature, out
of E10.4's scope) that **nothing anywhere folds a run's `usage_delta` into a workstream's
or task's persisted budget spend** — `usage_delta` only ever produces an audit-trail
detail event, never updates `budget_json.spent_*`. This means E10.3's cost view has been
reporting each workstream's *creation-time* spend, never its actual usage, since it
shipped — a pre-existing gap this review exposed rather than introduced.

Lesson reconfirmed, now the clearest case yet: a green test suite proved nothing here —
every one of E10.4's three "tests" would have passed identically whether or not the
underlying rules worked at all, and two of the three rules didn't.

## Verified definition of done

```
pnpm install && pnpm run build && pnpm run test   # server: 108 green; ui: 31 green
pnpm run lint:deps                                # 0 violations both workspaces
```

## Next up

E11.4/E11.5 (skills dirs, FTS5 recall), E12 (release gate). OPEN_ISSUES #39 (budget
spend tracking from usage_delta) is worth bundling with whoever eventually builds F6's
budget_exhausted → task blocked → escalation response, which has the same root gap.
