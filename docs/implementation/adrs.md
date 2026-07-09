# Architecture Decision Records

Status values: **Accepted** (binding for v1) · **Provisional** (accepted, expected to be revisited at a named trigger). Each ADR is deliberately short; the architecture docs carry the full reasoning.

---

## ADR-001 — An agent is a durable record; execution is an ephemeral run

**Status:** Accepted

**Context:** The charter requires agents that persist for months, survive restarts, and outlive engines; the brief requires many concurrent workstreams per agent and hundreds of agents.

**Decision:** Agents are rows + files (identity, charter, memory, history). All execution happens in per-workstream, serialized, resumable runs materialised by the runtime. No resident agent processes exist.

**Consequences:** Persistence, idle-cost-zero, and engine-swap fall out for free. Agents cannot act ambiently — action requires a scheduled run (trigger or schedule). Accepted; ambient behaviour is an open question (08 §OQ1).

---

## ADR-002 — Authoritative state tables plus an append-only event log; not event sourcing

**Status:** Accepted

**Context:** Observability and audit are the top requirement; full event sourcing offers replay but demands projection/replay machinery, versioned reducers, and disciplined upcasting — heavy for a v1 built by many small agents.

**Decision:** Every mutation writes state and event(s) in one SQLite transaction via store helpers that accept `(change, event)` pairs only. State tables are authoritative; the log explains, feeds, and audits. High-volume run output deltas are compactable into transcript files.

**Consequences:** Simple queries, simple store, complete audit. No rebuild-from-log; a wrong projection is a bug, not a replayable repair. Revisit-trigger: if server mode demands tamper-evident audit, hash-chain the log then.

---

## ADR-003 — Execution engines integrate through a narrow adapter contract with declared capabilities

**Status:** Accepted

**Context:** Charter principle 8/9: engines are replaceable workers; but engines differ wildly in observability (C7).

**Decision:** Adapters implement a mandatory core (start/cancel/event-stream/terminal-result) and declare optional capabilities (`resume`, `stream_events`, `tool_events`, `usage`, `reasoning_summaries`, `permission_hooks`, `mcp`). All upper layers consume normalized engine events only. A shared conformance suite gates every adapter. UI degrades per capability, visibly.

**Consequences:** New engine = one package + passing suite. The product is *not* capped at the weakest engine. Adapter maintenance is a permanent cost (Risk 1).

---

## ADR-004 — Organisational acts are typed tool calls; communication is typed messages, never chat

**Status:** Accepted

**Context:** Engine-agnostic delegation/communication can't rely on parsing prose; agent-to-agent chat is unbounded in cost and an injection channel (C3).

**Decision:** The control plane exposes org-tools (MCP + CLI shim) inside every run: `delegate_task`, `deliver_task`, `update_task`, `send_message`, `escalate`, `request_approval`, reads. Messages come from a closed, versioned type set with required dispositions; threads carry agent-to-agent round caps with auto-escalation; all traffic is human-visible, provenance-labelled, and policy-checked at the API.

**Consequences:** Auditable-by-construction organisation; bounded communication cost; contained injection blast radius. Gives up emergent free-form collaboration — deliberately (revisit with dogfood data, 08 §OQ2).

---

## ADR-005 — Local-first single-node deployment; SQLite; the API is the only seam that must not break

**Status:** Provisional (revisit at server mode)

**Context:** Trust and adoption demand zero-infrastructure start; the charter demands eventual teams-of-humans scale.

**Decision:** One process, SQLite (WAL), filesystem, localhost UI. All growth steps (daemon, remote runners, server mode, Postgres) are packaging changes behind existing package seams; the HTTP API and event feed are the stable contracts.

**Consequences:** V1 concurrent-run ceiling is one machine. Multi-user auth deferred. The store package must never leak SQLite specifics upward.

---

## ADR-006 — Delegation is a task tree with structural guarantees: budget conservation, depth caps, mandatory acceptance criteria, explicit acceptance

**Status:** Accepted

**Context:** The charter demands delegation that increases transparency; the failure modes (runaway spawning, cost blowout, vague specs, silent completion) are predictable.

**Decision:** Tasks form a tree (`parent_task_id`); child budgets are carved from parent remainder (sum ≤ parent, recursively); depth capped by policy; `delegate_task` without checkable acceptance criteria is rejected; every task ends in explicit accept/reject by its delegator (human at roots), with rejection loops capped then escalated.

**Consequences:** Runaway trees are impossible to sustain rather than merely detectable. Friction on informal delegation — accepted as a feature.

