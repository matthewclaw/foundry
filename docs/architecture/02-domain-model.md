# 02 — Core Concepts, Domain Model, Agent Lifecycle, Organisation Model

## Core Concepts

Eight nouns. Everything in ADE is one of these or a projection of them.

| Concept | One-liner | Lifetime |
|---|---|---|
| **Actor** | Anything that can act: a human or an agent. One identity model for both. | Permanent |
| **Agent** | A persistent specialist: identity + charter + memory + engine binding + history. | Months–years |
| **Workstream** | One thread of intent owned by an agent ("Authentication Refactor", "Bug #482"). What the charter calls a conversation. | Days–months |
| **Run** | One engine invocation inside a workstream. Ephemeral, resumable, the only thing that costs money. | Minutes–hours |
| **Task** | A unit of delegated work: spec, delegator, assignee, acceptance criteria, budget, status. Tasks form the delegation tree. | Days–weeks |
| **Message** | A typed communication between actors, attached to a thread. Never free-form chat. | Permanent (archived) |
| **Event** | An append-only record of one state change. The observability substrate. | Permanent (compactable) |
| **Workspace** | A working directory (usually a git worktree) a run executes in. | Per-workstream |

Supporting nouns: **Team** (a label over agents with policy defaults), **Artifact** (a file/diff/document a run produces, stored by reference), **Policy** (limits and permissions attached to org/team/agent), **Approval** (a pending human decision).

### The relationships

```
Organisation
 ├─ Team (label + policy defaults)
 │   └─ Agent ──────────────┐
 │       ├─ Memory (files)  │ owns
 │       ├─ Workstream ◄────┘
 │       │   ├─ Run (ephemeral, N per workstream, serialized)
 │       │   └─ Message thread(s)
 │       └─ status (derived, never stored as truth)
 │
 ├─ Task  (delegator actor → assignee agent; parent_task ⇒ delegation TREE)
 │   └─ executes as a Workstream on the assignee's side (1:1 link)
 │
 ├─ Message (from actor, to actor, type, thread, disposition)
 └─ Event  (append-only; everything above emits them)
```

Two structures deliberately kept distinct (charter challenge C2):

- **Static org**: Organisation → Teams → Agents. Navigation and policy defaults. Shallow, changes rarely.
- **Dynamic delegation tree**: the `parent_task` graph. Exists per piece of work, fully reconstructable from task rows/events, dissolves when work completes.

---

## Domain Model

Field lists are contracts; exact column types live in [05-data-and-persistence.md](05-data-and-persistence.md).

### Actor

Unifies humans and agents so that delegation, messages, approvals, and audit have one shape.

- `id`, `kind` (`human` | `agent`), `display_name`
- Humans additionally: auth identity (v1: the single local user)
- Agents additionally: 1:1 with an Agent record

### Agent

- `id`, `actor_id`
- `name` ("Orbit Backend Engineer"), `role` (short label), `avatar/color`
- `charter` — markdown: purpose, expertise, standing instructions, boundaries. Versioned (edits emit events; prior versions retained).
- `team_id` (nullable)
- `engine` — adapter id (`claude-code`) + engine-specific config (model, permission mode)
- `memory_ref` — path to the agent's memory directory
- `default_workspace_ref` — repo/directory it usually works in (nullable; workstreams can override)
- `policy_overrides` — budgets, tool permissions, communication permissions (see 07)
- `state` — lifecycle state (below)
- `created_at`, `retired_at`

**Not stored on the agent**: status (derived), current work (query workstreams), relationships (query tasks/messages), health (derived). Storing derivable facts creates the staleness bugs the charter's observability principle exists to prevent.

### Workstream

- `id`, `agent_id` (owner — exactly one), `title`, `goal` (markdown)
- `origin` — what created it: `human` | `task:<id>` | `schedule:<id>`
- `task_id` — if this workstream exists to execute a delegated task (1:1)
- `workspace_ref` — directory/worktree this workstream's runs execute in
- `state`: `open → active ↔ waiting → blocked → review → closed → archived`
- `budget` — token/currency cap (inherited from task or set by creator), `spent` (projection)
- `engine_session_ref` — opaque engine session id enabling resume (adapter-owned meaning)

