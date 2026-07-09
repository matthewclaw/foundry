# Phase 0 — `@foundry/core` (Epic E1)

Branch: `phase-0/core`. Scope: monorepo scaffold + `@foundry/core` per
`docs/implementation/roadmap.md` E1.1–E1.5. No other package was stubbed, per the work
order.

## What's here

- **Monorepo scaffold**: pnpm workspaces, strict TS (`tsconfig.base.json`, Node ≥20,
  ESM/NodeNext), Vitest per package, `.dependency-cruiser.cjs` enforcing the
  contracts.md layer-direction rule (packages depend only on lower layers; `ui`/`cli`
  forbidden from importing `store`/`runtime`/`server`) wired into `.github/workflows/ci.yml`.
- **`packages/core`** — no I/O; runtime dependencies are exactly `zod` and `ulid`
  (`zod-to-json-schema` and `fast-check` are devDependencies used only by the test
  suite, not shipped in the package's dependency graph):
  - **E1.5** (`src/ids.ts`): monotonic ULIDs per entity kind, branded id types (`ActorId`,
    `AgentId`, … eleven kinds), typed refs (`kind:id`, e.g. `artifact:01J…`,
    `event:482` for the one entity whose id is a monotonic seq, not a ULID).
  - **E1.1** (`src/schemas/`): Zod schemas for every doc-02 entity (Actor, Agent +
    versioned Charter, Team, Workstream, Run, Task, Message, Thread, Approval,
    Artifact, Event envelope, Schedule) plus shared value objects (Budget, Usage,
    RoutingSpec, DeliverableRef, WorkspaceRef, Policy). Fixtures for every entity;
    round-trip (`parse(serialize(x)) = x`) and JSON-Schema-generation tests for each.
  - **E1.2** (`src/state-machines/transitions.ts`): transition tables for agent,
    workstream, run, task, and message-disposition (keyed by message type), each
    transition naming its emitting event type. `canTransition(entity, from, to)` plus
    `canTransitionDisposition(messageType, from, to)`. Property tests (fast-check)
    prove `canTransition` agrees with the declared table over the full state × state
    space, and that random walks of legal moves never leave the declared state enum.
  - **E1.3** (`src/events/catalogue.ts`): 51 event types (`agent_* / workstream_* /
    run_* / task_* / message_* / approval_* / policy_* / system_*`), each with a Zod
    payload schema and a catalogue version (`EVENT_CATALOGUE_VERSION = 1`, additive-only).
    A test cross-checks that every event type named by a state-machine transition exists
    in the catalogue. `parseEventTolerant` lets consumers ignore future, unknown types
    instead of throwing. `generateCatalogueMarkdown()` + `scripts/generate-catalogue.mjs`
    produce `docs/generated/event-catalogue.md` from the schemas.
  - **E1.4** (`src/org-tools/`, `src/api/`): input/output Zod schemas for every
    contracts.md org-tool (`delegate_task`, `update_task`, `deliver_task`,
    `send_message`, `escalate`, `request_approval`, `search_history`, `get_task`,
    `get_thread`, `list_org`), API command DTOs (agent/workstream/task/run/approval),
    the enumerated `PolicyErrorCode` set, and an RFC 9457 `ProblemDetails` schema.

## Verified definition of done

From a clean `node_modules`/`dist`:
```
pnpm install   # green
pnpm run build # green (tsc, all packages)
pnpm run test  # green — 6 files, 100 tests
pnpm run lint:deps  # green — 0 dependency-direction violations
```

## Open issues raised

Eleven items in `docs/implementation/OPEN_ISSUES.md` — none are contradictions of the
docs, all are places where a doc names a concept without pinning an exact shape (Budget,
Usage, RoutingSpec, DeliverableRef, Policy field lists; the literal workstream-transition
graph; the task-rejection-loop event naming; `canTransitionDisposition`'s extra
message-type argument; the open-vs-closed `Approval.kind` set; `list_org`'s deliberately
minimal output vs. store's real `OrgView`; and the catalogue's ~51-vs-"~40" count). Each
entry states the chosen shape so downstream lanes (E2 store, E6 policy, E9 adapter) can
build against it or correct it before it calcifies.

## Not in scope (left for later epics, per the work order)

`packages/store`, `adapter-api`, `adapter-fake`, `adapter-claude-code`, `runtime`,
`server`, `ui`, `cli` are unstubbed. The dependency-cruiser config already encodes their
intended layer relationships so E2+ can add packages without re-deriving the rule.
