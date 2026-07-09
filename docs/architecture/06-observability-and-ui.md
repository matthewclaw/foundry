# 06 — Observability Architecture and UI Philosophy

## Observability Architecture

The brief calls observability "the single most important requirement." Foundry's answer is structural, not a feature: **the event log is the system** (01, decision 3). Observability isn't instrumentation bolted onto behaviour — behaviour that doesn't emit events cannot occur, because the only write path emits them.

### The three questions

Every observability surface exists to answer one of:

1. **What needs me?** → the Inbox (ranked attention queue)
2. **Is everything healthy?** → the Org view (roll-ups + exceptions)
3. **What exactly happened / why?** → drill-downs (timelines, trees, audit)

Any proposed panel that doesn't serve one of these is decoration and gets cut (brief: "challenge dashboard conventions").

### Derived signals (no fake vitals — challenge C4)

| Signal | Derivation | Surfaces |
|---|---|---|
| Agent status | Doc 02 table (blocked > degraded > waiting > active > over-committed > idle) | Org view badge, agent page |
| Progress | Task states in the tree + latest `status` message + run cadence | Tree view, task cards |
| Stalled | No events on an `active` workstream for N minutes | Runtime flag → inbox on repeat |
| Burn | `usage_delta` events vs budget, per run/workstream/task/tree | Meters everywhere budgets exist |
| Degraded | Consecutive run failures per agent | Org view, inbox on threshold |
| Comm debt | Open dispositions (unanswered questions, unreviewed requests) and their age | Agent page, inbox on expiry |
| Anomalies | Rule-based v1: budget >80%/100%, depth-cap hits, thread round-cap hits, crash loops, routing failures | Inbox |

Every signal is clickable through to the events that produced it — a badge you can't explain is a badge users learn to ignore.

### Cost accounting

Cost is a first-class organisational signal, not a billing afterthought: per run → workstream → task → delegation tree → agent → team → org, all sums over `usage_delta` events. The delegation tree with per-node spend answers "where did that $40 go" exactly the way "who did what" is answered — same tree, different weight. Engines without the `usage` capability show *unreported* (visibly, per 03's degrade-honestly rule).

---

## UI Philosophy

### Principles

1. **Attention over information** (challenge C5). The scarce resource is human attention. Every screen is ranked by "what needs you", not sorted by recency. Maximum understanding, not maximum data (brief, Cognitive Load).
2. **Agents are the navigation objects** — the brief's requirement, honoured literally: the left rail is the organisation (teams → agents), not a file tree, not a session list.
3. **Exception-first roll-ups.** A team is as healthy as its worst member; a tree as its worst node. Healthy things collapse to a single calm line; problems auto-expand. Twenty idle agents should cost the eye one glance.
4. **Everything explains itself.** Status badges, meters, and rankings link to their producing events. Trust through understanding is a UI property too.
5. **Calm by default.** Idle is grey and quiet, not a wall of green checkmarks. The morning glance at a healthy org should take five seconds.

### Surfaces

Five, and resisting more:

**Inbox** — the home screen. Escalations, approvals, reviews for the human, deliverables awaiting acceptance, expiries, anomalies — ranked by severity then age, each with inline actions (answer, grant/deny, accept/reject, reassign) so most items resolve without navigation. Empty inbox = nothing needs you = the product's healthy state.

**Org view** — teams and agents with status badges, one-line "currently: …" per non-idle agent (derived from its active workstream title + latest status), burn sparklines. Exceptions expanded, healthy teams collapsed.

**Agent page** — the specialist's profile: identity, charter (editable, versioned), status with explanation, open workstreams, open dispositions, memory and skills (browsable/editable, per 05), relationships (projected, per 02), history (closed work, reviews given/received), engine binding + its observability grade, cost trend.

**Workstream view** — the deep-dive: goal, state, budget meter, and the **run timeline** — runs as collapsed cards (trigger → summary → outcome → cost) expanding to the normalized event stream (tool calls, output, reasoning summaries) at the engine's capability grade; thread panel alongside; artifacts (diffs rendered properly); a redirect composer. This is where the human reads *how* an agent works — supervision, not surveillance.

**Delegation tree view** — any task's tree: nodes with assignee, status, spend/budget, age; open dispositions on edges; path-to-escalation highlighted; cancel/reassign/raise-budget on nodes. The brief's delegation checklist is this one screen.

### What is deliberately absent

- **No terminal emulator.** Runs are supervised through timelines; the workspace is on disk for the rare shell need. Embedding terminals would recreate "a collection of terminal sessions" — the thing the brief exists to escape.
- **No file editor.** Foundry is not an IDE (charter, explicitly). Artifacts render read-only; "open in editor" hands off to the user's own tools.
- **No chat-first layout.** Conversation composers exist inside workstreams, but the app's shape is org → agent → work, not a messenger with a sidebar.
- **No wall-of-charts dashboard.** Metrics appear where decisions happen (meters on trees, sparklines on agents), not on a grafana-cosplay page.

### Realtime

The UI is a projection of the event feed: subscribe from last-seen `seq`, patch views incrementally, reconcile on reconnect (05). No polling, no bespoke push channels per feature — new UI features consume the same feed, which keeps observability honest: if the feed can't power the UI, the log is missing events, and that's a store bug by definition.
