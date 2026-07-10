# Open Issues — raised during E1 (`@foundry/core`) implementation

Per the phase-0 work order: these are contract points where the architecture docs name a
concept or field but don't pin down its exact shape, or where a literal reading is
ambiguous. Each was resolved with a concrete, documented choice so E1 could ship without
blocking downstream lanes — flagging here for review rather than silent deviation.

> **Architect review, 2026-07-09: all 11 resolutions APPROVED as the binding reading.**
> Per contracts.md, the Zod schemas in `@foundry/core` are now the single source of truth
> for these shapes (Budget, Usage, RoutingSpec, DeliverableRef, Policy); the architecture
> docs describe them, core defines them. Notes on three items:
> - **#6 (workstream edges):** the implemented graph is the intended one — `waiting → blocked`
>   is valid (a waiting workstream's blocker can be discovered), and close-from-any-non-terminal
>   matches the API contract.
> - **#7 (rejection escalation):** correct — escalation is a message-level side effect;
>   do NOT add a task state for it.
> - **#8 (`canTransitionDisposition`):** the sibling function is the right call; an
>   overloaded `canTransition` would be the surprising API. E2+ consumers build against
>   both as shipped.

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

---

# Open Issues — raised during E3 (`@foundry/adapter-api`, `@foundry/adapter-fake`) implementation

Same posture as above: each is a place contracts.md names a concept without pinning its
exact shape, or a genuine gap between the frozen `@foundry/core` and what contracts.md's
prose says core exports. Resolved with a concrete choice so E3 could ship; flagging for
architect review rather than silent deviation. `@foundry/core` is frozen (E1 merged) — none
of these touch it.

## 12. `RunHandle` shape

contracts.md gives `start`/`resume` a `Promise<RunHandle>` return type and `cancel`/`events`
a `RunHandle` parameter, but never shapes the type itself (unlike `RunSpec` and
`EngineEvent`, which are given literal TS). **Chosen shape**
(`packages/adapter-api/src/types.ts`): `{ readonly runId: RunId; readonly adapterId: string }`
— the minimum the runtime needs to correlate a handle back to its run and its owning
adapter. Adapters may return a concrete object with extra fields for their own internal
bookkeeping (structural typing allows it; nothing outside the adapter should depend on
more than the two declared fields). Please confirm before E9 (claude-code adapter) builds
against this shape, or amend it — it's a one-file change.

## 13. `describeAdapterContract(makeAdapter)` signature

contracts.md names this export and its coverage in prose ("lifecycle, cancel semantics,
event ordering, exactly-one `run_ended`, capability honesty") but — unlike `RunSpec`/
`EngineEvent` — gives no literal signature for `makeAdapter`. A generic suite can't script
adapter-specific behaviour (crash, hang, "exercise your declared capabilities") through
`RunSpec.engineConfig` alone, since that field is opaque and adapter-validated by design.

**Chosen shape** (`packages/adapter-api/src/conformance.ts`):
```ts
type ConformanceBehavior = {
  outcome: "completed" | "needs_input" | "failed" | "cancelled";
  exerciseDeclaredCapabilities?: boolean;
  neverEnds?: boolean;
};
type ConformanceAdapterFactory = (behavior: ConformanceBehavior) => ExecutionAdapter | Promise<ExecutionAdapter>;
function describeAdapterContract(makeAdapter: ConformanceAdapterFactory): void;
```
The adapter package under test owns the translation from an abstract behavior request to
its own engine reality: `@foundry/adapter-fake` synthesises a scenario inline per
behavior; a fixture-backed adapter (E9) would map each behavior to a specific recorded
fixture (contracts.md's testing-strategy table already anticipates this split: "fake
adapter runs it live; claude-code runs it against recorded stream fixtures"). Flagging for
E9 to confirm this is workable against real recorded fixtures before it calcifies —
the alternative is a suite that drives every adapter through one fixed, content-agnostic
`RunSpec` and can only assert on timing/cancellation, not on capability exercise.

## 14. `EngineEventSchema` ownership: `@foundry/core` vs. `@foundry/adapter-api`

contracts.md's `@foundry/core` section prose lists `EngineEventSchema` among core's
exports ("all Zod schemas (`EventSchema`, `MessageSchema`, `TaskSpecSchema`,
`EngineEventSchema`, org-tool input/output schemas, API DTOs)"), but core is frozen (E1
merged to main) and does not define it — E1's own `SUMMARY.md` lists `adapter-api` as
explicitly out of scope. contracts.md's dedicated `@foundry/adapter-api` section then
defines `EngineEvent` as a plain literal TS union with no cross-reference back to core.
**Resolution**: `@foundry/adapter-api` owns `EngineEventSchema` (Zod schema + inferred
type), consistent with the repo-structure comment "L1: AdapterContract types + conformance
test suite" and with the dependency-cruiser rule (adapter-api depends only on core, and
nothing below adapter-api needs to validate engine events). The one field with a natural
core equivalent — `run_ended.outcome` — reuses `RunResultSchema.shape.outcome` verbatim
rather than redefining the four-value enum, per contracts.md's "reuse core's value
objects" instruction. Please confirm this reading; the alternative is amending frozen core
to add `EngineEventSchema`, which contradicts core being frozen for this phase.

## 15. `stream_events` and `mcp` capabilities have no dedicated `EngineEvent` type

ADR-003/contracts.md's capability-honesty rule ("declared capabilities must be exercised,
undeclared must never emit") maps cleanly onto four capabilities with a 1:1 `EngineEvent`
type (`tool_events` → `tool_call`, `usage` → `usage_delta`, `reasoning_summaries` →
`reasoning_summary`, `permission_hooks` → `permission_request`) plus `resume`, which is
tested via method presence rather than an event type. `stream_events` (granularity/liveness
of the timeline) and `mcp` (org-tools transport) have no corresponding event type to gate
on — 03-system-architecture.md even says `output_delta` is part of the *mandatory* core
event set ("minimally: started, output(text), ended(result)"), so `stream_events` can't be
about output_delta's mere presence. **Resolution**: the conformance suite's
capability-honesty checks cover the four mapped capabilities plus `resume`; `stream_events`
and `mcp` are exercised structurally (their boolean is present in `CapabilitySet`) but not
event-gated. Flagging so UI/telemetry (E7, ADR-003 "visible degradation") don't expect the
conformance suite to have verified `stream_events`/`mcp` behaviour beyond the flag existing.

## 16. Fake adapter "calling org-tools" (E3.3) — simulated, not a live HTTP call

The E3 work order and ADR-010 describe the fake adapter as able to "call org-tools via the
RunSpec-provided connection." No org-tools server exists yet (E5/E6 are later, dependent
epics — `packages/server` is unstubbed), so a literal HTTP round-trip isn't buildable
within E3's dependency graph (`adapter-fake` depends only on `adapter-api` + `core`).
**Resolution**: the fake adapter represents an org-tool call as a normalized `tool_call`
`EngineEvent` (`name` = the org-tool name, e.g. `"delegate_task"`; `detail` = a payload
shaped like that tool's core input schema, e.g. `DelegateTaskInputSchema`) rather than
performing a real call. This is consistent with `tool_events` being exactly the capability
for "it edited these files, ran these commands" — an org-tool invocation is one more tool
call from the adapter's point of view. The real approve/deny or task-creation round-trip
through Foundry's control plane is runtime/server's concern (E6.4, E8.1), not testable at
the adapter layer in isolation. Flagging so E6/E9 don't expect the fake adapter's canned
scenarios to have exercised a live org-tools connection.

---

# Open Issues — raised during E2 (`@foundry/store`) implementation

Same posture as above: `@foundry/core`'s event catalogue and entity schemas are frozen: where
the store needed a shape or a write the catalogue doesn't cover, it's resolved with a
concrete, documented choice below rather than a silent deviation. None of these touch core.

## 17. No catalogue event for thread, team, or artifact creation

Three store mutation helpers write a new row with an **empty** `events` array in their
`mutate()` call — `getOrCreateThread`, `createTeam`, and `putArtifact`. Doc-05's write
discipline ("every state mutation appends its event(s) … a state change without an event
is a bug class") is honored everywhere else; these three are the exceptions because the
catalogue (frozen, E1) has no `thread_created`, `team_*`, or `artifact_*` prefix at all —
contracts.md's own description of teams ("labels with defaults, not containers with
behaviour") and of artifacts ("DB stores references and hashes") reads as intentional:
these rows are supporting metadata, not first-class organisational events. Each is still
auditable through what references it (`message_sent` carries `thread_id`; `task_delivered`
carries `deliverable_ref.artifact_refs`). If team/thread/artifact creation should be
independently visible in the event feed (not just via a referencing event), that's new
catalogue types, not a store-side fix.

## 18. Run-delta compaction emits no event

`events.compactRunDeltas(runId)` (E2.6) deletes compacted `run_output_delta` rows via a
`mutate()` call with an empty `events` array, after folding their text into the transcript
file. Doc-05 frames compaction as retention housekeeping on high-volume deltas, not a
domain state change ("the durable audit record is the transcript + run result, not every
40-byte delta") — so no catalogue event exists for "compaction happened," and none seemed
warranted. Flagging in case a future audit requirement wants compaction itself logged.

## 19. Over-committed status threshold has no specified value

Doc-02's status table says `over-committed` fires when "open workstreams/tasks [are]
above policy threshold" but names no number, and policy resolution (org→team→agent chain)
is E6's, not built yet. `deriveAgentStatus`/`computeAgentStatusFacts`
(`packages/store/src/projections/status.ts`) take `overCommittedThreshold` as a parameter
defaulting to `5`. This is a placeholder for E6 to thread its resolved
`policy.budget`-adjacent commitment cap through; the precedence logic itself doesn't
change shape when that number does.

## 20. Projection return shapes (`OrgView`, `AgentPage`, `Timeline`, `TreeView`, `InboxItem`, `CostReport`)

contracts.md's `Store` interface names these six return types but — unlike `Budget`/
`Usage`/`Policy`, which core defines — gives no field list; ADR-008 only says
projections (incl. "agent status") live in store, not their exact shapes. Store had to
choose concrete shapes for all six (each documented at its definition in
`packages/store/src/projections/`), notably: `OrgView` groups agents under teams with a
worst-of status roll-up; `AgentPage.relationships` is computed from tasks + messages,
weighted by interaction count; `Timeline` entries carry a `transcriptSource:
"live"|"file"|"none"` tag so the UI can render the E2.6 compaction fallback distinctly;
`InboxItem` covers only the two kinds store data already supports (pending approvals,
surfaced messages) — full severity/age ranking and other item kinds (routing failures,
anomalies) are E10's. Flagging for E7 (UI) to build against these as shipped, or request
amendments before they calcify into fixture snapshots.

## 21. Artifact `path` column is relative to `dataDir`, not absolute

Doc-05's `artifacts` table lists `path` with no statement of absolute-vs-relative, and
05's layout diagram is itself relative to `~/.foundry`. Store stores `path` relative to
`dataDir` (e.g. `artifacts/ab/ab34…`) and resolves it against `dataDir` on every read —
chosen so a `foundry backup`/restore cycle (E2.7) still resolves artifacts correctly even
if the restored `.foundry` directory ends up at a different absolute path than the
original (verified by a round-trip test that deletes the source directory before
verifying the restored copy). Flagging for E5/CLI: any code reading the `artifacts` table
directly (rather than through store's `readArtifact`) must join the row's `path` against
the store's configured `dataDir`, not treat it as a standalone absolute path.
