# 05 — Data Model and Persistence Strategy

## Storage layout

Two stores, deliberately boring:

1. **SQLite** (WAL mode) — all structured state and the event log. One file, transactional, zero administration, trivially backed up, comfortably sufficient for hundreds of agents and years of events on a laptop (see 07, Scalability, for the honest limits).
2. **Filesystem** — things that are naturally files: agent memory directories, artifacts, composed run contexts, engine transcripts. The database stores references and hashes, never blobs.

```
~/.foundry/  (or project-local .foundry/, configurable)
├── foundry.db                    # SQLite: state + events
├── agents/<agent-id>/
│   ├── memory/               # git-versioned markdown memory (below)
│   └── skills/               # git-versioned procedural memory: SKILL.md per skill (below)
├── artifacts/<sha256-prefix>/…   # content-addressed run outputs
├── runs/<run-id>/
│   ├── context.md            # exactly what was composed into the engine
│   └── transcript.*          # engine-native transcript if the adapter captures one
└── workspaces/…              # git worktrees per workstream (03)
```

## Schema (authoritative tables)

Types abbreviated; canonical DDL lives with the store package. All ids are ULIDs (sortable, no coordination).

```sql
actors        (id, kind, display_name, created_at)
agents        (id, actor_id, name, role, team_id, charter_version,
               engine_id, engine_config_json, state, memory_ref,
               default_workspace_ref, policy_json, created_at, retired_at)
agent_charters(agent_id, version, body_md, edited_by_actor, created_at)
teams         (id, name, description, default_policy_json)
workstreams   (id, agent_id, title, goal_md, origin, task_id, workspace_ref,
               state, budget_json, engine_session_ref, created_at, closed_at)
runs          (id, workstream_id, seq, trigger, input_context_ref,
               engine_id, engine_session_id, state, result_json,
               usage_json, started_at, ended_at)
tasks         (id, parent_task_id, root_task_id, depth,
               delegator_actor_id, assignee_agent_id, routing_spec_json,
               spec_md, acceptance_criteria_md, budget_json, state,
               deliverable_ref, accepted_by, accepted_at,
               rejection_count, created_at, closed_at)
messages      (id, thread_id, from_actor_id, to_actor_id, to_team_id,
               type, body_md, refs_json, disposition, disposition_ref,
               visibility, created_at, resolved_at)
threads       (id, anchor_type, anchor_id, round_count, created_at)
approvals     (id, requested_by_actor, kind, payload_json, state,
               decided_by_actor, decided_at, created_at)
artifacts     (id, run_id, kind, path, sha256, size, created_at)
events        (seq INTEGER PRIMARY KEY AUTOINCREMENT,
               ts, actor_id, entity_type, entity_id, type, payload_json,
               run_id, workstream_id, task_id)      -- append-only
schedules     (id, agent_id, cron, prompt_md, enabled)   -- wake agents on a cadence
```

## The event log

- **Write discipline**: every state mutation appends its event(s) in the same transaction. A state change without an event is a bug class, enforced by making the store's mutation helpers take `(change, event)` together — there is no "just update" API.
- **Consumers**: UI real-time feed (`events?after=seq` over WS/SSE), timelines (workstream view = events filtered by `workstream_id`), delegation trees, cost accounting (sum of `usage_delta` payloads), audit queries, anomaly detection (07). One substrate, many projections.
- **Not event sourcing** (ADR-002): state tables are authoritative; the log explains them. We give up replay-to-rebuild and gain a much simpler store. If a projection and the log ever disagree, that's a bug to fix, not a repair path to automate. High-volume run events (`output_delta`) are written to the log for the live feed but are **compactable**: after a run ends, deltas may be folded into the persisted transcript file and pruned from the table per retention policy — the durable audit record is the transcript + run result, not every 40-byte delta.
- **Schema versioning**: every event carries the catalogue version; the catalogue (implementation/contracts.md) only ever adds types/fields. Consumers ignore unknown types by contract.

## Retention (charter challenge C8: close, never delete)

| Data | Policy (defaults, configurable) |
|---|---|
| Agents, tasks, messages, workstreams, runs (rows) | Forever — they are the organisation's history |
| Events: organisational (task/message/state changes) | Forever — cheap and precious |
| Events: run output deltas | Compact to transcript after run end + 7 days |
| Artifacts | Content-addressed; GC only when unreferenced *and* archived > N months |
| Workspaces (worktrees) | Removed on workstream archive (diff captured as artifact first) |
| Engine transcripts | Keep last N per workstream, always keep final |

## Backup & integrity

