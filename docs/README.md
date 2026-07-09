# ADE Architecture Documents

Working name: **ADE** — *Agent Development Environment* (after the repository name; rename freely, nothing binds to it).

These documents are the response to [`foundation/FABLE_ARCHITECT_BRIEF.md`](../foundation/FABLE_ARCHITECT_BRIEF.md) and are governed by [`foundation/PROJECT_CHARTER.md`](../foundation/PROJECT_CHARTER.md).

## How to read

Read `architecture/01` first — it contains the executive summary **and the challenges to the charter**, which explain every deviation the later documents make from the brief.

| Doc | Contents |
|---|---|
| [architecture/01-executive-summary.md](architecture/01-executive-summary.md) | Executive summary, design philosophy, system vision, challenges to the charter |
| [architecture/02-domain-model.md](architecture/02-domain-model.md) | Core concepts, domain model, agent lifecycle, organisation model |
| [architecture/03-system-architecture.md](architecture/03-system-architecture.md) | Layers, control plane, runtime, execution adapters, plugin architecture |
| [architecture/04-communication-and-delegation.md](architecture/04-communication-and-delegation.md) | Communication architecture, delegation model |
| [architecture/05-data-and-persistence.md](architecture/05-data-and-persistence.md) | Data model, persistence strategy, memory |
| [architecture/06-observability-and-ui.md](architecture/06-observability-and-ui.md) | Observability architecture, UI philosophy |
| [architecture/07-security-failure-scale.md](architecture/07-security-failure-scale.md) | Security, failure modes, scalability |
| [architecture/08-technology-tradeoffs-risks.md](architecture/08-technology-tradeoffs-risks.md) | Technology recommendations, trade-offs, risks, open questions, future evolution |
| [implementation/adrs.md](implementation/adrs.md) | Architecture Decision Records |
| [implementation/contracts.md](implementation/contracts.md) | Repository structure, component/API/data contracts, testing strategy |
| [implementation/roadmap.md](implementation/roadmap.md) | Epics, stories, tasks, acceptance criteria, dependency graph, implementation order |

## The one-paragraph version

ADE is a control plane for persistent AI specialists. An **agent** is a durable record — identity, charter, memory, relationships, history — never a process. Work happens in **workstreams** (long-lived threads of intent) executed as ephemeral, resumable **runs** by interchangeable **execution engines** (Claude Code first) behind a narrow adapter contract. Every organisational act — delegating, escalating, requesting review, reporting completion — is an explicit tool call the engine makes back into the control plane, which makes the whole organisation auditable by construction. State lives in SQLite with an append-only event log beside it; the UI is a projection of that log, organised around a human attention queue rather than dashboards, because the scarce resource in an AI organisation is human attention, not compute.
