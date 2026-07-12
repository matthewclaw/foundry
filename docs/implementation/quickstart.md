# Quickstart

Everything below was run live against a real build of this repo (Node 18+, `pnpm install && pnpm run build` from the repo root first) from a directory outside the repo, exactly as a fresh machine would. This branch (`phase-2/org-tools`) only wires the **fake** engine adapter into the daemon (`packages/server/src/daemon.ts`) — a real engine (Claude Code) is a separate adapter package on another branch; everything here demonstrates the full control-plane lifecycle against the fake engine, which is enough to prove the product end to end (doc-01's charter demo doesn't require a paid engine to validate the architecture).

## 1. Initialize a data directory

```sh
foundry init --dir ./.foundry
```

Creates `./.foundry/foundry.config.json` (default `{"port": 4180, "host": "127.0.0.1"}`) and prints the resolved data directory path.

## 2. Start the daemon

```sh
foundry daemon start --dir ./.foundry
```

Spawns the control-plane server detached, writes `./.foundry/daemon.pid`, and prints the bound address (e.g. `http://127.0.0.1:4180`) once the health check passes.

Verify it's up:

```sh
curl http://127.0.0.1:4180/api/health
# {"ok":true}
```

## 3. Create an agent

```sh
foundry agent create --name "Orbit" --role "Backend Engineer" \
  --charter "# Orbit

You fix bugs." \
  --engine fake --dir ./.foundry
```

Prints the new agent's id (a ULID). The agent starts `active` immediately (create + activate is one step today).

## 4. Give it work

The CLI doesn't wrap workstream/message creation yet (`foundry` only has `init`/`daemon`/`agent`/`backup`) — talk to the API directly for this part:

```sh
AGENT_ID=<id from step 3>

WS_ID=$(curl -s -X POST http://127.0.0.1:4180/api/workstreams \
  -H "Content-Type: application/json" \
  -d "{\"agent_id\":\"$AGENT_ID\",\"title\":\"Fix the bug\",\"goal_md\":\"Investigate and fix issue #1\",\"origin\":\"human\",\"budget\":{\"limit_usd\":null,\"limit_tokens\":null,\"spent_usd\":0,\"spent_tokens\":0}}" \
  | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).id")

curl -s -X POST "http://127.0.0.1:4180/api/workstreams/$WS_ID/messages" \
  -H "Content-Type: application/json" \
  -d '{"kind":"redirect","body_md":"please start"}'
```

This schedules a run against the fake adapter's default `happy-path` scenario, which completes in milliseconds.

## 5. Watch it work

```sh
curl -s "http://127.0.0.1:4180/api/workstreams/$WS_ID/timeline" | node -pe "JSON.stringify(JSON.parse(require('fs').readFileSync(0,'utf8')), null, 2)"
```

Shows the run's full event trail (`run_queued` → `run_started` → `run_running` → `run_completed`) and the transcript text. For a live-updating view, connect to `GET /api/events?after=0` (SSE) instead of polling the timeline.

## 6. Back up and stop

```sh
foundry backup --dest ./backup.tar --dir ./.foundry
foundry daemon stop --dir ./.foundry
```

`backup` writes a single portable archive (content-addressed artifacts + the SQLite database); `daemon stop` sends `SIGTERM` and waits (up to 5s) for a clean shutdown.

## What's not here yet

- **A real engine.** This branch's daemon composition root only registers the fake adapter. The Claude Code adapter (`packages/adapter-claude-code`) lives on a separate branch (`phase-2/claude-code`) and isn't merged into this one — swap it in via `daemon.ts`'s adapter registry once it lands.
- **CLI wrappers for workstreams/messages/delegation.** Steps 4–5 above go straight to the HTTP API; a `foundry workstream ...`/`foundry message ...` convenience layer doesn't exist yet.
- **The UI.** `phase-2/ui` is a separate, unmerged branch with the org view, inbox, cost, and delegation-tree pages described in `docs/architecture/06-observability-and-ui.md`.

## Adapter-author guide (the short version)

To add a new engine, implement `@foundry/adapter-api`'s `ExecutionAdapter` interface (`start`, `resume?`, `cancel`, `events`, `capabilities`) and pass `describeAdapterContract` (the conformance suite in `packages/adapter-api/src/conformance.ts`) against your adapter — see `packages/adapter-fake` for the reference implementation and `packages/adapter-claude-code` (on `phase-2/claude-code`) for a real-CLI-backed one. `capabilities()` must be honest: an undeclared capability must never emit its corresponding `EngineEvent` type (verified by the conformance suite), and every event is schema-validated at ingest (`EngineEventSchema.safeParse`) — a malformed event fails the run safely rather than corrupting other state. Register the adapter under an engine id in whatever composes the server (`daemon.ts`'s `adapters` map, or your own composition root); nothing outside your adapter's own package needs to change.
