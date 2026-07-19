# Foundry — User Guide

This is a walkthrough of using Foundry through its web UI, as it exists today. It's written for someone assessing the product's UX, not just its feature list — so alongside "what you can do," it notes where the experience is rough, inconsistent, or incomplete. It assumes the daemon is running and you're pointed at the UI (`pnpm --filter @foundry/ui dev`, proxying to the control-plane API).

## The mental model, in one paragraph

You don't open files. You open an organization. Down the left rail: a handful of system views (Inbox, Cost, Claude Sessions) and, below that, your **Organization** — teams, each containing **agents**. An agent is a persistent identity, not a session: it has a name, a role, a charter (its instructions, editable markdown), an engine binding, and a history that outlives any individual conversation. You give an agent work by opening (or creating) a **workstream** against it — a long-lived thread of intent — and the actual back-and-forth inside a workstream is organized into **conversations** (a conversation is a chain of runs sharing one underlying engine session; starting a genuinely new conversation deliberately does not resume the old one).

## The left rail

Three system-level views sit above your organization:

- **Inbox** — everything that needs a human right now, ranked by severity then age: approval requests first, then surfaced messages/escalations.
- **Cost** — org-wide spend and budget usage, USD and tokens, with a per-agent/workstream breakdown table.
- **Claude Sessions** — a browser over Claude Code's own on-disk session transcripts (grouped by the repo folder they ran in), independent of anything Foundry tracked — useful for finding a session that happened outside a Foundry-managed workstream.

Below that, your teams (collapsible sections) and their agents, plus an "Unassigned" bucket for agents with no team.

*Rough edge:* "Organization" isn't a separate persisted thing — the left rail's team list and the root `/` view are two renderings of the same `GET /api/org` aggregate. There's no dedicated "org settings" anywhere; team management (rename/delete) lives inline on the root Organization page, not in the nav.

## Organization view (`/`)

Teams render as collapsible sections; a team with only idle/active agents auto-collapses to one calm line, a team with anything blocked or degraded auto-expands and sorts those agents first — the "exception-first" principle: don't make the human hunt for what needs attention.

Each agent row shows a status badge (blocked > degraded > waiting > active > over-committed > idle, in that precedence), role, what it's "currently" doing if known, and spend.

- **+ New team** / **+ New agent** — inline forms at the top of the page. Creating an agent lets you pick a team (or leave unassigned), write a charter inline (defaults to a one-line stub if left blank), and choose an engine (`fake` — free, scripted, good for trying the product without cost; or `claude-code` — the real thing).
- **Rename a team** — the ✎ next to a team's name, inline edit, Save/Cancel.
- **Delete a team** — a "Delete" button on the team header, with a confirm prompt naming how many agents will be affected. Deleting a team does *not* delete its agents or their history — they just become Unassigned. This is deliberate (a team is a label, not a container), but it's not obvious from the button alone; the confirm text is the only place this is explained.

*Rough edge:* the same click target (the team header row) both expands/collapses the team and, if you're not careful, is right next to the Delete button — on a team with a short name and few badges, "Delete" can end up close to the click-to-expand hit area.

## Agent page (`/agents/:id`)

Header: name, status badge, role, engine. Below that:

- **Charter** — the agent's instructions as versioned markdown. Edit opens a textarea; Save creates a new version (old versions aren't shown in the UI, only that a version number incremented).
- **Workstreams** — every workstream this agent has, linked to its conversation view, with state. **+ New workstream** lets you give it a title, a goal, and optionally a working directory — either an isolated git worktree (recommended, changes stay separate until merged) or the folder directly with no isolation (the agent's edits land straight on your real files).
- **Open tasks** — tasks delegated to this agent that aren't done yet (from the delegation system — see below).
- **Relationships** — who this agent has interacted with and how often. Currently just a flat list of actor ids and interaction counts, no names resolved and no visual graph.

*Rough edge:* the "plain_dir, no isolation" workspace option writes directly to whatever real folder you point it at, with no additional warning beyond the one line of static help text under the checkbox. If you're an engine that can run arbitrary shell commands against your own source tree, this is worth being deliberate about.

## Workstream / conversation view (`/workstreams/:id`)

This is where you actually talk to an agent, and it's the most-iterated view in the product.

- Runs group into **conversation cards** by shared engine session — a chain of resumed runs is one card, not one card per message. Only the most recent conversation is "current" and gets the compose box; older conversations are collapsed by default (auto-expand if something in them is still live).
- Each conversation can be **renamed** (✎ next to its title) — otherwise it's titled from the first message, truncated.
- **Raw / Formatted** toggle per conversation: Raw shows every event in the run (tool calls, deltas) plus the transcript; Formatted collapses that to just tool-call summaries, token usage, and the response text as rendered markdown.
- **The compose box** (bottom of the current conversation): type and Send. What actually happens depends on whether you've "dropped in" (see below) — same box either way, so you don't have to think about it unless you want to.
- **Drop in / Exit live**: a toggle on any conversation with a resumable session (not just the current one). Not dropped in, Send POSTs a message that queues a brand-new headless run resuming that session — fire-and-forget, you can close the tab, the agent works through it as a normal budgeted job. Dropped in, you're attached to a live, persistent process over a WebSocket: lower latency (no cold-start per message), and you can send while the agent is still actively working, not just between turns — genuinely useful when a run is sitting paused on `awaiting_input`. Attaching briefly puts the workstream into a "waiting" state (visible elsewhere in the UI) and blocks a concurrent headless run on the same workstream from starting until you detach.
- **+ New conversation**: deliberately does *not* resume the existing session, even if one exists — a clean break, for when you want to start over rather than continue.
- Live runs stream their output in real time (a terminal-style block, cursor blink included) via the server-sent-events feed; the moment a run finishes, the authoritative transcript takes over.

*Rough edge, explicitly surfaced to the user during development and left as an open question:* the compose box and the drop-in toggle now look and behave almost identically from the outside — the real difference (spawn-per-message vs. one warm process, queued-only vs. can-interject-mid-turn) is invisible unless you already know it's there. Whether that distinction should stay an explicit, deliberate toggle (current behavior — attaching holds a live process and a lock, so it's not "free") or become an implicit background attach whenever you're viewing a live conversation is unresolved. Worth an opinion.

