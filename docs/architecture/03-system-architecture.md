# 03 — System Architecture: Control Plane, Runtime, Execution Adapters, Plugins

## Overview

One deployable process (v1) with strict internal package boundaries — the boundaries are the future service seams, but we do not pay the distributed-systems tax before we need it.

```
                    ┌────────────────────────────┐
   Browser ────────►│  server (Control Plane API)│◄──────── cli (admin)
   (ui package)     │  REST commands/queries     │
        ▲           │  WS/SSE event feed         │
        │ events    └──────┬──────────────┬──────┘
        │                  │              │
        │           ┌──────▼─────┐  ┌─────▼──────────────────┐
        └───────────┤   store    │  │        runtime         │
                    │ SQLite +   │  │ scheduler · supervisor  │
                    │ event log  │  │ workspace manager       │
                    │ files      │  └─────┬──────────────────┘
                    └────────────┘        │ AdapterContract
                                    ┌─────▼─────┐ ┌──────────┐
                                    │claude-code│ │   fake    │ …
                                    │  adapter  │ │  adapter  │
                                    └─────┬─────┘ └──────────┘
                                          │ spawns / streams
                                    ┌─────▼─────┐
                                    │ engine CLI │  ← also calls BACK into the
                                    └───────────┘     API via org-tools (MCP)
```

Note the loop at the bottom right: engines call **back into the control plane** through the org-tools surface. That loop is the heart of the design.

---

## The Control Plane

The control plane is the product (charter principle 8). It owns:

- **Entities & invariants** — agents, workstreams, tasks, messages; every state machine in doc 02 is enforced here and nowhere else.
- **The single write path** — UI, CLI, and agents' org-tool calls all land on the same API with the same validation, the same policy checks, the same events. No component writes to the store directly except through control-plane services.
- **Policy enforcement** — budgets, delegation depth, communication permissions, approval gates (07). Enforced at the API, so no engine behaviour can bypass them.
- **Routing** — resolving team/role-addressed tasks and messages to agents (02).
- **Context composition** — assembling what a run gets to see (below).
- **The event feed** — ordered event stream to the UI and any subscriber.

### API shape (contract details in implementation/contracts.md)

- **Commands** (REST, verb-shaped): `POST /agents`, `POST /tasks`, `POST /tasks/:id/deliver`, `POST /workstreams/:id/messages`, `POST /runs/:id/cancel`, `POST /approvals/:id/grant` …
- **Queries** (REST, noun-shaped): org view, agent page, workstream timeline, delegation tree, inbox — each a purpose-built projection, not generic entity CRUD the UI must join client-side.
- **Event feed** (WebSocket/SSE): `GET /events?after=<seq>` — the UI's real-time source; reconnection replays from `after`, so the UI never misses events.

### Org-tools: the agent-facing surface

Every run is provisioned with an **org-tools** endpoint (MCP server in v1; a thin CLI shim for engines without MCP). The toolset is the complete vocabulary of organisational action:

| Tool | Effect |
|---|---|
| `delegate_task` | Create a task (spec, acceptance criteria, budget request, assignee or routing spec) |
| `update_task` | Progress note, or mark blocked with reason |
| `deliver_task` | Deliver against acceptance criteria with artifact refs → task `delivered` |
| `send_message` | Typed message (question/answer/review_request/review/proposal/status/discovery/handover) |
| `escalate` | Raise to delegator/human with severity + what-is-needed |
| `request_approval` | Ask for a human decision (privileged action, budget raise, boundary crossing) |
| `search_history` | FTS recall over own (policy-scoped) transcripts, results, messages (05, ADR-012) |
| `list_org` / `get_task` / `get_thread` | Read views, policy-scoped |

Properties that make this the keystone:

1. **Engine-agnostic** — any engine that can call a tool (or run a CLI) participates fully in the organisation. Organisational capability is *not* engine capability.
2. **Auditable by construction** — organisational acts are validated tool calls hitting the same API as humans; nothing is inferred from prose.
3. **Policy-checked at the boundary** — a `delegate_task` exceeding depth or budget fails *inside the run* with a clear error the agent can react to (typically by escalating).
4. **Identity-bound** — each run's org-tools credential is scoped to the agent + run, so events attribute precisely and a run can never act as someone else.

### Context composition

The control plane — not the engine — decides what a run knows. Composed per run, recorded per run (`input_context_ref`, so "what did it know when it decided X" is always answerable):

1. Agent charter (current version)
2. Agent memory + skills (indexes + directory paths, provenance-labelled; engine reads files itself — Claude Code additionally loads the skills dir natively)
3. Workstream goal + summary of prior runs (engine session resume where supported; recomposed summary where not)
4. The trigger (the new human message, the assigned task spec, the answered question…)
5. Pending items (unanswered questions to this agent within scope)
6. Org-tools connection info + standing instructions ("you may delegate within budget X; escalate rather than guess on Y…")

---

## The Agent Runtime

The runtime turns intent ("this workstream should advance") into supervised engine processes. Three parts:

### Scheduler

