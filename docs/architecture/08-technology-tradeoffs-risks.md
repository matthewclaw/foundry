# 08 — Technology Recommendations, Trade-offs, Risks, Open Questions, Future Evolution

## Technology Recommendations

Bias: boring, single-language, zero-administration. Every choice below is replaceable behind a package boundary (charter principle 9), so these are defaults, not commitments.

| Layer | Choice | Why | Considered & rejected |
|---|---|---|---|
| Language | **TypeScript (Node ≥ 20)** everywhere | One language across control plane, adapters, UI, CLI ⇒ shared domain types end-to-end (the contracts are TS types + JSON Schema); the agent-tooling ecosystem (MCP SDK, Claude Agent SDK, engine CLIs) is TS-first; process-spawning + stream-parsing is Node's home turf | **Go** (better daemon ergonomics, but splits the codebase from the UI and the MCP/agent ecosystem); **Python** (weaker long-lived-daemon + UI story) |
| Store | **SQLite (WAL)** via `better-sqlite3`; hand-written migrations; no ORM | Zero-admin, transactional, single-file backup; synchronous API keeps the (state+event) transactional write discipline trivial | **Postgres** (operational burden contradicts local-first; behind the store seam for server mode); **ORMs** (the store *is* the product's contract — write the SQL) |
| API | **HTTP/JSON commands+queries, SSE event feed**, via Fastify | Boring, debuggable with curl, SSE auto-reconnect fits the replay-from-seq design | **GraphQL** (query flexibility is a non-goal; projections are purpose-built); **gRPC** (browser friction); **WebSocket** (SSE suffices for server→client; commands are HTTP anyway) |
| Schemas | **Zod** ⇒ JSON Schema for all contracts (events, messages, org-tools, API) | Single source of truth: runtime validation + static types + MCP tool schemas from one definition | Standalone JSON Schema (drifts from types) |
| Org-tools | **MCP server** (official TS SDK) + thin CLI shim | MCP is the emerging cross-engine standard; the shim covers engines without it (03) | Bespoke per-engine integration (defeats the point) |
| UI | **React + Vite**, local SPA served by the daemon; Tailwind; TanStack Query + the SSE feed | Mainstream ⇒ delegable to implementation agents; no SSR complexity for a local tool | **Electron/Tauri** (a browser tab is enough for v1; wrap later if desktop-app affordances are demanded); **htmx** (the timeline/tree views are genuinely stateful) |
| Process mgmt | Node `child_process` + pid registry + startup sweep | Sufficient for v1 supervision (07 F7) | External supervisors (deployment burden) |
| Monorepo | **pnpm workspaces** (+ turborepo if build times demand) | Standard, cheap | Nx (heavier than needed) |
| Testing | **Vitest**; contract tests + fake adapter as the backbone (implementation/contracts.md) | — | — |

Engine v1: **Claude Code** (richest observability surface — the reference adapter). Second adapter target: **Codex CLI**, chosen deliberately to *prove* replaceability, scheduled in the roadmap before 1.0 so the contract is validated by a real second implementation, not by faith.

## Trade-offs (accepted, eyes open)

| Decision | We gain | We give up / accept |
|---|---|---|
| Agent = record, run = ephemeral (ADR-001) | Free persistence, free idle agents, engine swap | No always-resident agent "presence"; agents act only when a run is scheduled — ambient/proactive behaviour needs schedules or triggers |
| State tables + event log, not event sourcing (ADR-002) | Simple store, simple queries | No replay-rebuild; projections must be right the first time |
| Typed messages, round-capped threads (ADR-004) | Bounded cost, auditability, injection containment | Less emergent agent-to-agent creativity; some legitimate long debates will hit the cap and pull a human in |
| Mandatory acceptance criteria on every task | Quality gate, reviewable delegation | Friction on quick informal delegation ("just have a look at…") — deliberate friction, but friction |
| Single-node local-first (ADR-005) | Zero-install trust, no infra | Concurrent-run ceiling of one machine until remote runners |
| SQLite | Zero admin | Single-writer; multi-user server needs the Postgres swap |
| Agent-curated file memory (ADR-007) | Transparent, editable, versioned, proven | No semantic retrieval at scale; memory quality depends on the agent's curation discipline |
| Serialized runs per workstream | No workspace/context races | A single workstream can't parallelise internally — the model's answer is *delegate*, which is the behaviour we want anyway |
| TypeScript | One language, ecosystem fit | Long-lived daemon in Node demands memory discipline (streams, not buffering transcripts) |
| No terminal/editor in UI | Product stays a control plane | Occasional friction when a human wants to poke a workspace — mitigated by "open in editor/terminal" handoffs |

## Risks

Ranked by (impact × likelihood), with mitigations already in the design:

1. **Engine interface instability.** Claude Code's CLI/stream format evolves under us. *Mitigation:* the adapter is the only package touching it; recorded-stream fixtures pin behaviour and break loudly in CI; normalized events insulate everything above. *Residual:* adapter maintenance is a permanent tax — staff it.
2. **The delegation-quality problem.** Agents write vague specs and rubber-stamp acceptances; the org produces confident garbage. This is the product's thesis risk, not a code risk. *Mitigation:* mandatory acceptance criteria, explicit acceptance, review messages, human acceptance at roots — but ultimately this needs iteration against real usage. Ship early to real work.
3. **Attention design misses.** If inbox ranking is wrong, the human drowns or tunes out and trust dies (charter's core metric). *Mitigation:* exception-first defaults, few surfaces, and treat every "I missed something important" as a P1 design bug during dogfood.
4. **Context composition quality.** Runs that get too little context do bad work; too much burns budget. *Mitigation:* recorded `input_context_ref` per run makes this empirically tunable; engine session-resume carries most continuity in v1.
5. **Cost surprform is a startup risk in disguise** — an org that quietly burns $500/day gets switched off. *Mitigation:* budgets are structural (04), org daily cap is a backstop, burn is a first-class signal (06).
6. **Scope gravity toward IDE/chat features.** Every user will ask for a terminal, an editor, a chat pane. *Mitigation:* the charter's "not building" list + this document set as the standing refusal; handoff affordances as the pressure valve.
7. **The fake adapter drifts from real engines.** Then tests pass and reality fails. *Mitigation:* contract-test suite runs against *both* fake and claude-code (recorded) adapters; divergence is a failing build, not a discovery in production.

## Open Questions (genuinely open — tracked, not decided)

1. **Proactivity.** Should agents wake themselves (schedules exist) to review their domains uninvited? Powerful and on-charter ("colleagues"), but cost and attention implications need dogfood data. V1: schedules are human-created only.
2. **Review protocol depth.** Is `review_request`/`review` with one verdict enough, or does code review need line-anchored comments as a first-class structure? Defer until reviews are happening for real.
3. **Charter/memory mentoring loop.** Should the system *suggest* charter and skill edits from observed behaviour ("this agent keeps being redirected about X")? Compelling, and Hermes-agent's background-review/curator components are working prior art (ADR-012 deliberately deferred them); needs our event corpus first.
4. **Workstream summarisation.** When engine sessions can't resume (engine swap, expiry), how good must the recomposed summary be? V1 uses run results + goal; may need a dedicated summarisation step.
5. **Cross-workstream awareness.** Should an agent's run know about its *other* open workstreams (risk: context bloat; benefit: self-consistency)? V1: index-level mention only.
6. **Multi-human semantics.** When server mode lands: who accepts root tasks, who owns an agent, what does "the human" mean in policy? The actor model carries the data; the *semantics* need design then.
7. **Naming.** "ADE" is a placeholder (and collides with the brief's inspiration list). Decide before anything public.

## Future Evolution

Sequenced sketches, each compatible with (and none required by) the current design:

- **Remote runners** (07 growth step 3) → fleets of execution machines under one org.
- **Server mode / teams of humans** → shared organisations; roles for humans (lead, reviewer, observer); the attention layer becomes per-human inboxes plus a team escalation policy.
- **Richer memory backends** behind the 05 seam: retrieval, consolidation runs, team memory with provenance.
- **Learning graph** (after Hermes): a visualisation of what each agent has actually learned — skills + memory nodes, edges from usage and relatedness — purely a projection over the event log and memory/skills dirs ADE already maintains; and background-review loops proposing charter/skill improvements (§OQ3).
- **Learned routing** (02): skill-based assignment from delegation history — the task/acceptance corpus is exactly the training signal.
- **Organisational analytics**: which specialists' work gets rejected, where budgets burn, which charters correlate with quality — engineering-management insight over the event log.
- **Agent mentoring agents**: senior agents reviewing juniors' deliverables routinely, charter-edit proposals — the charter's principle 6 grown up.
- **Cross-org federation**: an organisation delegating a task to another organisation over the same task/message contracts, budgets and provenance intact — the task schema is deliberately transport-agnostic to keep this door open.

The confidence claim, stated once: every one of these lands as *additions behind existing seams* — new adapters, new backends behind interfaces, new consumers of the event feed, new actors in existing tables. If one of them someday requires breaking a core contract, that contract was wrong and the ADR trail will show why we believed otherwise.
