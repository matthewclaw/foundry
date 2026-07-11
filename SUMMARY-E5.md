# Phase 1 — `@foundry/server` + `@foundry/cli` (Epic E5, complete)

Built on `phase-1/server` (stacked on `phase-1/runtime-reconcile` — merge that PR first).
All seven stories. 325 tests green across the workspace, dependency lint clean, and the
E5.7 smoke ran **live**: init → daemon start → agent create over HTTP → backup → stop.

## What's here

- **E5.1** `createServer` (Fastify 4 — Node 18 constraint), problem+json errors (Zod →
  400 with issues; `ProblemError` carries policy codes), health endpoint, startup
  orchestration migrate → reconcile → `system_started` → listen. Adapters injected;
  `src/daemon.ts` is the runnable composition root (registers the fake engine per
  ADR-010).
- **Runtime facade** (`@foundry/runtime` `createRuntime`) — closes OPEN_ISSUES #22/#26:
  `enqueue({workstreamId, trigger})` resolves agent/engine itself; workspace acquired
  per workstream before `adapter.start` (refusal cancels the run); context composed at
  execute time; `cancelRun` covers queued, mid-setup, and live runs; reconcile requeues
  via `RunQueue.restore`. Store gained `{run_id}`/`{agent_id}` token substitution (#29),
  `updateAgentCharter`, `rebindAgentEngine`, `getOrCreateHumanActor` (#32).
- **E5.2** agent routes: create (+immediate activate), PATCH charter/engine only (#31),
  suspend/resume/retire with the open-tasks retire block.
- **E5.3** workstream routes: create, human message → `sendMessage` + enqueue (E2E test:
  fake run reaches `completed`), close (+workspace release, #30), run cancel.
- **E5.4** queries mirror store projections 1:1 (org/inbox/agentPage/timeline/tree/cost).
- **E5.5** SSE feed with `after` replay — one mode-flipping subscription per connection
  (zero gap, zero dupe, F13), `reply.hijack()` + real `text/event-stream` headers.
- **E5.6 ⚠** context composition: fixed six-section order (charter / memory / workstream
  / trigger / pending / org-tools), provenance-labelled memory index, prior-run
  summaries, per-trigger sections; golden-fixture tests pin the exact text; written to
  the run's recorded `input_context_ref`.
- **E5.7** `foundry` CLI (L4, zero deps beyond core): init, daemon start/stop (detached
  spawn, pidfile, health poll), agent create, backup (`POST /api/backup`).
- **E6.1 head start** lives on `phase-2/org-tools` (next branch up the stack).

## Delegated to smaller models — and what review caught

E5.2–E5.5 and E5.7 were Haiku-built (three agents, isolated worktrees). Review/live-smoke
caught, beyond nits: **(1)** SSE handler set headers on the buffered Fastify reply while
writing bytes to `reply.raw` — `text/event-stream` never reached the socket — plus a
per-connection subscription that buffered every event forever (leak); rewritten.
**(2)** `execFile` can't detach/ignore stdio (`as any` hid it) — `foundry daemon start`
could never exit. **(3)** `foundry agent create` never consumed its subcommand before
`parseArgs` — every invocation crashed; the agent's stubbed "smoke test" (files exist)
couldn't see it. **(4)** Packaging: `@foundry/adapter-api`'s index re-exported the
conformance suite → top-level vitest import crashed every non-test consumer (the daemon);
conformance now lives on the `./conformance` subpath. Lesson unchanged: green tests (or
stubbed tests) from delegated work are a start; run the real thing.

## Verified definition of done

```
pnpm install && pnpm run build && pnpm run test   # 325 green
pnpm run lint:deps                                # 0 violations
node packages/cli/dist/foundry.js init|daemon start|agent create|backup|daemon stop  # live
```

## Next up

E6 on `phase-2/org-tools` (E6.1 tokens already landed there); E7 UI on `phase-2/ui`;
E9.1 done on `phase-2/claude-code` (needs the adapter-api `./conformance` import fix on
merge). OPEN_ISSUES #29–32 record E5's contract decisions.
