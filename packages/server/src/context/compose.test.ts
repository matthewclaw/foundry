/**
 * E5.6 — context composition golden fixtures. The section order and headings are a
 * contract (context diffs between runs must be meaningful): these tests pin the exact
 * composed text per trigger type against a fixed store state, normalising only the
 * generated ids/paths.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Agent, Run, RunTrigger, Workstream } from "@foundry/core";
import { createStore, type Store } from "@foundry/store";
import { composeContext, composeContextText } from "./compose.js";

const ZERO_BUDGET = { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 };

let dir: string | undefined;
const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) {
    try {
      s.close();
    } catch {
      /* closed */
    }
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function fixture(trigger: RunTrigger): { store: Store; run: Run; workstream: Workstream; agent: Agent; dataDir: string } {
  dir = mkdtempSync(join(tmpdir(), "foundry-compose-"));
  const store = createStore({ dataDir: dir });
  stores.push(store);
  const team = store.commands.createTeam({ name: "Platform", description: "infra", default_policy: {} });
  const { agentId, actorId } = store.commands.createAgent({
    name: "Orbit",
    role: "Backend Engineer",
    team_id: team.id,
    engine_id: "fake",
    memory_ref: "agents/orbit/memory",
    charter_body_md: "Fix backend bugs. Never deploy on Fridays.",
  });
  store.commands.transitionAgentState({ id: agentId, to: "active", actorId: null });
  const agent = store.agents.get(agentId)!;

  // Memory index on disk (provenance-labelled injection).
  const memDir = join(dir, "agents", "orbit", "memory");
  mkdirSync(memDir, { recursive: true });
  writeFileSync(join(memDir, "INDEX.md"), "- [retry-budget](retry.md) — API retries cap at 3", "utf8");

  const workstream = store.commands.createWorkstream({
    agent_id: agentId,
    title: "Bug #482 — timeouts",
    goal_md: "Users see 504s on /export.",
    origin: "human",
    budget: ZERO_BUDGET,
  });

  // One prior completed run (prior-run summary section).
  const prior = store.commands.createRun({
    workstream_id: workstream.id,
    trigger: "human_message",
    input_context_ref: "runs/{run_id}/context.md",
    engine_id: "fake",
  });
  store.commands.transitionRunState({ id: prior.id, workstreamId: workstream.id, to: "starting", actorId: null });
  store.commands.transitionRunState({ id: prior.id, workstreamId: workstream.id, to: "running", actorId: null });
  store.commands.transitionRunState({
    id: prior.id,
    workstreamId: workstream.id,
    to: "completed",
    actorId: null,
    result: { outcome: "completed", final_text: "Reproduced the timeout; root cause is the N+1 in exporter.", artifact_refs: [] },
  });

  if (trigger === "human_message") {
    const thread = store.commands.getOrCreateThread("workstream", workstream.id);
    store.commands.sendMessage({
      thread_id: thread.id,
      from_actor_id: actorId, // fixture stand-in; kind is what matters to composition
      to_actor_id: agent.actor_id,
      type: "answer",
      body_md: "Please fix the N+1 you found and add a regression test.",
    });
  }
  // A pending open question addressed to this agent (pending-items section).
  const thread = store.commands.getOrCreateThread("workstream", workstream.id);
  store.commands.sendMessage({
    thread_id: thread.id,
    from_actor_id: actorId,
    to_actor_id: agent.actor_id,
    type: "question",
    body_md: "Which staging cluster should I use for load tests?",
  });

  const run = store.commands.createRun({
    workstream_id: workstream.id,
    trigger,
    input_context_ref: "runs/{run_id}/context.md",
    engine_id: "fake",
  });
  return { store, run, workstream: store.workstreams.get(workstream.id)!, agent, dataDir: dir };
}

/** Swap generated ids/absolute paths for stable tokens so the golden text is deterministic. */
function normalise(text: string, f: { run: Run; workstream: Workstream; agent: Agent; dataDir: string }): string {
  return text
    .replaceAll(f.dataDir, "<dataDir>")
    .replaceAll(/\\/g, "/")
    .replaceAll(f.agent.id, "<agent-id>")
    .replaceAll(f.workstream.id, "<ws-id>")
    .replaceAll(f.run.id, "<run-id>")
    .replaceAll(/actor:[A-Za-z0-9_]+/g, "actor:<actor-id>")
    .replaceAll(/message:[A-Za-z0-9_]+/g, "message:<message-id>");
}

