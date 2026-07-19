# Foundry

A control plane for persistent AI specialists — a monorepo (pnpm workspaces, `packages/@foundry/*`) that treats AI agents as durable organizational entities (identity, charter, memory, relationships, history) rather than disposable terminal sessions. Work happens in **workstreams** (long-lived threads of intent), executed as ephemeral, resumable **runs** by interchangeable **execution engines** behind a narrow adapter contract. Every organizational act — delegating, escalating, requesting review, reporting completion — is an explicit, audited event, so the whole organization is observable by construction.

This document describes what's actually built and running today. For the original design rationale and the full planning history, see [`docs/`](docs/) (architecture docs, ADRs, roadmap) — those were written *before* implementation, as a brief to an AI architect (`foundation/FABLE_ARCHITECT_BRIEF.md`), and mostly still hold, but this file is the accurate, current-state description. For a walkthrough of actually *using* the product, see [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md).

## Status

The original 12-epic roadmap (`docs/implementation/roadmap.md`, E1–E12) is complete and merged to `main`: domain model, store, adapter contract, runtime, control-plane server, org-tools/policy engine, UI, delegation + agent-to-agent communication, the real Claude Code adapter, inbox/cost/delegation-tree views, memory/skills persistence, and an end-to-end release-gate test suite (`packages/server/src/e2e-success-tests.test.ts`).

Since then (uncommitted/branch work, see `git branch`/`git status`): a browser for Claude Code's own on-disk session transcripts, live "drop-in" interactive sessions (attach to a running conversation over a WebSocket instead of only queuing headless replies), team rename/delete, and a full UI restyle to a dark terminal aesthetic.

**Known gaps** (see `docs/implementation/OPEN_ISSUES.md` for the full list):
- Workstream/task budget spend is never actually updated from real token usage (`OPEN_ISSUES #39`) — the cost view reports creation-time budgets, not live spend.
- Claude Code's permission-hook → approval wiring is scoped but not implemented (`#38`) — approvals work for org-tool `request_approval` calls, not engine-level tool permission prompts.
- Native skill loading/display is not wired end-to-end (`#40`).
- Task **handover** (re-parenting a task to a different agent) is explicitly not built — only cancellation cascades.
- Only agent-initiated delegation exists (`delegate_task` org-tool); a human can't directly create a root task via the API — only via a workstream message to an agent, who then delegates.
- No auth — this is a local, single-human-operator tool (`OPEN_ISSUES #32`).

## Architecture

Four layers, enforced by `.dependency-cruiser.cjs` (a package may only depend on layers below it — checked in CI):

```
L0  core            domain types, Zod schemas, event catalogue, state machines — no I/O
L1  store            SQLite (WAL) + adapter-api   — persistence, contracts
L2  runtime           adapter-fake, adapter-claude-code   — scheduling, execution
L3  server                                          — HTTP + SSE API, composition root
L4  ui, cli                                          — nothing above depends on these
```

| Package | What it is |
|---|---|
| [`@foundry/core`](packages/core) | Entity types, Zod schemas, the frozen event catalogue (~51 event types), branded ULIDs, state-machine transition tables. No I/O, zero runtime deps beyond `zod`/`ulid`. |
| [`@foundry/store`](packages/store) | SQLite (WAL mode), migrations, one atomic `mutate()` as the *only* write path (every state change appends its event — enforced, not just convention), per-entity queries, the event feed, projections (org view, cost rollup, inbox). |
| [`@foundry/adapter-api`](packages/adapter-api) | The `ExecutionAdapter` contract every engine implements (`start`, `resume?`, `attachInteractive?`, `cancel`, `events`, `capabilities`), plus `describeAdapterContract` — a shared conformance test suite every adapter must pass. This is the one place engine-specific behavior is allowed to be gated, via opt-in `CapabilitySet` flags. |
| [`@foundry/adapter-fake`](packages/adapter-fake) | A scripted adapter that plays back JSON scenario files deterministically at zero token cost — a first-class product component (used for the whole test suite and for demoing the product without a paid engine), not test scaffolding. |
| [`@foundry/adapter-claude-code`](packages/adapter-claude-code) | The real engine: drives the `claude` CLI headlessly via `--input-format stream-json --output-format stream-json`. Also backs live "drop-in" interactive sessions (same NDJSON line-mapper, a persistent process instead of one-shot). |
| [`@foundry/runtime`](packages/runtime) | The run queue/scheduler, the run supervisor (folds engine events into store writes — the single place `EngineEvent → Run state/event log` translation happens, reused by both headless and interactive paths), the workspace manager (git worktrees or plain directories), startup reconciliation (pid sweep after a control-plane restart). |
| [`@foundry/server`](packages/server) | Fastify HTTP + SSE API, context composition (assembles what an engine run actually sees), org-tools (the tool surface agents call back into the control plane with: `delegate_task`, `send_message`, `escalate`, `request_approval`, etc.), policy engine (budget/depth/rejection caps), the startup composition root. |
| [`@foundry/ui`](packages/ui) | React + Vite + Tailwind SPA: organization view, agent pages, workstream/conversation view, inbox, cost view, delegation tree, Claude session browser. |
| [`@foundry/cli`](packages/cli) | `foundry init` / `daemon start|stop` / `agent create` / `backup`. Thin — most interaction happens through the UI or the HTTP API directly. |

