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

---

# Open Issues — raised during E4 (`@foundry/runtime`, E4.1–E4.4) implementation

Same posture as above. `@foundry/core`, `@foundry/store`, and `@foundry/adapter-api` are
all frozen for this phase (E1/E2/E3 merged) — none of these touch them. E4.5 and E4.6 are
not built yet (see `SUMMARY-E4-partial.md`); several items below are exactly the gaps the
next session needs to close them.

## 22. `RunSpec` fields the supervisor can't yet resolve itself

`RunSupervisor.execute` builds the adapter's `RunSpec` (`agentName`, `workspaceDir`,
`orgTools`, `engineConfig`, `limits.wallClockMs`) entirely from caller-supplied fields on
`RunQueueJob` — it does not look up the agent's name from the store, does not call the
workspace manager (#26 below) for `workspaceDir`, and has no org-tools/policy source to
pull `orgTools`/`engineConfig` from. This is intentional for E4.1–E4.4 (those concerns —
context composition, policy, org-tools MCP — belong to E5.6/E6, which don't exist yet),
but means the supervisor is not yet callable with only a `workstreamId` + `trigger`
the way contracts.md's final `Runtime.enqueue({workstreamId, trigger})` signature implies.
Whoever builds the `Runtime` facade (assembling scheduler + supervisor + workspace manager
into the one contracts.md interface) needs to add this resolution step.

## 23. `reasoning_summary` `EngineEvent` has no catalogue event type

Same gap as #15, seen now from the consuming side: the run supervisor's `handleEvent`
recognizes `reasoning_summary` but silently drops it (no store write) since
`EVENT_CATALOGUE` (frozen, E1) has no `run_reasoning_summary` type. If reasoning
summaries should be persisted/visible in the timeline, that's a new additive-only
catalogue entry, not a runtime-side workaround.

## 24. `permission_request` `EngineEvent` unhandled in the run supervisor

Deliberately: mapping an engine's permission prompt to a Foundry approval item is E6.4's
job ("Permission hooks → Foundry approvals"), and no approvals-request flow exists yet in
runtime (only in store's `requestApproval`/`decideApproval` commands, unwired to runtime).
The supervisor currently just drops `permission_request` events. E6.4 needs to add a hook
here — likely the same `handleEvent` switch, calling into `store.commands.requestApproval`
and transitioning the run to `awaiting_approval`.

## 25. `awaiting_input`'s `workstream_waiting` transition passes `waitingOnRef: null`

Doc-02 says a `waiting` workstream's `waiting_on_ref` names *what* it's waiting on (a
message, approval, or dependency). At the point the run supervisor sees an `awaiting_input`
`EngineEvent`, no `Message` exists yet to reference — question delivery to a human/agent is
E8.3's job. Runtime always passes `null` here; E8.3 (or whichever story turns "the engine
asked a question" into an actual inbox-visible `Message`) should thread the real ref through.

## 26. Workspace manager (E4.4) is a standalone module, not wired into the run supervisor

`packages/runtime/src/workspace/manager.ts`'s `createWorkspaceManager` (`acquireGitWorktree`,
`acquireScratchDir`, `release`) satisfies E4.4's acceptance criterion on its own (isolated
worktrees; dirty worktree ⇒ refused + workstream `blocked`) but the run supervisor does not
call it — `RunSpec.workspaceDir` is still whatever the caller passes on `RunQueueJob`
(see #22). Wiring — acquire before `adapter.start()`, release after a terminal state, refuse
the run outright if acquisition fails — is a small follow-up integration task, deliberately
left for whoever builds the `Runtime` facade so it isn't done twice.

## 27. `.dependency-cruiser.cjs` test-only layering carve-out: `runtime` → `adapter-fake`

The original layer rule (`runtime: ["core", "store", "adapter-api"]`) blocked exactly what
contracts.md's testing-strategy table asks for: "Runtime … Integration tests: runtime +
store + fake adapter scenarios." Added a second rule generator (`TEST_ONLY_ALLOWED`) that
permits `packages/runtime/src/**/*.test.ts` (and only `*.test.ts` — production code is
still strictly layered) to import `@foundry/adapter-fake`. Flagging since it's a new kind
of rule (previous layer violations were unconditional) — if a future package needs the same
"test-only" exception, this is the pattern to extend, not a bespoke one-off.

## 28. E4.5 pid-sweep scope: adapter-agnostic registry now, literal pids from E9 on — and one additive `RunHandle` field

The F7 pid sweep had nothing real to track before E9 (the fake adapter spawns no OS
process), so `SUMMARY-E4-partial.md` flagged a scope question: wait for E9, or build
adapter-agnostic. **Resolution: built now.** The pid-file registry
(`packages/runtime/src/reconcile/reconcile.ts` `createPidRegistry`) and the startup sweep
are engine-independent — the sweep is tested today against a real spawned orphan node
process, no E9 needed. The run supervisor registers a pid only when the adapter's handle
carries one, which required one **additive** amendment to the #12 `RunHandle` shape:
`readonly pid?: number` (`packages/adapter-api/src/types.ts`). The fake adapter omits it
(registration becomes a no-op); E9's claude-code adapter should set it on the handles it
returns and gets orphan sweeping with zero further wiring. The catalogue's reserved
`system_orphan_process_killed` / `system_reconciled` types (E1.3) are now emitted.
Deliberate ceiling: the sweep kills by pid with no pid-reuse guard (fine for a local
single-user control plane; verify process start time if this ever multi-tenants).

---

# Open Issues — raised during E5 (`@foundry/server` + Runtime facade) implementation

## 29. `{run_id}` / `{agent_id}` tokens in `createRun.input_context_ref` / `createAgent.memory_ref`

Doc-05's layout (`runs/<run-id>/context.md`, `agents/<agent-id>/memory`) keys paths by
ids that only exist once the row is created, but both create-inputs demand the path up
front. Resolution: `createRun` substitutes a literal `{run_id}` token (and `createAgent`
an `{agent_id}` token) with the id it generates — additive, no existing caller breaks,
and the recorded refs now match the documented layout exactly. If a future audit wants
the pre-substitution template preserved, that's a new column, not a behaviour change.

## 30. Workspace release timing: on workstream close, not per-run

#26's literal wording ("release after a terminal state") conflicted with E4.4's
worktree-reuse design and doc-05's retention table ("Workspaces (worktrees): removed on
workstream archive"). The Runtime facade keeps a workstream's worktree/scratch dir alive
across runs and exposes `releaseWorkspace(workstreamId)`, which the close-workstream
route calls. Doc-05 wins over the issue-log phrasing.

## 31. No catalogue event for agent rename / role / team change ⇒ `PATCH /api/agents/:id` is charter+engine only

The frozen catalogue has `agent_charter_updated` and `agent_engine_rebound` but nothing
for name/role/team_id edits, and doc-05's write discipline forbids event-less mutations.
PATCH therefore accepts `charter_md` (new immutable charter version) and `engine`
(rebind, doc-01 success test #3) and rejects other fields with 422. Supporting renames
is one additive catalogue type (`agent_profile_updated`?) away — architect's call.

## 32. Single-human-actor assumption (`getOrCreateHumanActor`)

The API has no auth and doc-08 scopes v1 to a local single-user tool, but messages need
a `from_actor_id`. The store lazily creates one `kind='human'` actor row (no event —
same catalogue gap/precedent as threads/teams, #17) and every human-attributed API
command uses it. Multi-user is a server-mode concern; this is the seam where real
identity would plug in.

---

# Open Issues — raised during E6 (org-tools + policy engine) implementation

## 33. `createOrgToolsMcpServer` is a documented stub; HTTP + CLI shim are the two live org-tools transports

Contracts.md names an MCP surface for org-tools, but no `@modelcontextprotocol/sdk`
integration exists yet — `packages/server/src/orgtools/mcp.ts` returns a plain object
describing the toolset (names/descriptions derived from `ORG_TOOL_INPUT_SCHEMAS`) rather
than a wired MCP server, and carries no SDK dependency (one was added to
`packages/server/package.json` during E6.2 build-out but never imported anywhere —
removed as dead weight; add it back when this lands for real). Every tool is fully
functional through the HTTP surface (`POST /api/org-tools/:tool`, `routes/orgtools.ts`)
and the CLI shim (`orgtools/shim.ts`, argv → HTTP → stdout) — an adapter that can shell
out or make HTTP calls has full org-tools access today. E9.2 is where a real MCP server
gets built (or this stub gets deleted if the claude-code adapter's `--mcp-config`
injection works fine against the HTTP surface directly and MCP turns out to add nothing
here) — flagging so E9.2 doesn't assume more than a documented shape exists yet.

## 34. `update_task` / `deliver_task` don't check the caller is the task's assignee

Contracts.md's org-tool table (`update_task { task_id, note_md?, blocked? }`,
`deliver_task { task_id, summary_md, artifact_refs[] }`) gives each a bare `task_id`
with no stated authorization rule, and no doc spells out whether only the assignee may
progress a task. As shipped, any live run's token can call either on any task in the
org — the per-run credential attributes the resulting message/transition to the caller
(`cred.actorId`) correctly, but nothing rejects a caller who isn't `task.assignee_agent_id`'s
actor. `delegate_task` similarly lets any caller name any `assignee_agent_id` (not just
their own reports) — that one reads as intentional (a manager delegating to a named
specialist, not just to direct reports), but the update/deliver gap looks more like an
oversight than a decision. Cheap fix (one `cred.actorId !== assignee.actor_id` check
returning `policy_violation`) deferred rather than silently added, since it's a real
policy decision (does Foundry trust the local single-tenant tool with any live token
touching any task, matching #32's single-human-actor posture, or does it want per-agent
task isolation?) — flagging for architect confirmation before E8.1 builds the
deliver/accept/reject loop on top of these handlers.

---

# Open Issues — raised during E8 (delegation + communication) implementation

## 35. `accept_task` / `reject_task` added as new org-tools — not in contracts.md's original toolset

Doc-04's delegation flow is explicit that acceptance is *delegated*: "the human reviews
one deliverable at the root; agents review their own subordinates" — but contracts.md's
"Org-tools contract" table (the frozen agent-facing toolset) only ever listed
`delegate_task`/`update_task`/`deliver_task`/`send_message`/`escalate`/
`request_approval`/`search_history`/`get_task`/`get_thread`/`list_org`. There was no
tool-facing way for an *agent* delegator to accept or reject a subordinate's delivered
work — only the human-facing `POST /api/tasks/:id/{accept,reject}` HTTP route (whose
DTOs already existed in `packages/core/src/api/dto.ts`, unimplemented until E8.1) could
decide anything, which only covers the human-as-delegator case.

**Resolution**: added `accept_task { task_id }` and `reject_task { task_id, reason }`
to `ORG_TOOL_INPUT_SCHEMAS` (`packages/core/src/org-tools/schemas.ts`), additive per the
precedent set by every other post-E1-freeze amendment in this file (#12, #15, #28, #29–32).
Both org-tool handlers and the HTTP route call the same
`packages/server/src/tasks/decide.ts` logic (`acceptTask`/`rejectTask`) so the two
surfaces can't drift. Please confirm this reading — the alternative is that agent
delegators were never meant to decide autonomously at all (every sub-delegation's
acceptance bubbles up to a human somehow), which doc-04's own prose reads against.

## 36. Delegator-workstream resolution for the delivery re-trigger is a heuristic, not a stored reference

Doc-04: after `deliver_task`, "the delegator's next run gets the deliverable + AC in
context" — requiring the control plane to find *which* workstream to re-trigger. For a
sub-delegation (`task.parent_task_id` set) this is exact: the workstream whose
`task_id` equals the parent task's id. For a delegation from an agent's own top-level,
non-task-linked workstream (a human-triggered root workstream that itself calls
`delegate_task`), no field records which workstream the delegator was in when it
delegated — `Task` has no `delegator_workstream_id`. `resolveDelegatorWorkstream`
(`packages/server/src/routes/orgtools.ts`) falls back to that agent's newest
non-closed/non-archived workstream, which is correct for every scenario this system
currently drives an agent through (one active root workstream at a time) but would
pick the wrong one if an agent ever runs two concurrent root workstreams and delegates
from one while the other is also open. A `Task.delegator_workstream_id` column (or
resolving it once at `delegate_task` time and storing it on the child workstream/task)
would make this exact instead of heuristic — flagging as a follow-up if concurrent
root workstreams per agent becomes a real scenario, not urgent today.

## 37. `/api/tasks` (`POST`, create) and `/api/tasks/:id/cancel` remain unimplemented

`CreateTaskRequestSchema` and `CancelTaskRequestSchema` DTOs exist in
`packages/core/src/api/dto.ts`, and contracts.md's query list includes
`/api/tasks/:id/tree`, but E8.1 only wired the accept/reject half of the human-facing
task surface (`packages/server/src/routes/tasks.ts`) — the AC for E8.1 is delegate ->
spawn -> deliver -> accept/reject -> cap -> escalate, which doesn't require a human-
initiated root delegation route or cancellation. `POST /api/tasks` (a human delegating a
root task directly, rather than only via an agent's `delegate_task` org-tool call) and
cancellation (single-task and, per E8.6's AC, the full subtree cascade + run-stop +
notify) are deliberately left for whoever picks up E8.6 — building a non-cascading
cancel now would either need redoing for the cascade or ship a half-behavior that looks
more done than it is.

---

# Open Issues — raised while scoping E9.4 (permission hooks → Foundry approvals)

## 38. E9.4 is only half-buildable without a real captured fixture; `mintRunCredential` deliberately never sets `mcpConfig`

Two separate gaps, resolved differently:

- **`mcpConfig` decision (confidently resolved, no blocker):** `createServer`'s
  `mintRunCredential` (`packages/server/src/server.ts`) only ever returns `cliEnv`
  (`FOUNDRY_ORG_TOOLS_URL`/`_TOKEN`, the CLI shim's transport) — it never sets
  `mcpConfig`, even though `RunSpec.orgTools.mcpConfig` exists and the claude-code
  adapter (E9.2, on `phase-2/claude-code`) already injects it via `--mcp-config` when
  present. This is intentional, not an oversight: #33 already established that
  `createOrgToolsMcpServer` is a documented stub with no real
  `@modelcontextprotocol/sdk` wiring behind it — generating an `mcpConfig` that points
  at a non-functional endpoint would be actively worse than not generating one. The CLI
  shim is the one live, fully-functional org-tools transport today; every engine reaches
  org-tools through it regardless of declared `mcp` capability. Revisit once E9.2's real
  MCP server exists.
- **Permission-hook wiring (genuinely blocked, not resolved):** the runtime side already
  works — `packages/runtime/src/supervisor/supervisor.ts` maps a `permission_request`
  `EngineEvent` to a Foundry approval + `workstream_waiting` (E6.4), proven against the
  **fake** adapter's synthetic scenarios. `packages/adapter-claude-code` declares
  `permission_hooks: false` (`src/adapter.ts`) and its stream-json mapper
  (`src/stream.ts`) has no case for a permission-prompt message at all — building that
  mapping requires knowing the *real* `claude` CLI's wire shape for a permission
  request/response (which message `type`/`subtype`, what the control-response reply on
  stdin looks like), which is exactly the kind of detail this project's own fixtures are
  meant to be *recordings* of real CLI output, not invented data (see #13's "a
  fixture-backed adapter... would map each behavior to a specific recorded fixture").
  No such recording exists in this repo, and no live `claude` CLI is available in this
  environment to capture one. Fabricating a plausible-looking fixture here would risk
  exactly the failure mode this session's review discipline exists to catch: code that
  passes conformance against a self-authored fixture but silently doesn't match the real
  engine. **Left undone rather than guessed** — capability stays `false` until someone
  with a live `claude` CLI (E9.5's manual lane is the natural place) records one real
  permission-prompt transcript to build `stream.ts`'s mapping and a genuine fixture
  against.

---

# Open Issues — raised during E10.4 (anomaly rules) implementation

## 39. `usage_delta` never updates `workstream.budget.spent_usd`/`spent_tokens` (or task's) — a pre-existing gap affecting E8.2, E10.3, and E10.4

Discovered while reviewing E10.4's budget-% anomaly rule: nothing anywhere in
`packages/runtime/src/supervisor/supervisor.ts` folds a run's `usage_delta` events into
the *workstream's* (or task's) persisted `Budget.spent_usd`/`spent_tokens`. `usage_delta`
only ever produces a `run_usage_updated` **detail** event (audit trail on the run) —
the `workstreams`/`tasks` tables' `budget_json.spent_*` fields are set once at creation
and never incremented by anything. This means:

- **E10.3's cost view** (`costRollup` projection, shipped this session) sums
  `workstreams.budget_json` directly — it has been reporting whatever spend a workstream
  was *created* with, never what its runs actually spent, since it shipped.
- **E8.2's budget-conservation check** (`checkDelegation`, also this session) only ever
  compares `limit_*` fields against sibling *limits*, never against actual `spent_*` —
  so this one was unaffected by the gap (it doesn't read `spent_*` at all), but it means
  "spent" and "limit" have quietly never been the same kind of number in practice: limits
  are enforced structurally at delegation time, spend is never actually tracked against
  them afterward.
- **E10.4's budget-% rule** (this story) can only fire from a workstream whose
  `budget_json` was directly database-edited to already be near the threshold — it can
  never organically trigger from a real run's usage, because nothing ever writes real
  usage into that field. The rule's *logic* is tested and correct (see
  `packages/server/src/server.test.ts`, which drives it via direct store manipulation and
  documents this gap inline); it just has no real data to react to yet.

**Not fixed here** — it's a genuine feature (wiring `usage_delta` accumulation through to
persisted workstream/task budget, likely a new store mutation + a call from the
supervisor's event-handling switch, `packages/runtime/src/supervisor/supervisor.ts`'s
`case "usage_delta":`) well outside E10.4's "anomaly rules → inbox" scope, and touches
runtime + store together. Flagging for whoever picks this up next — likely bundled with
whatever revisits F6 (budget_exhausted → task `blocked` → escalation, also not built:
the *global* per-run `budgetCaps` watchdog cutoff in `supervisor.ts` exists and cuts a
run off, but doesn't transition the task to `blocked(budget_exhausted)` or escalate,
per doc-07's stated response for F6).