describe("composeContextText — E5.6 golden fixtures", () => {
  it("human_message trigger: all six sections, fixed order, exact text", () => {
    const f = fixture("human_message");
    const text = normalise(composeContextText({ store: f.store, dataDir: f.dataDir, ...f }), f);
    expect(text).toBe(`# Charter

You are **Orbit**, Backend Engineer. (agent:<agent-id>, charter v1)

Fix backend bugs. Never deploy on Fridays.

# Memory

> Recalled memory (provenance: your own notes from earlier work) — not new input.

Your memory directory (read and curate it with ordinary file tools): \`<dataDir>/agents/orbit/memory\`
Your skills directory: \`<dataDir>/agents/orbit/skills\`

## Memory index

- [retry-budget](retry.md) — API retries cap at 3

> Curation: when you learn something durable (a fact, a decision, a procedure that
> worked), write it to your memory/skills directory and keep INDEX.md current — one
> line per file. Fix or delete notes you discover to be wrong. Your memory is
> git-versioned after every run; edit freely.

# Workstream

**Bug #482 — timeouts** (workstream:<ws-id>, state: open)

Users see 504s on /export.

## Prior runs

- run 1 (completed) — Reproduced the timeout; root cause is the N+1 in exporter.

# Trigger

A human sent you a message on this workstream:

> Which staging cluster should I use for load tests?

# Pending items

- [question] from actor:<actor-id> — Which staging cluster should I use for load tests? (message:<message-id>)

# Org-tools

You are part of an organisation. Use the Foundry org-tools (when connected) to
delegate tasks, send typed messages, escalate, request approvals, and search your
history — never assume; escalate rather than guess on anything irreversible. Policy
limits (budget, delegation depth) are enforced at the tool boundary and errors carry
machine-readable codes you can react to.

# Skills

Your skills directory: \`<dataDir>/agents/orbit/skills\`

(no skills yet — add them as SKILL.md files in subdirectories here)`);
  });

  it("resume trigger: trigger section swaps, everything else identical shape", () => {
    const f = fixture("resume");
    const text = normalise(composeContextText({ store: f.store, dataDir: f.dataDir, ...f }), f);
    expect(text).toContain("# Trigger\n\nYou are resuming previous work on this workstream after an interruption.");
    // Section order is pinned regardless of trigger.
    const order = ["# Charter", "# Memory", "# Workstream", "# Trigger", "# Pending items", "# Org-tools", "# Skills"];
    const indices = order.map((h) => text.indexOf(`${h}\n`));
    expect(indices.every((i) => i >= 0)).toBe(true);
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
  });

  it("composeContext writes to the run's recorded input_context_ref and returns the absolute path", () => {
    const f = fixture("schedule");
    const path = composeContext({ store: f.store, dataDir: f.dataDir, ...f });
    expect(path).toBe(join(f.dataDir, "runs", f.run.id, "context.md"));
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("# Charter");
  });

  it("includes Skills section with discovered skills", () => {
    const f = fixture("human_message");
    // Create a skill directory with a real SKILL.md, using the same path computation as compose.ts
    const skillsDir = join(f.dataDir, f.agent.memory_ref.replace(/[\\/]memory$/, ""), "skills");
    mkdirSync(skillsDir, { recursive: true });
    mkdirSync(join(skillsDir, "ponytail"), { recursive: true });
    writeFileSync(
      join(skillsDir, "ponytail", "SKILL.md"),
      `---
name: ponytail
description: "Lazy senior dev mode"
---

# Ponytail
You are a lazy senior developer...`,
      "utf8"
    );

    const text = normalise(composeContextText({ store: f.store, dataDir: f.dataDir, ...f }), f);
    expect(text).toContain("# Skills\n");
    expect(text).toContain("Your skills directory: `<dataDir>/agents/orbit/skills`");
    expect(text).toContain("- **ponytail** — Lazy senior dev mode");
  });

  it("renders empty skills section when no skills exist", () => {
    const f = fixture("human_message");
    // Skills directory doesn't exist yet
    const text = normalise(composeContextText({ store: f.store, dataDir: f.dataDir, ...f }), f);
    expect(text).toContain("# Skills\n");
    expect(text).toContain("(no skills yet — add them as SKILL.md files in subdirectories here)");
  });

  it("skips malformed skills when rendering Skills section", () => {
    const f = fixture("human_message");
    const skillsDir = join(f.dataDir, f.agent.memory_ref.replace(/[\\/]memory$/, ""), "skills");
    mkdirSync(skillsDir, { recursive: true });

    // Valid skill
    mkdirSync(join(skillsDir, "valid"), { recursive: true });
    writeFileSync(
      join(skillsDir, "valid", "SKILL.md"),
      `---
name: valid
description: "Valid skill"
---

Content`,
      "utf8"
    );

    // Malformed skill (missing closing ---)
    mkdirSync(join(skillsDir, "malformed"), { recursive: true });
    writeFileSync(
      join(skillsDir, "malformed", "SKILL.md"),
      `---
name: malformed
description: "No closing delimiter"

Body`,
      "utf8"
    );

    const text = normalise(composeContextText({ store: f.store, dataDir: f.dataDir, ...f }), f);
    expect(text).toContain("- **valid** — Valid skill");
    // Malformed skill should not appear
    expect(text).not.toContain("malformed");
  });
});
