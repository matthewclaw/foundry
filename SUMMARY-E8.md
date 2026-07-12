# Phase 2 — Delegation + communication (Epic E8, complete)

Built on `phase-2/org-tools`, across three lanes: E8.1 built directly; E8.2+E8.4+E8.5
and E8.3+E8.6 each Haiku-built in an isolated worktree, then reviewed and merged. 104
server tests green (373 across the workspace), dependency lint clean.

## What's here

- **E8.1** Delegation end-to-end (`routes/orgtools.ts`, `tasks/decide.ts`,
  `routes/tasks.ts`): `delegate_task` now spawns the assignee's workstream
  (`origin=task:<id>`), enqueues a `task_assigned` run, and eagerly transitions the task
  to `in_progress` — the full doc-04 flow diagram, not just a bare `Task` row.
  `deliver_task` re-triggers the delegator's workstream (or surfaces to the human inbox
  when the delegator has nothing to re-trigger). New `accept_task`/`reject_task`
  org-tools (OPEN_ISSUES #35 — contracts.md's frozen toolset never had a tool-facing way
  for an *agent* delegator to decide on its own subordinate's work) plus the human-facing
  `POST /api/tasks/:id/{accept,reject}` route, both calling one shared `decide.ts` so the
  two paths can't drift. F12's rejection cap (`checkRejection`, built in E6.3, never
  wired to anything) is wired for real: under the cap, the task returns to the assignee;
  at the cap, it escalates to the human and stays `rejected`.
- **E8.2** Budget conservation + depth cap property test (`policy/policy.test.ts`):
  30 random delegation trees (branching factor 1–4, depth up to the cap), only
  materializing a task when `checkDelegation` passes, asserting the invariant holds at
  every node across every tree — Σ children's budget ≤ parent's, on both axes, and no
  task ever exceeds `max_depth`.
- **E8.3** Question expiry sweep (`sweep/expireMessages.ts`): a pure, directly-testable
  sweep (fixed `now` injected, no real-clock waiting in tests) finds `open` questions
  past the asker's resolved `question_expiry_hours`, transitions them to `expired`, and
  surfaces an escalation on the question's own thread. Wired to a `setInterval` in
  `createServer` (default 1h, `unref()`'d and cleared on `stop()` so it never keeps a
  test process alive).
- **E8.4** Thread round caps (`routes/orgtools.ts`'s `send_message`): agent-to-agent
  threads (never human-agent) refuse the send once `round_count` hits
  `policy.thread_round_cap` (default 4), firing exactly one surfaced escalation per
  cap-trip (checked via existing-open-escalation, not re-fired on every subsequent
  attempt) — F5's anti-token-burn circuit breaker.
- **E8.5** Routing failure surfacing (`routes/orgtools.ts`'s `delegate_task`): a
  `routing_failed` result still returns to the calling run (unchanged), but now also
  fires a surfaced escalation to the human with the failed routing spec — F11.
- **E8.6** Cancellation cascade (`tasks/decide.ts`'s `cancelTaskCascade`, new
  `cancel_task` org-tool, `POST /api/tasks/:id/cancel`): walks the whole subtree via
  `parent_task_id`, transitions every non-terminal task to `cancelled`, cancels any live
  run and closes the workstream for each, releases workspaces, and notifies every
  affected assignee. **Handover (re-parenting) is explicitly not built** — deliberately
  scoped out (see below), not silently dropped.

## Delegated to Haiku — and what review caught

**Batch 1 (E8.2/E8.4/E8.5)** was clean on review beyond one nit: `delegate_task`'s new
E8.5 routing pre-check calls `resolveRouting` before `checkDelegation` (which calls it
again internally) and once more in the assignee-resolution block on the success path —
up to three redundant, side-effect-free calls per delegation. Left as a "simplify
later" note, not a correctness bug (the function is deterministic and nothing mutates
state between calls within one request).

**Batch 2 (E8.3/E8.6) hit the session's API rate limit mid-build** and was resumed by
hand rather than re-dispatched. Finishing it surfaced real bugs, one of them pre-existing:

1. **Build-breaking naming collision**: `expireMessages.ts`'s server-side wrapper was
   named identically to the store's pure sweep function it imported, so the "import"
   silently resolved to the wrapper's own local (differently-shaped) declaration —
   a `tsc` error, not a subtle one, but exactly the kind of half-finished-rename state
   an interrupted session leaves behind.
2. **Wrong thread anchor for expiry escalations**: the sweep posted its escalation to
   `getOrCreateThread("task", expiredMessage.id)` — a brand-new thread keyed by the
   *message's own id* (never matching anything, since no other code anchors by message
   id) — instead of the question's actual thread. Every real expiry would have created
   an orphaned, disconnected thread. Fixed to post directly on `expiredMsg.thread_id`.
3. **A genuinely pre-existing store bug this batch's tests were the first to exercise**:
   `resolveMessageDisposition` unconditionally built a `{disposition, disposition_ref}`
   event payload regardless of which disposition-transition event fired — but the
   catalogue's `message_expired` payload schema is empty. Nothing before this session
   ever drove a message to `expired`, so this was latent since whenever
   `resolveMessageDisposition` was written. Fixed to shape the payload per event type.
4. **Task/run state-machine conflation**: `cancelTaskCascade` reused
   `terminalStates("task")` to decide which of a workstream's *runs* were already
   terminal before cancelling them. Task and run are different state machines (task's
   terminal states are `done`/`cancelled`; run's are
   `completed`/`failed`/`cancelled`/`interrupted`) — the reused set would have tried to
   `cancelRun()` on every already-completed or already-failed run, not just live ones.
   Fixed to resolve `terminalStates("run")` separately.
5. **Missing `await`**: `cancelTaskCascade` called `runtime.cancelRun()` (a `Promise`)
   fire-and-forget, in a non-`async` function — unlike every other call site in this
   codebase (`routes/workstreams.ts` awaits it). Made the function and its two call
   sites (`cancel_task` org-tool, `POST /api/tasks/:id/cancel`) properly `async`.
6. Two test bugs found while getting the suite green: a manual `transitionTaskState({to:
   "done"})` in a test's setup path omitted the required `acceptedBy` field; a cascade
   test minted a child agent's token against a synthetic run id instead of the real run
   `delegate_task` had spawned for it, so the child's own further delegation landed as
   an unrelated root task rather than a child of the task being cancelled — the cascade
   logic was actually correct, the test just couldn't observe it.

Lesson reconfirmed, now across every delegated batch this session (E6.2/E6.3, E10.1/E10.3,
E8.2/E8.4/E8.5, E8.3/E8.6): green tests are a start, not a stopping point — and an
interrupted agent's partial work needs the same line-by-line scrutiny as a completed one,
sometimes more (the naming collision and missing-await were exactly the kind of thing a
mid-refactor leaves behind).

## Deliberately not built

- **Handover** (task re-parenting with a structured summary) — no doc gives an exact
  command shape or trigger condition, and no `handover` command/route existed anywhere
  before this epic (only the message *type* in the schema). The brief explicitly
  prioritized a solid, tested `cancelTaskCascade` over a rushed handover; still open.
- **`POST /api/tasks`** (human-initiated root delegation) — E8.1's AC is entirely the
  agent-to-agent flow; a human delegating a root task directly through the API (rather
  than via an agent's `delegate_task` call) is deliberately deferred (OPEN_ISSUES #37).

## Verified definition of done

```
pnpm install && pnpm run build && pnpm run test   # 373 green (server: 104)
pnpm run lint:deps                                # 0 violations (302 modules, 1102 deps)
```

## Next up

E10.2/E10.4 (delegation tree view — now buildable against real E8.1 data; anomaly rules
→ inbox), E11.4/E11.5 (skills dirs, FTS5 recall), E12 (release gate). E9.4 is
partially scoped (see OPEN_ISSUES #38) but blocked on a real captured `claude` CLI
permission-prompt fixture that can't be fabricated responsibly in this environment.
