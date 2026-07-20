---
name: foundry
description: Drive the running Foundry daemon over its HTTP API — create teams/agents/workstreams, send messages, kick off and watch runs, inspect org/inbox/cost, run org-tools, manage delegation. Use when developing or hands-on testing this repo's control plane, so you can make the daemon actually do things instead of only reading code.
---

# Driving the Foundry daemon

The daemon is a Fastify HTTP + SSE server. Everything a human does in the UI is a
call to `/api/*`. Use these to exercise the running system yourself: create agents,
give them work, kick off runs, and watch them.

Requests/responses are JSON; there's no auth (single-operator v1). Use the **Bash
tool** (Git Bash) so `curl` and `$VAR` work.

**`jq` is not installed here — `node` is.** Define this jq-free field extractor once
per shell session and pipe JSON through it (`| jget id`, `| jget runs.0.run.state`):

```bash
jget(){ node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{let o=JSON.parse(s);for(const k of (process.argv[1]||'').split('.').filter(Boolean))o=o?.[k];console.log(o&&typeof o==='object'?JSON.stringify(o,null,2):o)})" "$1"; }
```

## Base URL

The daemon writes its address to `<dataDir>/foundry.config.json` (`{ "port", "host" }`).
Default is `127.0.0.1:4180`. The active data dir in this environment is
`C:/repos/ade-tryit/.foundry`.

```bash
F=http://127.0.0.1:4180        # override if foundry.config.json says otherwise
curl -s $F/api/health          # -> {"ok":true}  (confirms it's up)
curl -s $F/api/org | jget teams   # nested: teams[].agents[]  (plus an unassigned bucket)
```

If health fails, the daemon isn't running — `node restart-daemon.mjs --dir C:/repos/ade-tryit/.foundry`
from the repo root rebuilds and restarts it. Any server-side code change needs that
restart to take effect.

## Endpoint map

| Method & path | What it does |
|---|---|
| `GET  /api/health` | liveness |
| `GET  /api/org` | whole org: teams, agents, states, spend (the left-rail/root view) |
| `GET  /api/inbox` | approvals + surfaced messages needing a human |
| `GET  /api/cost?scope=org\|agent:<id>` | budget/spend rollup |
| `GET  /api/agents/:id` | agent detail: charter, workstreams, open tasks, relationships |
| `POST /api/agents` | create an agent (active immediately) |
| `PATCH /api/agents/:id` | update charter/engine/name/role/team |
| `POST /api/agents/:id/{suspend,resume,retire}` | lifecycle |
| `POST /api/teams` · `PATCH /api/teams/:id` · `DELETE /api/teams/:id` | team CRUD |
| `POST /api/workstreams` | open a workstream against an agent |
| `GET  /api/workstreams/:id/timeline` | runs + events + conversation transcript (poll this to watch) |
| `POST /api/workstreams/:id/messages` | send a message → **enqueues a run**; returns `{message_id, run_id}` |
| `POST /api/workstreams/:id/close` | close (optional `distill` run first) — soft |
| `DELETE /api/workstreams/:id` | **hard delete** (housekeeping): cancels live runs, purges the workstream + its runs/events/artifacts/messages. 204. Irreversible |
| `POST /api/agents/:id/retire` | retire — soft delete (blocked if the agent has open tasks) |
| `DELETE /api/agents/:id` | **hard delete** (housekeeping): cancels live runs, purges the agent + its actor/workstreams/tasks/charters. 204. Irreversible |
| `POST /api/runs/:id/cancel` · `POST /api/runs/:id/title` | cancel / rename a run |
| `GET  /api/events` | SSE feed of everything (replayable via `?from_seq=`) |
| `GET  /api/tasks/:id/tree` | delegation tree for a task |
| `POST /api/tasks/:id/{accept,reject,cancel}` | human decision on a delegated task |
| `POST /api/org-tools/:tool` | the 13 org-tools (agents normally call these; needs a run token — see below) |
| `POST /api/backup` | snapshot the store |

## Core workflow — give an agent work and watch it run

Use the **`fake` engine** for free, scripted runs when you just want to exercise the
plumbing; use **`claude-code`** for the real thing (costs tokens).

