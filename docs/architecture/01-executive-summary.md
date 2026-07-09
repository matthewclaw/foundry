# 01 — Executive Summary, Philosophy, Vision

## Executive Summary

Foundry is an operating environment for organisations of persistent AI specialists. It is a **control plane**: it owns identity, memory, conversations, delegation, communication, policy, and observability, and it treats execution engines (Claude Code, Codex CLI, future tools) as interchangeable workers underneath it.

The architecture rests on five decisions. Everything else follows from them.

### 1. An agent is a durable record, not a process

The single most important decision. An agent is a row in a database plus a directory on disk: identity, role, charter (instructions), memory, engine binding, and the full history of its work. It is *never* a running process. When an agent "works", the runtime materialises an ephemeral **run** — an engine invocation seeded with the agent's charter, memory, and workstream context — and folds the results back into the record when the run ends.

Consequences, all of which the charter asks for and none of which need special machinery:

- Agents survive terminal closures, reboots, and engine upgrades, because there is nothing to kill.
- An idle agent costs nothing. An organisation of 200 specialists with 6 active runs costs exactly 6 runs. "Hundreds of agents" is a UX problem, not an infrastructure problem.
- Replacing the execution engine changes one field and one adapter — the agent, its memory, and its history are untouched.
- One agent can have many concurrent workstreams naturally: they are just rows pointing at the same agent.

### 2. The control plane is a tool surface

How does an agent delegate, escalate, request a review, or report completion — in an engine-agnostic way? Not by parsing its output, and not by engine-specific integration. The control plane exposes itself **as tools inside every run** (an MCP server, with a CLI fallback for engines without MCP support): `delegate_task`, `send_message`, `escalate`, `request_approval`, `complete_task`, `update_task`.

Every organisational act is therefore an explicit, typed, validated tool call — auditable by construction, identical across engines, and impossible to miss. The engine executes; the control plane organises; the boundary between them is a tool schema.

### 3. Authoritative state tables, plus an append-only event log

Every state change writes the new state *and* an event describing it, in the same transaction. The event log is the observability substrate: timelines, delegation trees, "why did this happen", cost accounting, and the real-time UI feed are all projections of it. We deliberately stop short of full event sourcing (state rebuilt only from events) — replay machinery is complexity the charter's goals don't require. See ADR-002.

### 4. Communication is typed work items, not chat

Agent-to-agent chat is a token-burn amplifier and a prompt-injection vector. Instead, every message has a **type** (question, answer, review_request, review, handover, escalation, status, discovery), a thread, a required disposition (a question must eventually be answered, rejected, or withdrawn), a budget, and human visibility by default. The control plane routes messages; agents never hold direct channels to each other. This is what "design communication, don't build chat" cashes out to.

### 5. The scarce resource is human attention

With agent-count effectively free (decision 1), the binding constraint on organisation size is what one human can supervise. So the primary UI surface is not a dashboard — it is an **inbox**: escalations, approval requests, reviews awaiting the human, completed work awaiting acceptance, anomalies. The org view answers "is everything healthy at a glance"; the inbox answers "what needs me, in what order". Everything else is drill-down.

### The layer stack

```
┌─────────────────────────────────────────────────────┐
│  UI  (org view · inbox · agent pages · timelines)   │
├─────────────────────────────────────────────────────┤
│  Control Plane API  (the only write path)           │
│   organisation · agents · workstreams · tasks       │
│   messages · policy · budgets · approvals           │
├──────────────────────────┬──────────────────────────┤
│  Store                   │  Agent Runtime           │
│   SQLite state tables    │   run scheduler          │
│   append-only event log  │   workspace manager      │
│   artifact/memory files  │   run supervisor         │
├──────────────────────────┴──────────────────────────┤
│  Execution Adapters  (narrow contract, per engine)  │
│   claude-code · fake (testing) · codex (later)      │
├─────────────────────────────────────────────────────┤
│  Execution Engines  (external, replaceable)         │
└─────────────────────────────────────────────────────┘
```

