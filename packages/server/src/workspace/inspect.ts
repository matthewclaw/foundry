/**
 * Workspace inspection + git handoff for a workstream's run directory. Foundry is an ADE,
 * not an IDE: it tells you *where* the agent worked and *what* changed, hands the actual
 * diff-reading to your editor (open-in-IDE), and promotes the agent's scratch work to a
 * real branch you review/merge with your own tools — it does not render diffs or merge.
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Agent, Team, Workstream } from "@foundry/core";

export type WorkspaceKind = "git_worktree" | "plain_dir" | "scratch";

export interface WorkspaceChange {
  /** Two-char git porcelain status, e.g. "??" (untracked), " M" (modified), "A " (added). */
  status: string;
  path: string;
}

export interface WorkspaceInfo {
  path: string;
  kind: WorkspaceKind;
  exists: boolean;
  git: {
    branch: string; // "(detached)" for the worktrees Foundry creates
    changed: WorkspaceChange[];
    /** Whether these changes are already committed on a branch (vs uncommitted worktree edits). */
    committed: boolean;
  } | null;
}

/**
 * The absolute dir a workstream's runs execute in — mirrors the runtime's acquireWorkspace
 * derivation (facade.ts / workspace/manager.ts): workstream ref, else the agent default,
 * else the agent's team default, else scratch; git_worktree/scratch live under
 * `<dataDir>/workspaces/`.
 * ponytail: duplicated (not imported) to keep the server off the runtime package; the
 * path convention is stable and the one test below pins it.
 */
export function resolveWorkspaceDir(
  dataDir: string,
  workstream: Workstream,
  agent: Agent,
  team?: Team | null
): { path: string; kind: WorkspaceKind } {
  const ref = workstream.workspace_ref ?? agent.default_workspace_ref ?? team?.default_workspace_ref ?? null;
  if (ref?.kind === "git_worktree") {
    return { path: join(dataDir, "workspaces", `worktree-${workstream.id}`), kind: "git_worktree" };
  }
  if (ref?.kind === "plain_dir") {
    return { path: ref.path, kind: "plain_dir" };
  }
  return { path: join(dataDir, "workspaces", `scratch-${workstream.id}`), kind: "scratch" };
}

function git(cwd: string, args: string[]): string {
  // windowsHide: the workspace panel polls git on every workstream open — without this
  // each git subprocess flashes a console window on Windows.
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

/** Read-only look at a workspace dir: does it exist, and (if a git repo) what changed. */
export function inspectWorkspace(path: string, kind: WorkspaceKind): WorkspaceInfo {
  const exists = existsSync(path);
  if (!exists) return { path, kind, exists: false, git: null };
  try {
    // Throws if not a git work tree — a plain scratch dir has no git, which is fine.
    git(path, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return { path, kind, exists: true, git: null };
  }
  let branch = "(detached)";
  try {
    branch = git(path, ["symbolic-ref", "--short", "HEAD"]);
  } catch {
    /* detached HEAD — the state Foundry's worktrees start in */
  }
  // -uall: list each untracked file, not the collapsed parent dir ("docs/foundry-e2e.md",
  // not "docs/") — the panel is meant to show what the agent actually created.
  const porcelain = git(path, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const changed: WorkspaceChange[] = porcelain
    ? porcelain.split("\n").map((line) => ({ status: line.slice(0, 2), path: line.slice(3) }))
    : [];
  return { path, kind, exists: true, git: { branch, changed, committed: branch !== "(detached)" && changed.length === 0 } };
}

/** Open a directory in VS Code. Returns false if `code` isn't launchable so the caller
 * can say so instead of the click looking dead. Must go through a shell: on Windows
 * `code` is `code.cmd`, which Node's execFile refuses to run directly (ENOENT). `code`
 * hands off to the running instance and returns immediately, so sync-with-timeout is fine. */
export function openInEditor(path: string): boolean {
  try {
    execSync(`code "${path}"`, { stdio: "ignore", timeout: 10000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export interface PromoteResult {
  ok: boolean;
  branch?: string;
  message?: string;
}

/**
 * Rung 3, the ADE way: commit the worktree's changes onto a real branch in the shared
 * repo (worktrees share the repo's refs, so the branch shows up in your IDE) — then YOU
 * review and merge it with your own tools. Foundry promotes; it doesn't merge.
 */
export function promoteToBranch(path: string, branch: string, commitMessage: string): PromoteResult {
  try {
    git(path, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return { ok: false, message: "not a git worktree — nothing to promote" };
  }
  if (!git(path, ["status", "--porcelain=v1"])) {
    return { ok: false, message: "no changes to promote" };
  }
  try {
    git(path, ["checkout", "-b", branch]);
    git(path, ["add", "-A"]);
    git(path, ["commit", "-m", commitMessage]);
    return { ok: true, branch };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** A filesystem/git-safe branch name from a workstream title + id. */
export function branchNameFor(workstream: Workstream): string {
  const slug = workstream.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `foundry/${slug || "task"}-${workstream.id.slice(-6).toLowerCase()}`;
}