```bash
F=http://127.0.0.1:4180
jget(){ node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{let o=JSON.parse(s);for(const k of (process.argv[1]||'').split('.').filter(Boolean))o=o?.[k];console.log(o&&typeof o==='object'?JSON.stringify(o,null,2):o)})" "$1"; }

# 1. (optional) a team
TEAM=$(curl -s $F/api/teams -H 'content-type: application/json' \
  -d '{"name":"Platform","description":"infra"}' | jget id)

# 2. an agent — charter_md is required; engine is {id} (+ optional config)
AGENT=$(curl -s $F/api/agents -H 'content-type: application/json' -d "{
  \"name\":\"Orbit\",
  \"role\":\"Backend Engineer\",
  \"team_id\":\"$TEAM\",
  \"charter_md\":\"Fix backend bugs. Escalate anything irreversible.\",
  \"engine\":{\"id\":\"fake\"}
}" | jget id)

# 3. a workstream (goal_md may be ""; budget optional; workspace_ref optional)
WS=$(curl -s $F/api/workstreams -H 'content-type: application/json' -d "{
  \"agent_id\":\"$AGENT\",
  \"title\":\"Bug #482 — timeouts\",
  \"goal_md\":\"Users see 504s on /export.\"
}" | jget id)

# 4. send a message — this enqueues a run
RUN=$(curl -s $F/api/workstreams/$WS/messages -H 'content-type: application/json' \
  -d '{"body_md":"Please reproduce the timeout and find the root cause."}' | jget run_id)

# 5. watch it: runs nest under .runs[].run — poll until state is completed/failed/needs_input
curl -s $F/api/workstreams/$WS/timeline | jget runs.0.run.state
curl -s $F/api/workstreams/$WS/timeline | jget runs.0.run.result   # {outcome, final_text, ...}
#   ...or stream the whole org live:
curl -Ns $F/api/events    # Ctrl-C to stop
```

Timeline shape: `{ workstreamId, workstream, runs: [{ run, events, transcriptText, transcriptSource }] }`.
`run.state` reaches `completed` / `failed` / `needs_input`; `run.result.final_text` is the reply.

### Real engine (`claude-code`)

Swap step 2's engine for `{"id":"claude-code","config":{...}}`. Config accepts
`model`, `maxTurns`, `permissionMode`, `allowedTools`/`disallowedTools` (see
`ClaudeCodeConfigSchema` in `packages/adapter-claude-code`). For a code workstream,
give step 3 a `workspace_ref`:

```jsonc
// isolated worktree (recommended — changes stay separate):
"workspace_ref":{"kind":"git_worktree","repo_path":"C:/some/repo","worktree_path":"C:/some/repo/.wt/ws","branch":"foundry/ws"}
// or work directly in a folder (edits land on real files):
"workspace_ref":{"kind":"plain_dir","path":"C:/some/repo"}
```

## Payload shapes (the required fields)

- **agent**: `name`, `role`, `charter_md`, `engine:{id}` — all required; `team_id`, `policy_overrides` optional.
- **workstream**: `agent_id`, `title`, `goal_md` — required; `budget` (partial: `limit_usd`/`limit_tokens`, or omit for uncapped), `workspace_ref` optional.
- **message**: `body_md` required; `kind:"message"|"redirect"` (default message), `resume` (default true — false forces a new conversation instead of continuing the session).
- **delegate a task** (via workstream message, the human path) vs the `delegate_task` org-tool (agent path): both need `title`, `spec_md`, `acceptance_criteria_md`, and exactly one of `assignee_agent_id` or `routing:{role|team_id}`.

## org-tools directly

`POST /api/org-tools/:tool` is the same surface agents reach through the
`foundry-org-tool` shim, but it needs a **per-run bearer token** (minted only while a
run is live, `Authorization: Bearer <token>`). You can't mint one out-of-band, so to
test delegation, drive an *agent* to call it (give it a task and let it run
`delegate_task`) rather than calling this endpoint yourself. `list_org`, `get_task`,
etc. are all under the same auth. Tools: `delegate_task`, `update_task`,
`deliver_task`, `accept_task`, `reject_task`, `cancel_task`, `send_message`,
`escalate`, `request_approval`, `search_history`, `get_task`, `get_thread`, `list_org`.

## Notes

- **Read before mutate.** `GET /api/org` first to see current agents/ids rather than creating duplicates.
- **State lives in SQLite** at `<dataDir>/foundry.db` — restarting the daemon preserves everything; it's not ephemeral.
- Timeline is the richest read: `.runs` (state/result), `.events` (tool calls, deltas), and the grouped transcript. Poll it, or use `/api/events` for push.
- ponytail: this is curl-against-documented-endpoints, no wrapper CLI. If a multi-step flow gets repetitive, a small helper script is the next rung — add it then, not now.
```