Deployment model: **local-first, single-node** — one process, SQLite, filesystem, a local web UI. No server infrastructure to stand up. The API boundary is designed so that a multi-user server deployment is a packaging change, not a redesign (see 07, Scalability).

---

## Design Philosophy

The charter's philosophy is adopted wholesale; these are the operating rules the architecture adds:

1. **Persistence through data, not daemons.** Nothing about an agent should require a live process. If a concept can't survive `kill -9` of the whole control plane, it's designed wrong.
2. **Everything observable is an event.** If it didn't emit an event, it didn't happen. There is no side channel; the UI, the audit trail, and the telemetry are the same data.
3. **One write path.** All mutations go through the control plane API — the UI, the CLI, and the agents' own tool calls hit the same endpoints with the same validation and the same policy checks. Agents and humans are both `actors`; an agent delegating to an agent and a human assigning work to an agent are the same operation with different actor IDs.
4. **Structured at the boundaries, free in the middle.** Inside a run, the engine reasons however it wants. At the boundary — messages, tasks, completions, escalations — everything is typed and validated. We never parse prose to discover organisational intent.
5. **Degrade, don't gate.** Engines differ wildly in observability (Claude Code streams rich JSON; others may offer stdout and an exit code). The adapter contract defines a small mandatory core and optional capability flags. A weak engine yields a coarser timeline, not a broken product.
6. **Trust boundaries between agents.** A message from another agent is untrusted input, exactly like web content. Provenance is always attached; policy governs who may instruct whom; privilege boundaries require human approval.

---

## System Vision

Morning. You open Foundry. The org view shows five teams, twenty-three specialists. Twenty are idle (grey, free). Two are active — you can see the Backend Engineer is three runs into the auth refactor workstream, burning within budget. One is blocked — red, with the reason attached: it escalated a schema-change decision overnight.

Your inbox has four items, ranked: the escalation (decision needed), a review the Architecture agent requested of *you*, a completed task from yesterday awaiting your acceptance, and a budget-threshold warning on a research workstream. You resolve the escalation with two sentences; the blocked agent's next run is scheduled automatically with your answer in context.

You click the Backend Engineer. Its page shows identity and charter, its five open workstreams, its memory highlights, and its relationships — it delegated test-writing to the Testing agent yesterday (delivered, accepted), and it has an open question out to the Platform agent. You open the auth-refactor workstream and read the run timeline: tool calls, reasoning summaries, an artifact diff. You post a redirect — "use the existing session middleware, don't write a new one" — which becomes the seed of its next run.

Nothing here required watching a terminal. Nothing was invisible. And the whole thing is a projection of one event log you could audit line by line.

---

## Challenges to the Charter and Brief

The brief demands challenge, not agreement. These are the places the architecture deliberately deviates or pushes back. Each is reflected in the later documents.

### C1. "Colleagues" is a UX outcome, not an architectural requirement

The charter wants agents to "feel like colleagues" with identities and relationships. Agreed as UX; rejected as architecture. We do not build personality, rapport, or social simulation. We build **accountability**: identity as data, history as events, relationships as the observable record of delegations, reviews, and messages. The colleague-feeling emerges from continuity and accountability. Any effort spent on making agents *seem* like people is effort stolen from making them *answerable* like people.

### C2. Two hierarchies, and the brief conflates them

The brief shows "Backend Team / Frontend Team" *and* "Architecture Agent → Backend Agent → Testing Agent" trees. These are different structures and merging them is a classic org-tooling mistake:

- The **static organisation** (teams) is for human navigation and policy defaults. It is metadata: a team is a label with defaults, not a container with behaviour.
- The **dynamic delegation tree** is per piece of work, formed and dissolved by `delegate_task` calls, and reconstructed entirely from the task graph.

The org chart tells you who exists. The delegation tree tells you who is doing what for whom, right now. Both stay observable; neither is stored as the other. (See 02, Organisation Model.)

### C3. Agent-to-agent communication must be budgeted, typed, and human-visible — not open