### The core ideas worth understanding before changing anything

- **Agents are durable, conversations are disposable.** An `Agent` is a record (identity, charter, memory ref, engine binding) that outlives any single run. A `Workstream` is a long-lived thread of intent against one agent; a `Run` is one execution attempt (queued → starting → running → completed/failed/awaiting_input/…) that may be resumed by a later run sharing its `engine_session_id`.
- **Everything is audited by construction.** `store.mutate()` is the only write path in the whole system; every state transition appends its catalogue event in the same transaction. The event feed (SSE) and every UI view are projections of that log, not a separate source of truth. (Two narrow, documented exceptions: teams and threads carry no catalogue events at all — they're "labels with defaults," contracts.md's own phrase — not domain state, see `OPEN_ISSUES #17`.)
- **Engine-agnostic by construction.** `packages/runtime` and `packages/server` never import `adapter-claude-code` directly — they only ever call through whatever adapter is registered for an agent's `engine.id`, gated on `capabilities()`. Claude Code is the only real engine today; adding another means implementing `ExecutionAdapter` and passing the shared conformance suite, nothing else in the codebase changes.
- **State machines are enforced, not advisory.** Agent, Workstream, Run, Task, and Message-disposition all have explicit transition tables (`@foundry/core/state-machines`) with property tests proving `canTransition` agrees with the declared graph over the full state space. An illegal transition throws (`InvalidTransitionError`), it doesn't silently happen.
- **Policy is enforced centrally.** Budget conservation (a child task's budget can never exceed what's left of its parent's), delegation depth caps, thread round caps (anti-ping-pong), and rejection caps (escalate to a human rather than looping forever) all live in one policy engine (`packages/server/src/policy`), not scattered per-call-site.

## Running it

```sh
pnpm install
pnpm run build   # builds every package in dependency order
pnpm run test    # ~400+ tests across the workspace
pnpm run lint:deps   # enforces the layer-direction rule above
```

Start the control plane and create your first agent:

```sh
foundry init --dir ./.foundry
foundry daemon start --dir ./.foundry
foundry agent create --name "Orbit" --role "Backend Engineer" \
  --charter "# Orbit\n\nYou fix bugs." --engine fake --dir ./.foundry
```

Then either use the HTTP API directly (see `docs/implementation/contracts.md`) or run the UI:

```sh
pnpm --filter @foundry/ui dev   # vite dev server, proxies /api to the daemon (default :4180)
```

See [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) for what to actually do once it's running, and `docs/implementation/quickstart.md` for a from-scratch CLI walkthrough (note: written before the real engine/UI merged to `main` — the "what's not here yet" section there is now stale; this README supersedes it on that point).

## Where things are documented

- **`docs/architecture/`** — the original 8-document architecture (executive summary, domain model, system architecture, communication/delegation, data/persistence, observability/UI, security/failure/scale, technology tradeoffs). Written as a design brief before implementation; still the best explanation of *why* the system is shaped this way.
- **`docs/implementation/`** — `contracts.md` (repo structure, API/data/component contracts — the actual source of truth for shapes), `adrs.md` (architecture decision records), `roadmap.md` (the epic/story breakdown implementation followed), `OPEN_ISSUES.md` (every place implementation deviated from or filled a gap in the docs, with the reasoning — read this before assuming a doc is still accurate).
- **`SUMMARY-E*.md`** (repo root) — a completion report per epic: what was built, what was delegated to sub-agents vs. built directly, and — notably — every real bug found in review before merging. Useful for understanding *how* this was built (heavy use of parallel sub-agent delegation with mandatory line-by-line review) as much as *what*.
- **`foundation/`** — the original commission brief and project charter given to the architect (Fable) before any of this existed.