State semantics:

| State | Meaning |
|---|---|
| `open` | Exists, no run scheduled |
| `active` | A run is executing or queued |
| `waiting` | Next run is blocked on an answer/approval/dependency — *who/what* it waits on is in the pending message/approval |
| `blocked` | Explicitly marked blocked with a reason (escalation usually pending) |
| `review` | Work delivered, awaiting acceptance (by delegator or human) |
| `closed` | Done; retained |
| `archived` | Retention-policy cold storage; never deleted (charter challenge C8) |

### Run

- `id`, `workstream_id`, `seq` (runs are serialized per workstream — see Runtime, doc 03)
- `trigger`: `human_message` | `agent_message` | `task_assigned` | `schedule` | `resume` | `approval_granted`
- `input_context_ref` — exactly what was composed into the engine (audit: "what did it know")
- `engine`, `engine_session_id`
- `state`: `queued → starting → running → (awaiting_input | awaiting_approval) → completed | failed | interrupted | cancelled`
- `result` — terminal summary: outcome (`completed`/`needs_input`/`failed`), final text, artifact refs
- `usage` — tokens in/out, cost, duration (as reported; capability-dependent)
- Stream of run events (tool calls, output chunks, reasoning summaries) → event log, not columns.

`interrupted` (process died, crash, control-plane restart) is distinct from `cancelled` (an actor stopped it) and from `failed` (engine reported failure). Interrupted runs are resumable when the engine supports sessions.

### Task

The delegation unit and the edge of the delegation tree.

- `id`, `parent_task_id` (nullable ⇒ tree), `root_task_id` (denormalised for cheap tree queries)
- `delegator_actor_id`, `assignee_agent_id` (resolved; may have been routed — original routing spec kept for audit)
- `spec` — goal (markdown), context refs (files, workstreams, artifacts), **acceptance criteria** (explicit, checkable), constraints
- `budget` — carved from the parent task's remaining budget (children can never exceed the parent; see 04)
- `depth` — delegation depth (policy-capped)
- `state`: `pending → in_progress → blocked ↔ in_progress → delivered → done | rejected`, plus `cancelled` from any non-terminal state
- `deliverable_ref` — completion message + artifacts
- `accepted_by`, `accepted_at` — who signed off (delegator by default; human for roots or per policy)

A `rejected` task returns to the assignee with the rejection message in context — same task, new attempt, bounded by policy (`max_rejections`, default 2, then it escalates).

### Message

- `id`, `thread_id`, `from_actor_id`, `to_actor_id` (or `to_team_id` for routed messages)
- `type` — closed set, see doc 04: `question | answer | review_request | review | proposal | status | discovery | escalation | handover | completion | redirect`
- `body` (markdown), `refs` (tasks/workstreams/artifacts/events)
- `disposition` — what the type demands and whether it's satisfied (e.g. a `question` is `open` until an `answer` links to it, or it's `withdrawn`/`expired`)
- `visibility` — `normal` (human can see) | `surfaced` (pushed to human inbox). There is **no** human-invisible tier.

### Event

- `id` (monotonic), `ts`, `actor_id` (who caused it), `entity_type` + `entity_id`, `type`, `payload` (JSON), `run_id`/`workstream_id`/`task_id` correlation keys (nullable)
- Append-only. Written in the same transaction as the state change it describes.
- The event **type catalogue** is a versioned contract (implementation/contracts.md) — the UI, telemetry, and future integrations all consume it.

### Workspace

- A directory a run executes in. For code work: a git worktree per workstream off the target repo, so parallel workstreams never collide and diffs are inspectable per-workstream.
- `workspace_ref` = `{repo_path, worktree_path, branch}` or a plain directory for non-code work.

---

## Agent Lifecycle

```
        create
draft ─────────► active ◄──────► suspended
                   │    suspend/resume
                   │ retire
                   ▼
                retired
```

