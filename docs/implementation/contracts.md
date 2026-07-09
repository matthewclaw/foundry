# Repository Structure, Component Contracts, API Contracts, Data Contracts, Testing Strategy

Everything here is a **contract**: implementation agents build to these shapes; changing a shape is an architecture change (new ADR), not a refactor. Signatures are TypeScript; all cross-boundary payloads also exist as Zod schemas in `@foundry/core` (single source of truth ⇒ static types + runtime validation + JSON Schema for MCP/API docs).

## Repository structure

```
foundry/
├── docs/                      # these documents
├── packages/
│   ├── core/                  # L0: domain types, Zod schemas, event catalogue, ids. No I/O. Depends on nothing.
│   ├── store/                 # L1: SQLite, migrations, (change,event) mutation helpers, projections. Depends: core.
│   ├── adapter-api/           # L1: AdapterContract types + conformance test suite. Depends: core.
│   ├── adapter-fake/          # L2: scripted engine (ADR-010). Depends: adapter-api.
│   ├── adapter-claude-code/   # L2: reference engine adapter. Depends: adapter-api.
│   ├── runtime/               # L2: scheduler, run supervisor, workspace manager. Depends: core, store, adapter-api.
│   ├── server/                # L3: control-plane API (HTTP+SSE), org-tools MCP server, policy, routing, context composition. Depends: core, store, runtime.
│   ├── ui/                    # L4: React SPA. Depends: core (types only) + HTTP/SSE. Never imports store/runtime.
│   └── cli/                   # L4: `foundry` command (init, daemon, agent mgmt, backup). Depends: core + HTTP.
├── package.json               # pnpm workspaces
└── …
```

Dependency rule: **packages depend only on lower layers; L4 talks to L3 only over HTTP/SSE.** Enforced in CI (dependency-cruiser or equivalent). These boundaries are the future service seams (07).

---

## Component contracts

### `@foundry/core` (domain + schemas)

Exports, no I/O: entity types (doc 02), all Zod schemas (`EventSchema`, `MessageSchema`, `TaskSpecSchema`, `EngineEventSchema`, org-tool input/output schemas, API DTOs), the **event catalogue**, ULID helpers, state-machine transition tables (`canTransition(entity, from, to)` — one implementation of the doc-02 state machines, used by store and server alike).

### `@foundry/store`

```ts
interface Store {
  // The only mutation surface — change and event(s) commit atomically or not at all (ADR-002)
  mutate<T>(m: { apply(tx: Tx): T; events: NewEvent[] }): T;

  agents: AgentQueries;        workstreams: WorkstreamQueries;
  runs: RunQueries;            tasks: TaskQueries;        // incl. tree(rootTaskId)
  messages: MessageQueries;    approvals: ApprovalQueries;
  events: {
    after(seq: number, filter?: EventFilter): Event[];    // feed replay
    subscribe(cb: (e: Event) => void): Unsubscribe;       // in-process feed
    compactRunDeltas(runId: RunId): void;                 // → transcript file (05)
  };
  projections: {
    orgView(): OrgView; agentPage(id: AgentId): AgentPage;
    workstreamTimeline(id: WorkstreamId, page?): Timeline;
    delegationTree(rootTaskId: TaskId): TreeView;
    inbox(): InboxItem[]; costRollup(scope: CostScope): CostReport;
  };
}
```

Purpose-built projections live here (not assembled in the server or UI) so there is exactly one definition of, e.g., "agent status" (ADR-008).

### `@foundry/adapter-api`

```ts
interface ExecutionAdapter {
  readonly id: string;                       // "claude-code" | "fake" | …
  capabilities(): CapabilitySet;             // { resume, stream_events, tool_events,
                                             //   usage, reasoning_summaries,
                                             //   permission_hooks, mcp }: boolean
  start(spec: RunSpec): Promise<RunHandle>;
  resume?(spec: RunSpec & { sessionRef: string }): Promise<RunHandle>;
  cancel(h: RunHandle): Promise<void>;
  events(h: RunHandle): AsyncIterable<EngineEvent>;  // ends with exactly one run_ended
}

interface RunSpec {
  runId: RunId; agentName: string;
  contextFile: string;        // absolute path: composed context (server writes it)
  workspaceDir: string;
  orgTools: { mcpConfig?: object; cliEnv?: Record<string,string> }; // per-run credential inside
  engineConfig: unknown;      // adapter-specific, zod-validated by the adapter
  limits: { wallClockMs: number };
}

type EngineEvent =
  | { t: 'run_started'; sessionRef?: string }
  | { t: 'output_delta'; text: string }
  | { t: 'reasoning_summary'; text: string }
  | { t: 'tool_call'; phase: 'start'|'end'; name: string; detail?: unknown }
  | { t: 'usage_delta'; tokensIn?: number; tokensOut?: number; costUsd?: number }
  | { t: 'awaiting_input'; prompt: string }
  | { t: 'permission_request'; requestId: string; description: string }   // ↔ approvals
  | { t: 'run_ended'; outcome: 'completed'|'needs_input'|'failed'|'cancelled';
      finalText?: string; error?: string; sessionRef?: string };
```

Also exports the **conformance suite**: `describeAdapterContract(makeAdapter)` — a Vitest suite any adapter package must pass (lifecycle, cancel semantics, event ordering, capability honesty: declared capabilities must be exercised, undeclared must never emit).

### `@foundry/runtime`

