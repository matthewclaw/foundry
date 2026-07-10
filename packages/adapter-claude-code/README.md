# @foundry/adapter-claude-code

Reference engine adapter (E9): drives the Claude Code CLI headlessly —
`claude -p --output-format stream-json --verbose`, composed context piped on stdin,
NDJSON mapped to normalized `EngineEvent`s, session id captured for `--resume`,
child pid exposed on the `RunHandle` for the runtime's orphan sweep (F7).

## Testing model (contracts.md)

CI never calls a paid engine. All tests here run against **recorded stream fixtures**
(`fixtures/*.ndjson`) replayed by `fixtures/replay.mjs` through the exact spawn/parse
path used for the real CLI (`engineConfig.cliPath` = node + replay script). The real CLI
is exercised only in the manual/nightly lane (E9.5).

## Fixture-refresh procedure (routine task, Risk 1)

When a new CLI version changes the stream-json shape:

1. Run a real, cheap prompt and capture the raw stream:
   `claude -p "Say exactly: hello" --output-format stream-json --verbose --max-turns 2 > raw.ndjson`
   (for the tool-use fixture, use a prompt that reads/edits a scratch file, with
   `--allowedTools "Read,Edit"`).
2. Sanitize: replace the real `session_id` values with a stable `sess-cc-<name>` token
   (must stay identical across all lines of one fixture), truncate long text, drop any
   machine-identifying fields. Keep field *names and nesting* exactly as emitted.
3. Overwrite the relevant `fixtures/*.ndjson`, run `pnpm --filter
   @foundry/adapter-claude-code test`. If the mapper needs a change, change
   `src/stream.ts` (tolerant mapping — unknown fields/types must stay non-fatal).
4. Note the CLI version the fixtures were recorded against below.

Fixtures last validated against: the stream-json format documented at
code.claude.com/docs (headless + streaming-output pages), 2026-07.
`error_max_turns` appears both as a legacy `subtype` and as `error_details.code` in
current docs; the mapper accepts both (see `stream.ts`).

## Headless permissions note

With the default permission mode and no TTY, the first write/exec tool call aborts the
run (`error_permission_denied`). Until E6.4/E9.4 wire Foundry approvals into the CLI,
bind agents with an `engineConfig` that pre-approves what they need, e.g.
`{ "permissionMode": "acceptEdits" }` or `{ "allowedTools": ["Read", "Edit", "Bash(npm test)"] }`.
