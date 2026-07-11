# HANDOVER — Foundry roadmap build (session of 2026-07-10/11, Fable → next session)

Written mid-flight for a fresh session to continue the "carry the whole roadmap" run.
Read this first, then `SUMMARY-E4.md`, `SUMMARY-E5.md`, and
`docs/implementation/OPEN_ISSUES.md` #22–32. Roadmap/contracts in
`docs/implementation/` are the source of truth for what each story must do.

## Branch stack (merge PRs in this order — each is stacked on the previous)

| # | Branch | State | Contents |
|---|--------|-------|----------|
| 1 | `phase-1/runtime-reconcile` | ✅ complete, pushed | E4.5 + E4.6 → **E4 epic done** (SUMMARY-E4.md, OPEN_ISSUES #28) |
| 2 | `phase-1/server` | ✅ complete, pushed | **E5 epic done** (all 7 stories + Runtime facade closing #22/#26; SUMMARY-E5.md, #29–32). Live CLI smoke ran clean. |
| 3 | `phase-2/org-tools` | ✅ pushed, epic partial | E6.1 (per-run tokens), E6.4 (approvals loop end-to-end), E11.1 (memory git auto-commit), E11.2 (curation nudge), E11.3 (close-with-distillation). All tested green (server: 70 tests). |
| 3a | `phase-2/org-tools-swarm` | ⚠ WIP, UNVERIFIED, pushed | Haiku-built E6.3 (policy/) + E6.2 (org-tool handlers, `store/queries/search.ts`, `orgtools/mcp.ts`, `orgtools/shim.ts`). **One known build error** at `packages/server/src/routes/orgtools.ts` ~line 252 (an `AgentId` passed where a full `Agent` is expected). Tests never ran. Needs: fix, verify, LINE-BY-LINE REVIEW (see "review discipline"), then merge into `phase-2/org-tools`. |
| 4 | `phase-2/claude-code` | ✅ pushed | E9.1 (adapter, conformance-green over recorded fixtures), E9.2 adapter side (--mcp-config injection), E9.3 (covered by E9.1 tests), E9.5 (manual live script). E9.4 pending. |
| 5 | `phase-2/ui` | ✅ pushed | **E7 epic done** (E7.1–E7.4, 12 tests, reviewed). |

PR URLs are `https://github.com/matthewclaw/foundry/pull/new/<branch>` (`gh pr create`
is blocked — Enterprise Managed User; always hand back the URL, never try to open PRs).

Worktrees on disk: `C:\repos\ade` (phase-2/org-tools), `C:\repos\ade-wt-e6`
(org-tools-swarm), `C:\repos\ade-wt-claude` (claude-code), `C:\repos\ade-wt-ui` (ui).

## Immediate next steps, in order

1. **Finish `phase-2/org-tools-swarm`** (in `C:\repos\ade-wt-e6`): fix the one build
   error, run `pnpm run build; pnpm run test; pnpm run lint:deps`, then review the
   whole diff line by line (`git diff phase-2/org-tools..phase-2/org-tools-swarm`) —
   especially `policy.ts` check ordering/budget math, every `TOOL_HANDLERS` entry's
   attribution (`cred.actorId`), the search scope clamping, and whether `mcp.ts`
   actually works on Node 18 (the brief allowed stubbing it if the MCP SDK needs
   Node ≥20 — if stubbed, note it in OPEN_ISSUES and defer E9.4's server half).
   Merge into `phase-2/org-tools`, push. **E6 then complete** → write SUMMARY-E6.md
   (pattern: see SUMMARY-E5.md), hand PR URL.
2. **E10.1 + E10.3** (UI): a dispatch brief was already written — see the git history
   of this file's session or re-derive: ranked inbox (approvals grant/deny inline via
   `POST /api/approvals/:id/{grant,deny}`, ref format `approval:<id>`) + cost route
   (CostReport, "unreported" ≠ $0.00 per ADR-003). UI worktree is clean; no work lost.
3. **E8 (delegation + communication)** — biggest remaining epic; unblocked once E6.2's
   `delegate_task` lands. Key integration point: the E6.2 handler only *creates* the
   task; E8.1 adds workstream-spawn for the assignee + `task_assigned` run trigger +
   deliver/accept/reject loop + rejection cap → escalation (policy.ts already exports
   `checkRejection`). E8.2 property test (budget conservation) builds on
   `checkDelegation`'s per-axis math. E8.3 (message dispositions + expiry sweep),
   E8.4 (thread round caps — `threads.round_count` exists), E8.5 (routing — E6.3's
   `resolveRouting` + record + failure→inbox), E8.6 (cancel cascade + handover).
   Haiku-swarmable in 2–3 sequential briefs; E8.1 is the keystone-ish one.
4. **E9.4** (permission hooks → approvals): supervisor already maps `permission_request`
   → approval + workstream waiting (done in E6.4). E9.4's remaining half is server-side
   mcpConfig generation in `createServer.mintRunCredential` pointing at `/api/mcp`
   (blocked on the E6.2 MCP outcome) + a recorded fixture with a permission flow.
5. **E10.2/E10.4** (delegation tree view — needs E8 fixtures; anomaly rules → inbox).
6. **E11.4/E11.5** (skills dirs + FTS5 recall — `search_history` currently a LIKE scan
   with a ponytail ceiling comment; E11.5 replaces it with FTS5 + policy scopes).
7. **E12** (release gate): six doc-01 success tests automated full-stack, every
   expressible doc-07 F# scenario, the 3-team/8-agent multi-level org scenario,
   quickstart docs, dogfood. Do E12.1/E12.2 as API-level tests in `packages/server`
   (fake adapter; pattern = `routes/approvals.test.ts`).

## Working practices that this session validated (keep them)

- **Delegate to Haiku agents in isolated git worktrees** (one branch each, never share
  a working dir), with briefs that PIN every contract detail (exact store command
  names, state-machine edges, error codes). Vague briefs produce plausible-wrong code.
- **Review discipline is non-negotiable**: every single Haiku batch shipped ≥1 real bug
  that green tests missed — invalid state-machine edge (E4.6), SSE headers never
  reaching the socket + a per-connection buffer leak (E5.5), `execFile` can't detach
  (E5.7), `foundry agent create` crashing on its own documented syntax (E5.7, caught
  only by LIVE smoke), adapter-api's index importing vitest into production consumers
  (packaging). Read diffs line by line; run the real thing, not just tests.
- **Environment gotchas** (also in the project memory dir): Node is 18 (repo wants
  ≥20; warnings only) — deps must support 18 (Fastify 4, Vite 5, not 5/6+);
  better-sqlite3 needs an ABI rebuild in EVERY fresh worktree
  (`cd node_modules\.pnpm\better-sqlite3@*\node_modules\better-sqlite3; rm -rf build;
  npm run install`); PowerShell 5.1 corrupts embedded double quotes in multi-line
  `git commit -m` — write to a temp file and `git commit -F`.
- Commit trailer: `Co-Authored-By: Claude <model> <noreply@anthropic.com>`; per-epic
  SUMMARY-Ex.md docs at repo root; contract deviations go in OPEN_ISSUES.md (next: #33).