```ts
interface Runtime {
  enqueue(job: { workstreamId: WorkstreamId; trigger: RunTrigger }): void;
  cancelRun(runId: RunId): Promise<void>;
  reconcileOnStartup(): Promise<void>;   // F3: running→interrupted, sweep pids, requeue
}
```

Owns: per-workstream serialization, concurrency caps, priority (human-triggered first), watchdogs (stall, wall-clock, budget cutoff on streamed usage), workspace acquisition, adapter invocation, event persistence, terminal-state folding. Configured with `Store` + adapter registry; **contains no HTTP and no engine specifics.**

### `@foundry/server`

Owns: the HTTP/SSE API (below), org-tools MCP server + CLI shim, policy engine (org→team→agent chain; budgets, depth, comms, approvals), router (02), context composition (03), startup orchestration (store migrate → runtime reconcile → listen).

---

## API contract (v1 surface — additive evolution only)

Commands (all validated by core schemas; all emit events):

```
POST /api/agents · PATCH /api/agents/:id · POST /api/agents/:id/{suspend,resume,retire}
POST /api/workstreams · POST /api/workstreams/:id/messages     # human message / redirect → enqueues run
POST /api/workstreams/:id/close
POST /api/tasks                                                # human delegation (same schema as org-tool)
POST /api/tasks/:id/{accept,reject,cancel}
POST /api/runs/:id/cancel
POST /api/approvals/:id/{grant,deny}
POST /api/org-tools/*                                          # org-tool calls land here (per-run token auth)
```

Queries (mirror store projections 1:1): `/api/org`, `/api/inbox`, `/api/agents/:id`, `/api/workstreams/:id/timeline`, `/api/tasks/:id/tree`, `/api/cost?scope=…`.

Feed: `GET /api/events?after=<seq>` — SSE; every event has monotonic `seq`; reconnect replays; UI state = replayed feed + queries.

Errors: RFC 9457 problem+json; policy rejections carry machine-readable `code` (`budget_exceeded`, `depth_cap`, `missing_acceptance_criteria`, …) — org-tools relay these codes verbatim into the run so agents can react sensibly.

## Org-tools contract (agent-facing; schemas in core)

```
delegate_task    { title, spec_md, acceptance_criteria_md, budget?, assignee_agent_id? | routing?{team?,role?}, refs? } → { task_id } | policy error
update_task      { task_id, note_md?, blocked?{reason} }
deliver_task     { task_id, summary_md, artifact_refs[] }
send_message     { type, to_actor_id? | to_team_id?, thread_id?, body_md, refs? }   # type ∈ doc-04 set minus escalation/completion
escalate         { severity: 'decision_needed'|'blocked'|'incident', body_md, refs? }
request_approval { kind, description, payload? } → { approval_id }   # run may end awaiting_input; grant re-triggers
search_history   { query, scope?: 'self'|'team'|'org' } → { hits[]: {ref, excerpt, ts} }  # FTS5, policy-scoped (ADR-012)
get_task / get_thread / list_org                                      # policy-scoped reads
```

Auth: per-run bearer token minted at run start, scoped `(agent, run)`, expired at run end (07).

## Data contracts

- **Event catalogue** (core): ~40 event types across `agent_* / workstream_* / run_* / task_* / message_* / approval_* / policy_* / system_*`, each with a Zod payload schema and catalogue version. Additive-only; consumers must ignore unknown types. The catalogue file is the reference the UI, telemetry, and future integrations are built against.
- **DB migrations**: numbered, forward-only, applied on startup.
- **Artifacts**: content-addressed (sha256), metadata row + file (05).
- **Composed context**: markdown file per run with a fixed section order (charter / memory index / workstream / trigger / pending items / org-tools instructions) — fixed so context diffs between runs are meaningful.

---

## Testing strategy

Layered so that **every roadmap task carries a runnable verification an implementation agent can execute locally** — this, plus the fake adapter, is what makes small-agent delegation safe.

| Layer | What | How |
|---|---|---|
| Core | Schemas, state machines, ids | Pure unit tests; property tests on transition tables (no invalid transition reachable) |
| Store | Mutation atomicity, projections, feed replay, compaction | Unit tests on real SQLite (`:memory:` + temp files); crash-simulation: kill mid-mutate ⇒ neither state nor event persisted |
| Adapter conformance | Every adapter obeys the contract | Shared `describeAdapterContract` suite: fake adapter runs it live; claude-code runs it against **recorded stream fixtures** (replayed process output) in CI, against the real CLI in a manual/nightly lane |
| Runtime | Scheduling, serialization, watchdogs, reconciliation | Integration tests: runtime + store + fake adapter scenarios (hang ⇒ stall-interrupt; crash ⇒ interrupted+resume; parallel workstreams stay serialized per workstream) |
| Control plane | Policy, routing, org-tools, API | API-level tests: spin server with fake adapter; e.g. scenario "delegates over budget" ⇒ assert `budget_exceeded` reaches the scripted agent and the task never exists |
| End-to-end | Charter-level guarantees | Scenario suite = the doc-01 success tests + every doc-07 failure mode, executed against the full stack with the fake adapter; these are the release gate |
| UI | Views render projections; inbox actions round-trip | Component tests on fixture projections; a handful of Playwright flows against the e2e stack |

Non-negotiables: the fake adapter ships with the same quality bar as production code (ADR-010); recorded claude-code fixtures are versioned and refreshing them is a routine documented task (Risk 1); no test may call a paid engine in CI.