## Inbox (`/inbox`)

A flat, ranked list: approval requests (with inline Grant/Deny — Deny prompts for an optional reason via a native browser prompt, not an inline field) above surfaced messages, oldest first within each tier. Surfaced messages currently have no actions at all — they're read-only notices (the projection they're built from doesn't yet carry enough to support answer/accept/reject/reassign, so no buttons were faked in).

*Rough edge:* an inbox with only read-only items and no way to act on most of them (beyond approvals) reads as more of a notification log than an inbox, for anything that isn't an approval.

## Cost (`/cost`)

Org-wide USD and token spend against budget (stat blocks, "uncapped" shown explicitly when no limit is set), plus a breakdown table.

*Rough edge, and an important one:* the numbers here reflect each workstream's budget **as set at creation time**, not real usage — nothing in the runtime yet folds a run's actual token usage back into persisted spend (a known, tracked gap, not a UI bug). Cost is the single thing this system was explicitly designed to make legible, so this is the sharpest gap between the product's stated purpose and its current behavior.

## Delegation tree (`/tasks/:id/tree`)

A read-only, recursively indented tree of a task and its subtasks — status badges, budget meters, a red highlight on rejected/blocked nodes as the "something needs attention here" cue. Reached today only by following a link from wherever a task id shows up (there's no top-level "all tasks" or "all delegations" view); there's also no click-through from a tree node back to its workstream conversation, and no cancel/raise-budget actions from this view — it's purely observational.

## Claude Sessions (`/claude-sessions`)

Independent of the workstream model entirely: this reads Claude Code's own on-disk `~/.claude/projects/` session transcripts directly off disk, grouped by the repo folder each session ran in, so you can find and inspect a session even if it never went through a Foundry-tracked workstream. Includes a reveal-in-file-explorer action and an id-chip tooltip for the underlying session id.

## What's conspicuously not here

- **No agent-to-agent visualization.** Delegation, sub-agent hierarchies, and cross-team communication all exist and are enforced server-side (budget/depth/rejection/thread-round caps), but the UI's only window into any of it is the read-only task tree — there's no "who's talking to whom right now" view the original vision called for.
- **No settings/admin surface** beyond team rename/delete and per-agent charter editing. No policy editor, no engine config editor, no way to see or change an agent's default workspace from the UI.
- **No search.** `search_history` exists as an org-tool agents can call, and it's FTS5-backed server-side, but there's no UI for a human to search across the organization's history.
- **Single-human-operator only** — no accounts, no auth, no multi-user concept anywhere in the UI (this is a stated, deliberate v1 scope limit, not an oversight).

## For a UX pass specifically

The functional core (audited history, engine-agnostic execution, budget/policy enforcement) is solid and mostly invisible to the end user by design — which is arguably correct, but means the UI is currently just "CRUD forms + a chat view + a few read-only reports," not yet the "operating environment for an AI organization" the original brief described (org-chart-like navigation, at-a-glance organizational health, designed inter-agent communication surfaced to the human). The biggest gaps between vision and reality, in rough priority order for a UX overhaul: (1) cost/budget numbers not reflecting real spend, (2) no live "what is every agent doing right now" overview beyond the flat team/agent list, (3) delegation and inter-agent communication being real and audited but almost entirely invisible in the UI, (4) the drop-in/headless-reply distinction being real but not legible from the interface alone.
