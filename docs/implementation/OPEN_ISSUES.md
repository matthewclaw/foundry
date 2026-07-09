# Open Issues — raised during E1 (`@foundry/core`) implementation

Per the phase-0 work order: these are contract points where the architecture docs name a
concept or field but don't pin down its exact shape, or where a literal reading is
ambiguous. Each was resolved with a concrete, documented choice so E1 could ship without
blocking downstream lanes — flagging here for review rather than silent deviation.

---

## 1. `Budget` shape (05 `budget_json`, 02 Workstream/Task `budget`)

Doc 05's table lists `budget_json` as an opaque JSON column; doc 02 says "token/currency
cap … `spent` (projection)" without sub-fields.

**Chosen shape** (`packages/core/src/schemas/common.ts` `BudgetSchema`):
```ts
{ limit_usd: number | null, limit_tokens: number | null, spent_usd: number, spent_tokens: number }
```
Either axis may be uncapped (`null`); spend is always tracked on both axes regardless of
which axis is capped, so overrun is detectable even against a null limit (org daily cap
backstop, 07 F6). **Please confirm or amend before E2 writes the `budget_json` column
against this shape.**

## 2. `Usage` shape (05 `usage_json`, adapter-api `usage_delta`)

Not field-specified anywhere. **Chosen shape**: `{ tokens_in?, tokens_out?, cost_usd?,
duration_ms? }`, all optional since usage reporting is capability-dependent (ADR-003).

## 3. `RoutingSpec` shape (02 "team and/or role")

**Chosen shape**: `{ team_id?: TeamId | null, role?: string | null }`. Both optional, at
least one expected in practice but not enforced at the schema level (the *policy* layer,
not core, is where "team and/or role" combinations get validated against real teams/roles).

## 4. `DeliverableRef` shape (02 "completion message + artifacts")

**Chosen shape**: `{ message_id: MessageId, artifact_refs: Ref[] }`.

## 5. `Policy` shape (07 org→team→agent chain)

07 describes budgets, depth caps, comms permissions, and approval-kind gating
conceptually; no doc gives an exact field list for a policy node. **Chosen shape**
(`PolicySchema`, all fields optional so a node overrides only what it wants):
`budget`, `max_depth`, `max_rejections`, `thread_round_cap`, `question_expiry_hours`,
`tool_allowlist`, `permission_mode`, `can_redirect_actor_ids`,
`requires_human_acceptance`, `search_history_scope`. Defaults captured in
`DEFAULT_POLICY` match the numbers stated in prose (max_depth 3, max_rejections 2,
thread_round_cap 4, question_expiry_hours 48) — the *merge* semantics (org → team →
agent, later wins per-field) are E6's to implement against this shape.

## 6. Workstream state-machine edges (02 `open → active ↔ waiting → blocked → review → closed → archived`)

That notation is a state *list* with one bidirectional pair called out, not a literal
edge list. Implemented graph (`state-machines/transitions.ts`):

- `open → active`
- `active ↔ waiting`
- `blocked` reachable from both `active` and `waiting` (either running state can discover
  a blocker); `blocked → active` to unblock
- `active ↔ review` (review can bounce back to active when a delegator rejects delivered
  work, per 04's task rejection flow)
- `close` reachable from every non-terminal state (`open`, `active`, `waiting`,
  `blocked`, `review`) — the API contract's `POST /workstreams/:id/close` carries no
  state precondition
- `closed → archived` only

Flagging for the store/server teams that will consume `canTransition("workstream", …)` —
if the intended graph is stricter (e.g., no `waiting → blocked` direct edge), the table
is a single edit away.

## 7. Task rejection loop and escalation (04, 07 F12)

`rejected → in_progress` reuses the `task_started` event type (same semantic: "assignee
resumes work") rather than a new `task_reattempted` type. The `max_rejections` cap and
its auto-escalation are modeled as a **message-level side effect** (an `escalation`
message fires), not a further task-state transition — the task itself stays `rejected`
until the human/delegator acts. If a distinct terminal-ish task state is wanted for
"rejected and escalated," that's a new state + ADR-worthy discussion, not a schema tweak.

## 8. `canTransitionDisposition` needs message type, beyond the literal `canTransition(entity, from, to)` signature

Contracts.md lists "message-disposition" as one of the four/five things `canTransition`
covers, with the same two-argument-plus-entity signature as agent/workstream/run/task.
But disposition semantics are per-message-**type** (a `question`'s disposition set is
`open/answered/withdrawn/expired`; an `escalation`'s is `open/resolved`) — a single
`canTransition("message_disposition", from, to)` can't express that without conflating
every type's closed set. **Resolution**: kept `canTransition` exactly as specified for
the four state-holding entities, and added a sibling `canTransitionDisposition(messageType,
from, to)` for the fifth. Please confirm this reading — the alternative is a `canTransition`
overload that takes an extra context argument for `message_disposition` only, which felt
more surprising to call.

## 9. Approval `kind` is an open string, not a closed enum

Neither doc 02/04/07 nor contracts.md enumerate approval kinds — `request_approval`'s
example (`budget_increase`) is illustrative prose, not a closed set. Left as
`z.string().min(1)` pending E6, where real kinds (budget raise, deploy-to-main,
whatever policy.requires_human_acceptance names) will emerge from the policy engine.

## 10. `list_org` org-tool output is a minimal summary, not the store's `OrgView` projection

Contracts.md is explicit that "purpose-built projections live [in `@foundry/store`] …
so there is exactly one definition of, e.g., 'agent status'" (ADR-008) — core sits below
store and must not pre-empt that projection. `list_org`'s output here is deliberately
thin (team id/name; agent id/name/role/team/state) — enough for an agent to look up a
teammate, not the rich navigation view (roll-ups, burn, relationships) the UI renders.
Not a contradiction, just flagging so E5/E6 don't expect this shape to grow into the
UI's org view — it shouldn't; `orgView()` in store is the real one.

## 11. Event catalogue size: ~51 types shipped vs. the roadmap's "~40" estimate

Includes `agent_created` / `workstream_created` / `task_created` (recording the moment
an entity is created, before any state-machine transition applies) and three `run_*`
types for adapter-level detail explicitly named in doc 05/adapter-api but not part of the
run state machine itself: `run_usage_updated`, `run_tool_call`, `run_output_delta`. All
additive-only from here per ADR/contracts — flagging the count only so nobody's surprised
it's not exactly 40; nothing here contradicts a doc.
