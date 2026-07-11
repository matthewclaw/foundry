# Phase 2 — Org-tools + policy engine (Epic E6, complete)

Built across `phase-2/org-tools` (E6.1, E6.4) and `phase-2/org-tools-swarm` (E6.2, E6.3,
Haiku-built, merged in after review + fixes). All four stories. 82 server tests green
(351 across the workspace), dependency lint clean.

## What's here

- **E6.1** Per-run scoped bearer tokens (`orgtools/tokens.ts`): minted at run start,
  attribute every call to `(agent, run, actor)`, dead the instant the run ends —
  expired/foreign/absent tokens are all a uniform 401 problem+json.
- **E6.2** The full org-tools toolset over three surfaces:
  - HTTP (`routes/orgtools.ts`, `POST /api/org-tools/:tool`): all ten tools —
    `list_org`, `get_task`, `get_thread` (policy-free reads, E6.1), `delegate_task`,
    `update_task`, `deliver_task`, `send_message`, `escalate`, `request_approval`,
    `search_history`. Every response is a `ToolResult` (`{ok:true,data}` /
    `{ok:false,error:{code,…}}`) — only transport/auth failures are real HTTP errors,
    per ADR-004.
  - CLI shim (`orgtools/shim.ts`): `argv = <tool> <json>` → HTTP → stdout, for adapters
    that shell out rather than speak MCP.
  - MCP — deliberately a documented stub (`orgtools/mcp.ts`); OPEN_ISSUES #33.
- **E6.3** Policy engine (`policy/policy.ts`): org → team → agent per-field overlay
  (`resolvePolicy`), deterministic routing by team/role with load tie-break
  (`resolveRouting`), delegation checks in fixed precedence order — AC → depth cap →
  budget conservation → assignee/routing (`checkDelegation`) — and the F12
  rejected-work cap (`checkRejection`, exported for E8).
- **E6.4** Approvals loop (`routes/approvals.ts`, built in a prior session): request →
  inbox item → `POST /api/approvals/:id/{grant,deny}` → grant re-triggers the waiting
  workstream with the decision in context; wired to the supervisor's
  `permission_request` handling (engine asks permission → approval item →
  `awaiting_approval` → grant resumes the run).
- **`store.search`** (`queries/search.ts`): the real `search_history` backing —
  parameterized `LIKE` over messages/workstreams/runs with a `filter` (actor/agent ids)
  the org-tool handler now actually calls (see review below). Ceiling comment names
  E11.5's FTS5 index as the upgrade.

## Delegated to Haiku — and what review caught

E6.2 (org-tool handlers, `store/queries/search.ts`, `orgtools/mcp.ts`, `orgtools/shim.ts`)
and E6.3 (policy engine) were Haiku-built in an isolated worktree
(`phase-2/org-tools-swarm`), left mid-session with one known build error and tests never
run. This session: fixed the build (missing `ThreadAnchorType` import; an `AgentId`
passed where `resolvePolicy` wants the full `Agent`), rebuilt better-sqlite3's native
binary for the worktree, merged the now-diverged `phase-2/org-tools` tip in (E6.4/E11.1–3
had landed on it after the swarm branched), got all three checks green — then read the
whole diff line by line per this session's standing rule. Four real, silent bugs:

1. **`delegate_task` never produced a real delegation tree.** It always passed
   `parentTask: null` into `checkDelegation` and always created tasks with
   `parent_task_id: null` — so F4 depth caps and budget conservation were never
   enforced, and every delegation landed as a root task regardless of who called it.
   The file already had an unused `callerParentTask()` helper (run → workstream → task)
   written for exactly this; it just wasn't wired in. This would have silently broken
   E8's entire dependency on task-tree structure. Fixed: resolve the caller's in-flight
   task and thread it through both the policy check and `createTask`. Regression test:
   a delegation from a task-bound run produces a child with the right `parent_task_id`
   and `depth`.
2. **`request_approval`'s payload never carried `workstream_id`.** `routes/approvals.ts`'s
   grant handler (E6.4, built in a prior session) reads `approval.payload.workstream_id`
   to know which run to re-trigger — the supervisor's own `permission_request` path
   writes exactly that shape. The org-tool handler didn't, so an agent-initiated
   `request_approval` created an approval that a human could grant with no visible
   effect: no error, just a run that never gets scheduled. Fixed by resolving the
   caller's workstream from `cred.runId` and merging `workstream_id`/`run_id` into the
   payload. Regression test asserts the payload shape after a real `request_approval`
   call.
3. **`search_history` reimplemented a worse, untested version of the query it shipped
   next to.** The batch added `store.search.text()` (parameterized SQL, escaped LIKE
   pattern, actor/agent-scoped filters, includes run results) and wired it into
   `store.ts` — but the org-tool handler ignored it, hand-rolling its own scan
   (`.includes()`, case-sensitive, no run-result search, no test coverage at all) that
   also returned hits shaped `{kind, id}` instead of the `Ref` string
   (`SearchHistoryHitSchema.ref`) the schema actually promises. Rewired the handler to
   call `store.search.text()`. While fixing this, found a second bug in the scope
   clamping: a teamless agent granted `"team"` scope fell through to an *unfiltered
   org-wide search* — because the fallback only checked one of the two filter axes
   (`agent_ids`), the other (`actor_ids`) stayed unset and leaked every agent's messages
   regardless of team. Fixed to scope both axes consistently (teamless + team scope =
   just yourself). Regression tests cover both the happy path (Ref-shaped hits, scope
   over policy limit refused) and the leak (teamless agent, team scope, unrelated
   agent's message must not appear).
4. **Dead weight, not a behavior bug:** `@modelcontextprotocol/sdk` was added to
   `package.json` but never imported (`mcp.ts` is a plain-object stub) — removed.
   The unused `callerThread()` helper (written for a code path `send_message`'s schema
   makes unreachable — `to_actor_id`/`to_team_id` is a hard XOR) was removed too.

Lesson reconfirmed (now every delegated batch across E4/E5/E6): green tests are a
starting point. This batch's own tests (policy.test.ts's 10 tests, orgtools.test.ts's
original 4) were legitimately thorough for what they covered — they just didn't cover
the actual tool handlers' wiring to the helpers/queries the same batch had already built
next to them.

## Verified definition of done

```
pnpm install && pnpm run build && pnpm run test   # 351 green (server: 82)
pnpm run lint:deps                                # 0 violations (291 modules, 1054 deps)
```

## Open issues raised

`docs/implementation/OPEN_ISSUES.md` #33 (MCP is a documented stub; HTTP + CLI shim are
the two live org-tools transports until E9.2) and #34 (`update_task`/`deliver_task`
don't check the caller is the task's assignee — any live run's token can touch any task
in the org; flagged for an architect call before E8.1 builds the accept/reject loop on
top of these handlers, since it's a real policy decision, not an oversight-shaped fix).

## Next up

E10.1/E10.3 (UI: inbox actions, cost route), then E8 (delegation + communication —
unblocked now that `delegate_task` actually produces a real tree), E9.4, E10.2/10.4,
E11.4/11.5, E12.
