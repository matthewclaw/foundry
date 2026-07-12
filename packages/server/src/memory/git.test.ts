/** E11.1 — git-versioned memory: commit appears post-run; human + agent edits coexist. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeAdapter, loadScenario } from "@foundry/adapter-fake";
import { commitAgentMemory, commitAgentSkills } from "./git.js";
import { createServer, type FoundryServer } from "../server.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "foundry-memory-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function log(cwd: string): string[] {
  return execFileSync("git", ["log", "--format=%s"], { cwd, encoding: "utf8" }).trim().split("\n").filter(Boolean);
}

describe("commitAgentMemory — E11.1", () => {
  it("initialises the repo, commits dirty state, and no-ops when clean", () => {
    const mem = join(dir, "agents", "a1", "memory");
    mkdirSync(mem, { recursive: true });
    writeFileSync(join(mem, "INDEX.md"), "- [x](x.md) — a fact", "utf8");

    expect(commitAgentMemory(dir, "agents/a1/memory", "run r1")).toBe(true);
    expect(log(mem)).toEqual(["run r1"]);
    // Clean tree: nothing to commit.
    expect(commitAgentMemory(dir, "agents/a1/memory", "run r2")).toBe(false);
    expect(log(mem)).toEqual(["run r1"]);
    // A "human edit" and an "agent edit" both land in the next sweep — coexistence is
    // append-discipline, not merging.
    writeFileSync(join(mem, "INDEX.md"), "- [x](x.md) — a corrected fact", "utf8");
    writeFileSync(join(mem, "lesson.md"), "retries cap at 3", "utf8");
    expect(commitAgentMemory(dir, "agents/a1/memory", "run r3")).toBe(true);
    expect(log(mem)).toEqual(["run r3", "run r1"]);
  });

  it("missing dir is a silent no-op", () => {
    expect(commitAgentMemory(dir, "agents/nobody/memory", "run rX")).toBe(false);
  });
});

describe("commitAgentSkills — E11.4", () => {
  it("initialises the skills repo, commits dirty state, and no-ops when clean", () => {
    const skills = join(dir, "agents", "a1", "skills");
    mkdirSync(skills, { recursive: true });
    mkdirSync(join(skills, "test"), { recursive: true });
    writeFileSync(join(skills, "test", "SKILL.md"), "---\nname: test\n---\n", "utf8");

    expect(commitAgentSkills(dir, "agents/a1/memory", "run r1")).toBe(true);
    expect(log(skills)).toEqual(["run r1"]);
    // Clean tree: nothing to commit.
    expect(commitAgentSkills(dir, "agents/a1/memory", "run r2")).toBe(false);
    expect(log(skills)).toEqual(["run r1"]);
    // New skill added and committed.
    mkdirSync(join(skills, "new"), { recursive: true });
    writeFileSync(join(skills, "new", "SKILL.md"), "---\nname: new\n---\n", "utf8");
    expect(commitAgentSkills(dir, "agents/a1/memory", "run r3")).toBe(true);
    expect(log(skills)).toEqual(["run r3", "run r1"]);
  });

  it("missing skills dir is a silent no-op", () => {
    expect(commitAgentSkills(dir, "agents/nobody/memory", "run rX")).toBe(false);
  });
});

describe("memory auto-commit wiring — E11.1", () => {
  it("a commit appears after a run when the agent's memory dir is dirty", async () => {
    const server: FoundryServer = createServer({
      dataDir: dir,
      adapters: { fake: createFakeAdapter(loadScenario("happy-path")) },
    });
    try {
      const { agentId } = server.store.commands.createAgent({
        name: "Orbit",
        role: "Backend",
        team_id: null,
        engine_id: "fake",
        engine_config: { scenarioName: "happy-path" },
        memory_ref: "agents/{agent_id}/memory",
        charter_body_md: "# Orbit",
      });
      server.store.commands.transitionAgentState({ id: agentId, to: "active", actorId: null });
      const agent = server.store.agents.get(agentId)!;
      const mem = join(dir, agent.memory_ref);
      mkdirSync(mem, { recursive: true });
      writeFileSync(join(mem, "INDEX.md"), "- seeded before the run", "utf8");

      const ws = server.store.commands.createWorkstream({
        agent_id: agentId,
        title: "T",
        goal_md: "g",
        origin: "human",
        budget: { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 },
      });
      const run = server.runtime.enqueue({ workstreamId: ws.id, trigger: "human_message" });
      while (server.runtime.pendingCount() > 0 || server.runtime.activeCount() > 0) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(server.store.runs.get(run.id)?.state).toBe("completed");
      expect(log(mem)).toEqual([`run ${run.id}`]);
    } finally {
      server.store.close();
    }
  });
});

describe("skills auto-commit wiring — E11.4", () => {
  it("a commit appears after a run when the agent's skills dir is dirty", async () => {
    const server: FoundryServer = createServer({
      dataDir: dir,
      adapters: { fake: createFakeAdapter(loadScenario("happy-path")) },
    });
    try {
      const { agentId } = server.store.commands.createAgent({
        name: "Orbit",
        role: "Backend",
        team_id: null,
        engine_id: "fake",
        engine_config: { scenarioName: "happy-path" },
        memory_ref: "agents/{agent_id}/memory",
        charter_body_md: "# Orbit",
      });
      server.store.commands.transitionAgentState({ id: agentId, to: "active", actorId: null });
      const agent = server.store.agents.get(agentId)!;
      const skills = join(dir, "agents", agentId, "skills");
      mkdirSync(skills, { recursive: true });
      mkdirSync(join(skills, "test"), { recursive: true });
      writeFileSync(
        join(skills, "test", "SKILL.md"),
        `---
name: test
description: "Test skill"
---

Content`,
        "utf8"
      );

      const ws = server.store.commands.createWorkstream({
        agent_id: agentId,
        title: "T",
        goal_md: "g",
        origin: "human",
        budget: { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 },
      });
      const run = server.runtime.enqueue({ workstreamId: ws.id, trigger: "human_message" });
      while (server.runtime.pendingCount() > 0 || server.runtime.activeCount() > 0) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(server.store.runs.get(run.id)?.state).toBe("completed");
      expect(log(skills)).toEqual([`run ${run.id}`]);
    } finally {
      server.store.close();
    }
  });
});