The brief asks us to "explore architectures where agents can debate designs and challenge assumptions." Unconstrained, this is the most expensive and least trustworthy feature in the system: two agents can burn unbounded tokens politely agreeing with each other, and a poisoned agent can steer a privileged one (prompt injection travels through chat). We therefore ship communication as typed work items with dispositions, per-thread budgets, depth limits, and human visibility by default. Free-form multi-round debate is deliberately *not* in v1; the message types (`review_request`, `question`, `proposal`) cover the charter's collaboration list with bounded cost. (See 04.)

### C4. "Health" is a metaphor — derive it, don't invent it

An agent is not a server; it has no CPU or heartbeat. Fake vitals erode trust. Status is **derived, never self-reported**: active (run executing), waiting (awaiting an answer/approval), blocked (task blocked with a reason), idle, degraded (recent run failures), over-committed (open workstreams above threshold). Every status is explainable by clicking through to the events that produced it. (See 06.)

### C5. The scaling problem is attention, not compute

The charter worries about "dozens or hundreds" of agents. Under decision 1, idle agents are free rows; hundreds are trivial for SQLite on a laptop. The real ceiling is the human. So scalability work in v1 goes to attention mechanics — inbox ranking, roll-ups, exception-first views, delegated acceptance (an agent can accept its subordinate's work so the human accepts only the root) — not to distributed systems. Distributed comes when concurrent *runs*, not agents, outgrow one machine. (See 07.)

### C6. Memory is an open research problem — keep the architecture out of its blast radius

The charter wants knowledge to "compound over time." True long-term agent memory (consolidation, relevance, forgetting) is unsolved. We refuse to bet the architecture on any particular scheme: v1 memory is a per-agent directory of markdown files (an index the agent maintains through its own runs — the pattern Claude Code already proves works), versioned in git, injected into run context. The memory interface is small so smarter backends can replace it without touching anything else. (See 05.)

### C7. Engine-agnosticism has a floor, and honesty about it beats pretending

"Make replacing Claude Code straightforward" is achievable for execution, but observability quality is engine-bound: Claude Code emits structured event streams, session resumption, cost data, and hooks; a lesser CLI may emit text. The adapter contract mandates a minimal core (start/resume/cancel a run; terminal status; final output) and declares optional capabilities (streaming events, tool-use visibility, cost, checkpointing). The UI degrades per capability. What we do *not* do is limit the product to the lowest common denominator. (See 03.)

### C8. Conversations are disposable — but never deleted

The charter says "conversations are disposable." Corrected to: **closable**. Workstreams close and archive; they are also the audit trail and the raw material for memory. Deleting them would violate charter principle 11 (trust through explainability). Disposal is a retention policy (see 05), not a delete button.

### C9. One brief deliverable is refused: tasks sized for "Haiku-level agents with minimal reasoning" — *at the interface layer*

Most of the roadmap is decomposed to that size, and the fake-engine testing strategy exists precisely to let small agents verify their own work. But a handful of components — the adapter contract, the event schema, the scheduler's concurrency rules — are *keystone* work where a cheap wrong decision costs more than an expensive right one. The roadmap marks these explicitly as senior-agent/human tasks. Pretending everything decomposes to Haiku-size would be a comfortable lie. (See implementation/roadmap.md.)

---

## What Success Looks Like (restated as tests)

1. Kill the control plane process mid-run; restart it. Every agent, workstream, and task is intact; interrupted runs are marked and resumable. *(Persistence through data.)*
2. Create 200 agents; open the org view. Load time and comprehension are unaffected; cost is zero until runs start. *(Agents are rows.)*
3. Swap an agent's engine from `claude-code` to `fake`; its identity, memory, history, and open workstreams are unchanged. *(Design for replacement.)*
4. Pick any completed task and answer, from the UI alone: who delegated it, why, what it cost, what messages it produced, who accepted it. *(Trust through understanding.)*
5. An agent three levels deep in a delegation tree escalates; the escalation appears in the human inbox within one second, with the full chain attached. *(Delegation never hides work.)*
6. A new engine adapter reaches "runs work end-to-end" by implementing one interface and passing one contract-test suite, with no changes outside its package. *(The control plane is the product.)*
