# 07 — Security, Failure Modes, Scalability

## Security Considerations

V1 threat model honestly stated: a **single-user, local-first** tool whose real risks are (a) what agents can do to the user's machine and repos, (b) agents steering each other, and (c) cost blowout. Network-facing multi-user hardening is server-mode work (below), designed-for but not built.

### Trust boundaries

```
human ──trusts──► control plane ──constrains──► runs (engines)
                        ▲                          │
                        └── untrusted input ───────┘
agent messages ──── untrusted input ────► other agents' runs
external content (web, repos, deps) ──── untrusted ────► runs
```

1. **Human → control plane**: trusted. V1 auth is the local machine boundary (localhost bind, OS user). Server mode adds real authn/z on the same API.
2. **Control plane → run**: the run is a constrained worker. Its org-tools credential is scoped to (agent, run) and expires with the run (03). Its engine permissions come from Foundry policy translated to engine flags — the org/team/agent policy chain defines tool allowlists, permission mode, and which actions require approval. Engine permission prompts surface as Foundry approvals (claude-code adapter, 03).
3. **Agent → agent**: **untrusted, always** (challenge C3). Provenance-wrapped in context; `redirect` authority restricted to the delegator chain and the human (04); privilege boundaries (deploy, push to main, spend raises) can never be crossed on another agent's say-so — they require approvals.

### Prompt injection stance

Assume any run can be poisoned by content it read (a hostile repo README, a web page). Contained by:
- Poisoned output travels only through **typed, provenance-labelled messages** — it can lie, but it cannot impersonate, and it cannot instruct with authority.
- Organisational blast radius is policy-capped regardless of content: budgets, depth caps, tool allowlists, approval gates hold no matter what the model was talked into wanting.
- High-consequence acts are structurally human-gated (approvals), not model-judgment-gated.

Residual risk stated plainly: a poisoned agent can still waste its own budget and deliver bad work. Budgets bound the waste; acceptance criteria + review catch the work. There is no pretense of model-level injection immunity.

### Secrets

- Foundry never stores engine API keys; engines use their own auth (e.g. `claude` login).
- Event payloads and composed contexts are secret-redacted at write time via configurable patterns (belt-and-braces; the log is forever, so hygiene at the source).
- Workspace secrets (`.env` etc.) are governed by engine tool permissions, same as when a human runs the engine — Foundry adds the policy layer, it doesn't replace engine sandboxing.

### Audit

The event log *is* the audit trail: actor-attributed, append-only, complete (single write path). Charter principle 11's questions — why, who, what was known, who approved — map to indexed queries. V1 does not add tamper-evidence (hash-chaining); local-first means the attacker who can edit the DB owns the machine anyway. Server mode revisits this.

---

## Failure Modes

Design rule: **fail visible, fail bounded, recover explicitly.** Every mode below has a fake-adapter regression scenario (03).

| # | Failure | Detection | Response |
|---|---|---|---|
| F1 | Engine process crashes mid-run | Adapter stream ends abnormally | Run `interrupted`; auto-resume once (where `resume` capability); second failure → agent `degraded` + inbox item |
| F2 | Engine hangs (no events) | Stall watchdog (runtime) | Flag at N min; interrupt at policy cap; workstream `waiting` + inbox |
| F3 | Control plane crashes/restarts | Startup reconciliation | State is transactional (05): scan `running` runs → mark `interrupted`, re-queue queued work, resume watchdogs. The 01 success-test #1 |
| F4 | Runaway delegation | Structural | Depth cap + budget conservation make it impossible to *sustain*; cap-hit events surface repeated attempts |
| F5 | Message ping-pong between agents | Thread round-cap (04) | Auto-escalate thread to human at cap |
| F6 | Cost blowout | Budget meters on streamed usage; hard caps for engines without streaming usage via wall-clock + post-hoc | Cut off at cap → task `blocked(budget_exhausted)` → escalation. Org-wide daily cap as final backstop |
| F7 | Zombie/orphan engine processes | Supervisor tracks PIDs; startup sweep of pid-file registry | Kill + record; workspaces are per-workstream so orphans can't corrupt others |
| F8 | Workspace corruption / dirty worktree | Git status check pre-run | Run refused, workstream `blocked` with reason (never silently commit or clean) |
| F9 | Memory corruption / bad self-edits | Git-versioned memory (05) | Human diff/revert; charter edits versioned likewise |
| F10 | Poisoned agent output | (see Security) | Bounded by provenance, policy, acceptance |
| F11 | Routing failure (no eligible assignee) | Router | Inbox item with assign/create-specialist actions (02) |
| F12 | Rejected-work loop | `rejection_count` cap (02) | Auto-escalate to delegator's delegator / human |
| F13 | Event feed disconnect (UI) | seq gap | Reconnect replays from last seq (05); UI never trusts its cache over the log |
| F14 | SQLite contention/growth | WAL + single-writer discipline; compaction (05) | Documented limits below; growth is bounded by delta-compaction |
| F15 | Adapter bug emits malformed events | Schema validation at ingest | Run `failed(adapter_error)` — engine blamed correctly, not the org state corrupted |

The failure *posture*: nothing above loses organisational state, and nothing above is silent. The worst outcomes degrade one run or one workstream, produce an inbox item, and leave a complete event trail.

---

## Scalability Strategy

### The real axes (challenge C5)

| Axis | V1 comfortable limit | Binding constraint |
|---|---|---|
| Agents (rows) | Thousands | None — idle agents are free |
| Events | Tens of millions (with delta compaction) | SQLite file size/vacuum, years away at realistic volume |
| Concurrent runs | ~dozens per machine | Engine processes: RAM/CPU and **spend** — the cap is a cost control before it is a compute one |
| Humans | 1 (v1) | Attention mechanics, then multi-user auth |
| Attention | ~50 active workstreams per human | Inbox ranking, delegated acceptance, roll-ups — this is the ceiling that matters |

The design puts scaling effort where the ceiling actually is: attention mechanics ship in v1; distributed systems don't.

### Growth path (each step is packaging, not redesign — the seams already exist)

1. **V1 — local single-node.** One process, SQLite, local UI.
2. **Detached daemon.** Same process headless + UI connects over the existing API. (Trivial; likely v1.x.)
3. **Remote runners.** The adapter contract already isolates execution; a runner service executes runs on other machines/containers, streaming the same normalized events back. Control plane and store unchanged. This is the step that lifts concurrent-run limits.
4. **Server mode.** Multi-user: real authn/z on the API, humans as multiple actors (the domain model already treats humans as actors — 02), Postgres behind the store interface *if and when* SQLite's single-writer becomes the measured bottleneck. Audit hardening (hash-chained log) lands here.
5. **Federation** (speculative, see 08 Future Evolution): organisations of organisations.

What we refuse to build early: queues, brokers, microservices, Kubernetes-shaped anything. The charter's inspiration is Kubernetes' *conceptual* model (desired state, controllers, observability), not its deployment topology. A tool for supervising AI colleagues must itself stay small enough to trust.