- A **run queue**: entries are `(workstream, trigger)` pairs created by control-plane activity — human message, task assignment, answer arrived, approval granted, schedule fired.
- **Serialization per workstream**: at most one run per workstream at a time (`seq` in doc 02). Concurrency comes from parallel workstreams, not parallel runs on one thread of intent — parallel runs on one workstream would race on workspace and context.
- **Concurrency caps**: org-wide (`max_concurrent_runs`, default modest — this is a cost knob as much as a CPU knob), per-agent, per-team. Queue overflow is visible (queued runs are events; long queues surface in observability).
- **Wake-on-event**: an idle agent with a new task gets a run scheduled automatically — this is the mechanism that makes persistent-but-idle agents responsive without polling or resident processes.
- Fairness: FIFO with human-triggered runs prioritised over agent-triggered ones. Nothing fancier until proven necessary.

### Run supervisor

Owns a run from `queued` to terminal:

1. Ask the store for composed context; ask the workspace manager for the directory.
2. Invoke the adapter (`start` or `resume`), receive the normalized event stream.
3. Persist stream events (batched) to the event log; update run/workstream projections.
4. Watchdogs: wall-clock timeout, token-budget cutoff (from streamed usage where available; post-hoc where not), stall detection (no events for N minutes → flag, then interrupt per policy).
5. On terminal: record result/usage, fold outcome into workstream state, hand outbound effects (delivered tasks, sent messages already applied via org-tools during the run) to the control plane for follow-on scheduling.
6. On crash (adapter dies, control plane restarts): mark `interrupted`; the workstream keeps its `engine_session_ref`; a resume run can be scheduled (automatically once, then human-visible).

### Workspace manager

- Per-workstream **git worktrees** off the target repo: parallel workstreams don't collide; per-workstream diff is always available as an artifact; merging back is an explicit act (a task deliverable), not a side effect.
- Non-code workstreams get a plain scratch directory.
- Cleanup on archive per retention policy; never while a run is live.

---

## Execution Adapters

The adapter contract is the replaceability guarantee (charter principle 9) and is deliberately narrow.

### Contract (full interface in implementation/contracts.md)

**Mandatory core** — every adapter:

```
capabilities(): CapabilitySet
start(run: RunSpec): RunHandle          // spawn engine with composed context in workspace
cancel(handle): Promise<void>
events(handle): AsyncStream<EngineEvent>  // minimally: started, output(text), ended(result)
```

**Optional capabilities**, declared not assumed:

| Capability | Enables |
|---|---|
| `resume` | Session continuation across runs (`resume(sessionRef, input)`) |
| `stream_events` | Live tool-call/output timeline in the UI |
| `tool_events` | Tool-level audit ("it edited these files, ran these commands") |
| `usage` | Token/cost accounting per run |
| `reasoning_summaries` | "Why" summaries on the timeline |
| `permission_hooks` | Engine permission prompts → ADE approvals (below) |
| `mcp` | Org-tools via MCP (else CLI-shim fallback) |

The UI and telemetry read `capabilities()` and degrade per feature (philosophy rule 5): an engine without `stream_events` shows run start/end and final output; one without `usage` shows "cost unreported". **Degradation is visible, not silent** — the agent page shows its engine's observability grade, so a human choosing an engine sees the trade.

### Normalized engine events

Adapters translate engine-native output into a small event vocabulary: `run_started`, `output_delta`, `reasoning_summary`, `tool_call_started/ended`, `usage_delta`, `awaiting_input`, `permission_request`, `run_ended{outcome}`. This vocabulary — not any engine's native format — is what the store, UI, and telemetry consume.

### The claude-code adapter (reference implementation)

- Spawns `claude -p` headless with `--output-format stream-json` in the workstream workspace; maps the stream to normalized events; captures session id for `resume` (`--resume <id>`).
- Injects org-tools as an MCP server via generated config.
- Declares every optional capability, including `permission_hooks`: engine permission prompts become ADE `request_approval` items in the human inbox; grant/deny flows back. Permission *policy* (which mode, which tools pre-allowed) comes from ADE agent policy (07), translated to engine flags.
- Cost/usage from result payloads.

### The fake adapter (testing keystone)

A scripted engine: reads a scenario file (emit these events, call these org-tools, deliver this task, sleep, fail here, hang there…). It declares all capabilities. Every layer above the adapter contract — runtime, control plane, UI — is testable end-to-end, deterministically, at zero token cost. It also lets UI and runtime development proceed in parallel with the real adapter, and it is how failure modes (07) get regression tests. It ships in v1 as a first-class package, not test scaffolding.

---

## Plugin Architecture

V1 has exactly **one** plugin type: the execution adapter — because it's the one axis where third-party variation is certain and the contract is already required internally. Adapters are packages implementing the contract + passing the shared conformance suite (contract tests run against any adapter, including the fake one).

Deliberately **not** pluggable in v1 (each is a labelled seam, not a promise): memory backends (interface exists — 05 — but one implementation), storage engines (store package boundary), UI panels, communication transports, policy engines. Premature plugin surfaces are API commitments you can't retract; we cut them until an actual second implementation demands each. The event log is the universal integration escape hatch in the meantime — anything can *observe* everything.