Single-file DB + one directory tree ⇒ backup is `sqlite3 .backup` + rsync/snapshot of `~/.foundry`. V1 ships a `foundry backup` CLI command and a daily reminder-event if none has run; anything fancier (streaming replication) belongs to server mode. Artifacts are content-addressed (sha256) so corruption is detectable; memory is git-versioned so it is diffable and restorable by nature.

---

## Memory and Self-Improvement

Position (challenge C6): memory is an open research problem; the architecture stays out of its blast radius. V1 chooses the schemes with the best evidence behind them, borrowing deliberately from two proven systems: Claude Code's agent-curated markdown memory, and Hermes-agent's ([NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)) treatment of **skills as procedural memory** plus full-text recall over session history. Three kinds of memory, three cheap mechanisms:

| Kind | Question it answers | Mechanism |
|---|---|---|
| Declarative | "What do I know/believe?" | Curated markdown files (below) |
| Procedural | "How do I do X well?" | Agent-authored skills (below) |
| Episodic | "Have I seen this before?" | FTS5 search over transcripts and closed workstreams (below) |

### Declarative memory: V1 mechanics

- Each agent owns `agents/<id>/memory/`: an `INDEX.md` (one line per memory file) plus small single-fact markdown files with frontmatter (`type: preference | project | decision | reference | lesson`).
- **Write path**: during runs, the agent updates its own memory via ordinary file tools — its standing instructions (composed into every run) tell it when and how, mirroring how a person keeps notes. No pipeline, no embedding jobs, no consolidation daemon.
- **Read path**: context composition (03) injects `INDEX.md` + the memory directory path; the engine reads specific files on demand. Cheap, transparent, and the human can read/edit any agent's memory directly — mentoring includes literally editing an agent's notes.
- **Versioned**: each memory dir is a git repo, auto-committed after runs that touch it. "What did it believe in March, and when did that change?" is `git log`.
- **Curated on lifecycle events**: closing a workstream prompts the agent (in that final run) to distil durable lessons into memory — capture at the moment of maximum context, rather than a batch job guessing later.
- **Nudged, not automated** (Hermes's "periodic nudges"): curation reminders live in the composed standing instructions and in the workstream-close prompt. No background consolidation daemon in v1 — the agent curates at moments of maximum context, or a human edits directly.
- **Injected with provenance**: recalled memory enters context in a labelled block ("recalled memory, not new input") — the same labelling discipline applied to inter-agent messages (04), and the same one Hermes uses for its `<memory-context>` injection.

### Procedural memory: skills (borrowed from Hermes)

Facts answer "what"; skills answer "how". An agent that debugged a gnarly CI pipeline should keep the *procedure*, not just a note that it happened.

- Each agent owns `agents/<id>/skills/<skill-name>/SKILL.md` — name, description, when-to-use frontmatter + procedure body, following the **agentskills.io** open standard (also Claude Code's native skill format, so the reference adapter wires an agent's skills directory straight into the engine at zero marginal cost; other engines get the skills index injected into composed context like the memory index).
- **Creation is agent-curated, same as memory**: the workstream-close distillation prompt asks "did you develop a reusable procedure worth keeping?" — a skill is just a memory file with a *procedure* shape. No autonomous background skill-mining in v1.
- **Skills self-improve during use**: standing instructions tell the agent that when a skill misleads it, it fixes the skill in the same run. Git versioning makes every revision diffable; the human can edit or delete any skill (mentoring covers procedures, not just charters).
- **Usage is observable**: skill reads/edits surface through tool events (capability-dependent) onto the event log — which is all a Hermes-style "learning graph" needs later; the visualisation is a deferred projection, not new data (08, Future Evolution).

### Episodic recall: FTS over history

SQLite ships FTS5; we already persist transcripts, run results, messages, and workstream goals. V1 maintains an FTS index over them and exposes one org-tool, `search_history` (policy-scoped: an agent searches its own history; team/org scope per policy). "Have I solved this before?" becomes a tool call rather than a re-derivation — the single cheapest cross-workstream recall mechanism available to us, and Hermes's FTS5 session search validates the pattern in production. Results carry refs (workstream/run ids), so recall is auditable like everything else.

### The interface seam

Everything above sits behind a deliberately small interface used by context composition — effectively `getMemoryContext(agent, hints) → text` (memory index + skills index + paths) plus the `search_history` tool. A future backend (retrieval, embeddings, shared team memory, consolidation) replaces the implementation without touching the runtime, adapters, or UI. Shared/team memory is explicitly deferred: cross-agent memory is where poisoning and staleness risks concentrate, and `discovery` messages (04) already cover the "tell everyone" case with provenance attached.
