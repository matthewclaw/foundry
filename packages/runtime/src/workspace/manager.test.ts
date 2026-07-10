import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentId, WorkstreamId } from "@foundry/core";
import { createStore, type Store } from "@foundry/store";
import { createWorkspaceManager } from "./manager.js";

const ZERO_BUDGET = { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 };

let testDir: string | undefined;
let storeDir: string | undefined;

afterEach(() => {
  if (testDir) rmSync(testDir, { recursive: true, force: true });
  if (storeDir) rmSync(storeDir, { recursive: true, force: true });
  testDir = undefined;
  storeDir = undefined;
});

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "foundry-workspace-"));
}

function createTestStore(): Store {
  storeDir = mkdtempSync(join(tmpdir(), "foundry-store-"));
  return createStore({ dataDir: storeDir, dbPath: ":memory:" });
}

function createTestRepo(): string {
  const repoPath = createTempDir();
  execFileSync("git", ["init"], { cwd: repoPath });
  execFileSync("git", ["-c", "user.email=test@test.com", "-c", "user.name=Test User", "commit", "--allow-empty", "-m", "initial commit"], {
    cwd: repoPath,
  });
  return repoPath;
}

function bootstrapAgent(store: Store): AgentId {
  const team = store.commands.createTeam({ name: "Platform", description: "infra", default_policy: {} });
  const { agentId } = store.commands.createAgent({
    name: "Orbit",
    role: "Backend Engineer",
    team_id: team.id,
    engine_id: "fake",
    memory_ref: "agents/orbit/memory",
    charter_body_md: "# Orbit",
  });
  return agentId;
}

function makeWorkstream(store: Store, agentId: AgentId, title: string): WorkstreamId {
  return store.commands.createWorkstream({
    agent_id: agentId,
    title,
    goal_md: "test goal",
    origin: "human",
    budget: ZERO_BUDGET,
  }).id;
}

describe("createWorkspaceManager — E4.4", () => {
  it("two workstreams on the same repo get isolated worktrees", () => {
    testDir = createTempDir();
    const store = createTestStore();
    const repoPath = createTestRepo();
    const agentId = bootstrapAgent(store);

    const ws1 = makeWorkstream(store, agentId, "Task 1");
    const ws2 = makeWorkstream(store, agentId, "Task 2");

    const manager = createWorkspaceManager({
      store,
      worktreesRoot: testDir,
    });

    const result1 = manager.acquireGitWorktree(ws1, repoPath);
    const result2 = manager.acquireGitWorktree(ws2, repoPath);

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    expect(result1.workspaceDir).toBeDefined();
    expect(result2.workspaceDir).toBeDefined();
    expect(result1.workspaceDir).not.toBe(result2.workspaceDir);

    // Both directories exist
    expect(existsSync(result1.workspaceDir!)).toBe(true);
    expect(existsSync(result2.workspaceDir!)).toBe(true);

    // Both have git
    expect(existsSync(join(result1.workspaceDir!, ".git"))).toBe(true);
    expect(existsSync(join(result2.workspaceDir!, ".git"))).toBe(true);

    // Verify git worktree list shows both (normalize path separators for cross-platform comparison)
    const worktreeList = execFileSync("git", ["worktree", "list"], {
      cwd: repoPath,
      encoding: "utf-8",
    });
    const normalizedList = worktreeList.replace(/\\/g, "/");
    const normalizedPath1 = result1.workspaceDir!.replace(/\\/g, "/");
    const normalizedPath2 = result2.workspaceDir!.replace(/\\/g, "/");
    expect(normalizedList).toContain(normalizedPath1);
    expect(normalizedList).toContain(normalizedPath2);
  });

  it("dirty worktree on re-acquire refuses and blocks the workstream", () => {
    testDir = createTempDir();
    const store = createTestStore();
    const repoPath = createTestRepo();
    const agentId = bootstrapAgent(store);

    const ws = makeWorkstream(store, agentId, "Dirty test");
    // Transition to active so it can be blocked
    store.commands.transitionWorkstreamState({ id: ws, to: "active", actorId: null });

    const manager = createWorkspaceManager({
      store,
      worktreesRoot: testDir,
    });

    // First acquire succeeds
    const result1 = manager.acquireGitWorktree(ws, repoPath);
    expect(result1.ok).toBe(true);

    // Write an uncommitted file
    const testFile = join(result1.workspaceDir!, "test.txt");
    writeFileSync(testFile, "uncommitted content");

    // Second acquire on same workstream with dirty worktree fails
    const result2 = manager.acquireGitWorktree(ws, repoPath);
    expect(result2.ok).toBe(false);
    expect(result2.refusalReason).toContain("uncommitted");

    // Workstream is now blocked
    const wsCurrent = store.workstreams.get(ws);
    expect(wsCurrent?.state).toBe("blocked");
  });

  it("acquireScratchDir creates a real directory with no git", () => {
    testDir = createTempDir();
    const store = createTestStore();
    const agentId = bootstrapAgent(store);

    const ws = makeWorkstream(store, agentId, "Scratch test");

    const manager = createWorkspaceManager({
      store,
      worktreesRoot: testDir,
    });

    const result = manager.acquireScratchDir(ws);
    expect(result.ok).toBe(true);
    expect(result.workspaceDir).toBeDefined();

    // Directory exists
    expect(existsSync(result.workspaceDir!)).toBe(true);

    // No .git inside
    expect(existsSync(join(result.workspaceDir!, ".git"))).toBe(false);

    // Can write to it
    const testFile = join(result.workspaceDir!, "data.json");
    writeFileSync(testFile, '{"test": true}');
    expect(readFileSync(testFile, "utf-8")).toBe('{"test": true}');
  });

  it("reusing a clean worktree on same workstream returns ok without recreation", () => {
    testDir = createTempDir();
    const store = createTestStore();
    const repoPath = createTestRepo();
    const agentId = bootstrapAgent(store);

    const ws = makeWorkstream(store, agentId, "Reuse test");

    const manager = createWorkspaceManager({
      store,
      worktreesRoot: testDir,
    });

    // First acquire
    const result1 = manager.acquireGitWorktree(ws, repoPath);
    expect(result1.ok).toBe(true);
    const path1 = result1.workspaceDir!;

    // Create a file and commit it
    const testFile = join(path1, "file.txt");
    writeFileSync(testFile, "content");
    execFileSync("git", ["add", "file.txt"], { cwd: path1 });
    execFileSync("git", ["-c", "user.email=test@test.com", "-c", "user.name=Test User", "commit", "-m", "add file"], {
      cwd: path1,
    });

    // Second acquire on same workstream with clean tree succeeds
    const result2 = manager.acquireGitWorktree(ws, repoPath);
    expect(result2.ok).toBe(true);
    expect(result2.workspaceDir).toBe(path1);
  });
});