| State | Meaning | Rules |
|---|---|---|
| `draft` | Being configured; charter incomplete | Cannot receive work |
| `active` | Normal | Full participation per policy |
| `suspended` | Deliberately paused (misbehaving, under revision, seasonal) | Open workstreams freeze (`waiting`); inbound tasks are refused back to the router; nothing is lost |
| `retired` | Permanently decommissioned | Record, memory, and history retained forever; open work must be handed over (`handover` messages) or cancelled first — retirement is blocked while open tasks exist |

**Birth.** An agent is created by a human (v1) with name, role, charter, team, engine, policies. Creation is cheap and reversible — this matters culturally: specialists should be spun up the way you'd open a new Linear team, not the way you'd hire.

**Life.** The agent accumulates: closed workstreams, delivered tasks, given/received reviews, memory files. Its charter is versioned and human-editable at any time ("mentoring" in charter terms is literally editing the charter and memory, and the diff is an event).

**Identity across engines.** `engine` is a binding, not an identity. Rebinding emits an event and nothing else changes. Open workstreams with engine-session state complete on the old engine or restart contextually on the new one (context is recomposed from ADE state — this is why input context lives in ADE, not only inside the engine's session).

**Death.** Never deletion. `retired` agents disappear from active views but remain queryable; their work history remains attributed. (Auditability, and also the honest answer to "who wrote this?" a year later.)

### Status (derived, real-time)

Computed from live state, never stored as truth (charter challenge C4):

| Status | Derivation |
|---|---|
| `active` | ≥1 run in `running`/`starting` |
| `waiting` | No active run; ≥1 workstream `waiting` (on approval, answer, or dependency — the *what* is attached) |
| `blocked` | ≥1 workstream/task `blocked` |
| `idle` | Active agent, no open runs, nothing pending |
| `degraded` | Recent run failure rate above threshold (e.g. ≥2 consecutive failures) |
| `over-committed` | Open workstreams/tasks above policy threshold — a routing signal, not an alarm |

Precedence for the single at-a-glance badge: `blocked > degraded > waiting > active > over-committed > idle`. Every badge is clickable through to the events that produced it.

---

## Organisation Model

### Teams are labels with defaults, not containers with behaviour

A Team carries: `name`, `description`, `default_policies` (budgets, permission mode, communication rules), and membership. That is all. No team-level queues, no team inboxes, no team state machines in v1 — every behaviour the brief attributes to teams is achievable with agent-level primitives plus grouping, and team-level machinery is speculative until proven needed.

What teams *do* provide:

1. **Navigation** — the org view groups by team; roll-up status per team (worst-of members).
2. **Policy defaults** — org → team → agent override chain (see 07).
3. **Routing scope** — a task can be addressed to a team; the router resolves it to a member.

### Routing

`delegate_task` accepts either a named agent or a routing spec (`team` and/or `role`). V1 routing is deliberately dumb and predictable: match team/role → prefer `idle` over `waiting` over `active` → prefer fewest open tasks → tie-break alphabetically. Deterministic, explainable in one sentence, and recorded (the task keeps both the routing spec and the resolution). Smart routing (skill matching, embeddings, load prediction) is a labelled future upgrade — predictability builds trust first.

If no eligible agent exists, the task lands in the human inbox as a routing failure with one-click options: assign manually, or create a new specialist from the task spec.

### The human in the org

The human is an Actor like any other — appears in delegation trees as a delegator, receives `review_request`s, sends `redirect`s. This is not decoration: it means the audit trail has one shape ("who approved this?" is answered the same way regardless of who), and it means the system needs no special cases for the charter's "humans mentor / approve / redirect" list. V1 assumes exactly one human; multi-user is a scalability item (07), not a domain change — the model already supports it.

### Relationships

The charter lists "relationships" as something agents own. Stored relationships (friend lists, reporting lines) would go stale and lie. Instead, relationships are a **projection**: the agents this agent has delegated to, received from, reviewed, or messaged, weighted by recency and volume — computed from tasks and messages, rendered on the agent page. Always true, never maintained.