---

## ADR-007 — V1 memory is agent-curated markdown files, git-versioned, behind a minimal interface

**Status:** Provisional (revisit when curation quality data exists)

**Context:** Long-term memory is unsolved (C6); the architecture must not depend on any scheme being right.

**Decision:** Per-agent memory directory (`INDEX.md` + single-fact files), maintained by the agent itself during runs via ordinary file tools, auto-committed to git, injected via index into run context. Context composition consumes memory through one small interface.

**Consequences:** Transparent, human-editable, versioned memory now; smarter backends later without architectural change. Memory quality is bounded by agent curation discipline. Extended by ADR-012 (procedural + episodic memory).

---

## ADR-008 — Status, health, relationships, and progress are derived projections, never stored facts

**Status:** Accepted

**Context:** Stored status goes stale and lies; trust requires every signal to be explainable (C4).

**Decision:** Agent status, org health roll-ups, relationships, progress, and burn are computed from live rows and events; every surfaced signal links to producing events.

**Consequences:** No staleness bug class; derivations must be cheap (indexed queries) — acceptable at v1 scale by orders of magnitude.

---

## ADR-009 — Humans and agents share one actor model and one write path

**Status:** Accepted

**Context:** Delegation, messages, approvals, and audit must have one shape whether a human or an agent acts (charter: humans mentor/approve/redirect as first-class acts).

**Decision:** `actors(kind: human|agent)`; all mutations — UI, CLI, org-tools — hit the same control-plane API with the same validation, policy, and events. V1 ships exactly one human actor.

**Consequences:** No special-cased human machinery; multi-user later is auth + semantics, not domain change.

---

## ADR-010 — The fake adapter is a first-class product component and the testing backbone

**Status:** Accepted

**Context:** End-to-end behaviour (delegation trees, failure modes, UI timelines) must be testable deterministically, cheaply, and in parallel by many implementation agents, without burning tokens.

**Decision:** A scripted engine adapter, driven by scenario files, declaring all capabilities, able to call org-tools, fail, hang, and burn simulated budget on demand. The adapter conformance suite runs against fake and real (recorded-fixture) adapters alike; every failure mode in 07 has a fake scenario.

**Consequences:** Runtime, control plane, and UI are implementable and verifiable against the fake adapter before/without the real engine — the single biggest enabler of the brief's "maximise parallel implementation."

---

## ADR-011 — Git worktrees per workstream; merging back is an explicit deliverable

**Status:** Accepted

**Context:** Parallel workstreams on one repo must not collide; per-workstream change review must be trivial.

**Decision:** Code workspaces are per-workstream git worktrees; runs execute inside them; the workstream diff is a standing artifact; nothing merges as a side effect.

**Consequences:** Isolation and reviewability by construction; a merge/integration step exists per workstream — that step is real work and is modelled as such (a task), not hidden.

---

## ADR-012 — Self-improvement: skills as procedural memory + FTS recall over history (after Hermes-agent)

**Status:** Accepted

**Context:** ADR-007 covers declarative memory (facts) only. Agents that repeatedly perform similar work should retain *procedures* and be able to recall *episodes*. [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) demonstrates both in production: agent-authored skills (agentskills.io `SKILL.md` format) that self-improve during use, and FTS5 full-text search over past sessions, with recalled content injected under an explicit provenance label.

**Decision:** Three borrowings, all riding existing infrastructure (05):
1. Per-agent `skills/` directory of `SKILL.md` files (agentskills.io standard — natively loadable by Claude Code; index-injected for other engines). Skills are created and revised by the agent itself at moments of maximum context (workstream-close distillation, mid-run fixes), never by a background mining process.
2. An FTS5 index over transcripts, run results, messages, and workstream goals, exposed as one policy-scoped org-tool: `search_history`.
3. All recalled memory (declarative, procedural, episodic) enters composed context under a "recalled, not new input" provenance label.

**Not borrowed:** Honcho-style user modelling (single-human v1, out of scope), trajectory compression for model training (not our goal), background review/curator daemons (deferred — see 08 §OQ3), learning-graph visualisation (a projection over data we already emit; deferred to Future Evolution).

**Consequences:** Procedural knowledge compounds per agent and stays human-editable/git-diffable like all memory; episodic recall becomes a cheap tool call instead of re-derivation. Cost: skill quality depends on the same curation discipline as ADR-007, and the FTS index adds one more thing the store maintains. The memory seam (05) is unchanged — smarter backends still swap in behind it.
