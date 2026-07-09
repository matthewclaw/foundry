# 04 — Communication Architecture and Delegation Model

## Design position

The brief says: *"Do not simply build chat. Design communication."* Taken further (challenge C3): between agents, chat is actively harmful — unbounded token cost, low signal, and an injection vector. ADE's communication layer is therefore built from three commitments:

1. **Every message is typed** from a closed set, with a schema and a required disposition.
2. **Every message routes through the control plane** — agents hold no direct channels; policy and budgets apply at the boundary; everything is an event.
3. **The human can always see everything**, and specific types are *pushed* to the human, not merely visible.

Communication here is closer to Linear issues + code-review requests than to Slack — deliberately.

---

## Message types

| Type | From → To | Disposition (what must eventually happen) | Pushed to human? |
|---|---|---|---|
| `question` | agent → actor | `answered` \| `withdrawn` \| `expired` | On expiry or if addressed to human |
| `answer` | actor → agent | closes the question; schedules the asker's next run | No |
| `review_request` | actor → actor | `reviewed` \| `declined` \| `expired` | If addressed to human |
| `review` | actor → actor | closes the request; verdict: `approve` \| `request_changes` + body | Summarised |
| `proposal` | agent → actor | `accepted` \| `rejected` \| `expired` — "I think we should X instead of Y" | If addressed to human |
| `status` | agent → delegator | none (informational; feeds progress views) | No |
| `discovery` | agent → team/org | none ("found a bug in shared lib X") — lands in a browsable feed, optionally into recipients' next-run context | Digest |
| `escalation` | agent → delegator chain + human | `resolved` — always | **Always, immediately** |
| `handover` | agent → agent | `accepted` — transfers a workstream/task with a structured context summary | Notified |
| `completion` | agent → delegator | acceptance decision (part of task flow below) | If human is delegator |
| `redirect` | human/delegator → agent | injected into next run — "change course: …" | n/a (usually from human) |

Closed set, versioned schema. New types are a contract change (implementation/contracts.md), not a runtime option — the value of typed communication collapses the moment types proliferate ad hoc.

### Dispositions make silence visible

A `question` without an `answer` is an **open disposition** — it appears on both agents' pages, ages visibly, and expires per policy (default 48h) into the human inbox. Nothing "falls through the cracks" because unresolved communication is a first-class, queryable state, not an unread bubble. This single mechanism covers most of the brief's supervision worries.

### Threads

Messages group into threads anchored to a task or workstream. A thread is context, not a chat room: when a run is composed for an agent, open threads addressed to it are included. Per-thread policy caps rounds between two agents (default: 4 agent-to-agent messages per thread without human interaction, then the thread auto-escalates as "we're going back and forth"). This is the anti-token-burn circuit breaker, and the honest v1 answer to "agents debating designs": bounded rounds, then a human tiebreak.

### Provenance and trust

Every message carries provenance (author actor, originating run). Composed into another agent's context, it is wrapped and labelled as **untrusted input from `<agent>`** — instructions inside it do not carry the authority of the delegator or the human. Policy defines who may `redirect` whom (default: only your delegator or the human can redirect you). This is the prompt-injection stance for inter-agent traffic (more in 07).

---

## The human's position

- **Visibility**: there is no agent-to-agent traffic tier the human cannot read (charter principle: delegation increases transparency).
- **Push, not poll**: `escalation` always; expiries, budget breaches, routing failures, review requests addressed to the human — all into the inbox, ranked (06).
- **Digest, not noise**: `status` and `discovery` never interrupt; they aggregate into agent pages and a daily-digest view. Optimise for understanding, not information (brief, Cognitive Load).
- **Redirect as a first-class act**: the human steering an in-flight workstream is a `redirect` message — recorded, attributed, injected into the next run. Mentoring, correcting, and re-prioritising all reduce to this one mechanism plus charter edits.

---

## Delegation Model

Delegation is the mechanism that builds the dynamic tree (challenge C2). Design goals, straight from the charter: never invisible, never unbounded, always attributable.

### The delegation flow

```
 delegator run                     control plane                     assignee
──────────────                    ───────────────                   ─────────
delegate_task(spec, ac,   ──►  policy checks: depth ≤ max,
  budget, assignee|route)       budget ⊆ parent remaining,
                                assignee eligible & active
                                     │ ok
                                create Task(pending)
                                create Workstream(origin=task)
                                schedule run(trigger=task_assigned) ──►  run starts with
                                     │                                   task spec + AC
                                     │                                   in context
                                     ▼                                      │
                                Task: in_progress   ◄────────  (first run starts)
                                     │                                      │
                                     │              ◄── update_task(...) ───┤ progress/blocked
                                     │              ◄── delegate_task(...) ─┤ sub-delegation (same flow, depth+1)
                                     │              ◄── escalate(...) ──────┤
                                     │                                      │
                                Task: delivered     ◄── deliver_task(refs)─┘
                                     │
                        delegator's next run gets the
                        deliverable + AC in context
                                     │
                          accept ────┴──── reject(reason)
                            │                 │
                        Task: done      back to assignee (attempt N+1,
                                        capped; then auto-escalate)
```

### Rules that keep the tree honest

- **Budget conservation**: a child task's budget is carved from the parent's *remaining* budget at creation. Sum of children ≤ parent, recursively — so the root budget is a true ceiling on the whole tree, enforced structurally rather than by monitoring. Budget exhaustion mid-task → run is cut off at the cap, task auto-blocks with `budget_exhausted`, escalation fires; raising a budget is an approval (human or delegator per policy). Agents can *request* more; they can never *take* more.
- **Depth cap**: default 3. Sub-delegation beyond it fails inside the delegator's run with a clear error; the correct move (escalate or do it yourself) is in the error text. Prevents runaway recursive spawning by construction.
- **Acceptance is explicit**: no task silently completes. The delegator accepts or rejects against the acceptance criteria it wrote. Roots delegated by the human are accepted by the human. This is **delegated acceptance**: the human reviews one deliverable at the root; agents review their own subordinates — the attention-scaling mechanism (challenge C5). Policy can additionally require human acceptance anywhere (e.g. "anything touching `main`").
- **Acceptance criteria are mandatory** at delegation time. `delegate_task` without checkable AC is rejected at the API. Vague delegation is the root cause of most multi-agent garbage output; the schema simply refuses it. (This constrains agents *and* humans — deliberately.)
- **Cancellation cascades transparently**: cancelling a task cancels its subtree — every affected assignee's workstream is closed with a `cancelled` event and notification; in-flight runs are cancelled. Nothing just disappears.
- **Routing is recorded**: spec-addressed tasks keep both the spec and the resolution (02), so "why did the Testing agent get this?" is answerable.

### What the human sees

Any task opens the **delegation tree view** (06): the tree with per-node status, spend vs budget, age, and open dispositions; the path from root to any escalation highlighted. The brief's checklist — who delegated, who received, status, dependencies, progress, results — is one view over task rows and events, because the model was shaped so that this view needs no inference.

### Handover

Reassignment (agent overloaded, suspended, retiring, wrong specialist) is a `handover` message carrying a structured context summary (state of work, decisions taken, open questions, artifact refs) plus the workstream/task reference. The receiver's acceptance re-parents the work; events preserve the chain of custody. Handover summaries are the one place v1 *requires* an agent to author prose-for-another-agent, and the schema requires its sections rather than trusting free text.
