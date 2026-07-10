/**
 * E4.4 — workspace manager: per-workstream git worktrees and scratch directories.
 *
 * Two workstreams on one repo get isolated worktrees; dirty worktree ⇒ run refused +
 * workstream blocked. Non-code workstreams get plain scratch directories.
 */
import { mkdirSync, rmSync, existsSync, accessSync, constants } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { WorkstreamId } from "@foundry/core";
import type { Store } from "@foundry/store";

export interface WorkspaceManagerOptions {
  store: Pick<Store, "commands">;
  worktreesRoot: string;
}

export interface AcquireResult {
  ok: boolean;
  workspaceDir?: string;
  refusalReason?: string;
}

export interface WorkspaceManager {
  acquireGitWorktree(workstreamId: WorkstreamId, repoPath: string): AcquireResult;
  acquireScratchDir(workstreamId: WorkstreamId): AcquireResult;
  release(workstreamId: WorkstreamId): void;
}

export function createWorkspaceManager(options: WorkspaceManagerOptions): WorkspaceManager {
  const { store, worktreesRoot } = options;
  const worktreePathCache = new Map<WorkstreamId, { repoPath: string; worktreePath: string }>();

  function getWorktreePath(workstreamId: WorkstreamId): string {
    return join(worktreesRoot, `worktree-${workstreamId}`);
  }

  function getScratchDir(workstreamId: WorkstreamId): string {
    return join(worktreesRoot, `scratch-${workstreamId}`);
  }

  function isWorktreeDirty(worktreePath: string): boolean {
    try {
      const output = execFileSync("git", ["status", "--porcelain"], {
        cwd: worktreePath,
        encoding: "utf-8",
      });
      return output.length > 0;
    } catch {
      // ponytail: git status failure means dirty, be conservative
      return true;
    }
  }

  function acquireGitWorktree(workstreamId: WorkstreamId, repoPath: string): AcquireResult {
    const worktreePath = getWorktreePath(workstreamId);

    // Check cache for existing worktree
    const cached = worktreePathCache.get(workstreamId);
    if (cached) {
      if (cached.repoPath !== repoPath) {
        return {
          ok: false,
          refusalReason: `workstream already has a worktree for repo ${cached.repoPath}, cannot switch to ${repoPath}`,
        };
      }

      // Check if worktree directory exists and is clean
      if (!existsSync(worktreePath)) {
        return {
          ok: false,
          refusalReason: `worktree directory does not exist: ${worktreePath}`,
        };
      }

      if (isWorktreeDirty(worktreePath)) {
        store.commands.transitionWorkstreamState({
          id: workstreamId,
          to: "blocked",
          actorId: null,
          reason: "dirty worktree on acquire",
        });
        return {
          ok: false,
          refusalReason: "worktree has uncommitted changes",
        };
      }

      return {
        ok: true,
        workspaceDir: worktreePath,
      };
    }

    // Create new worktree
    try {
      execFileSync("git", ["worktree", "add", worktreePath, "HEAD"], {
        cwd: repoPath,
      });
    } catch (e) {
      return {
        ok: false,
        refusalReason: `failed to create worktree: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    worktreePathCache.set(workstreamId, { repoPath, worktreePath });

    return {
      ok: true,
      workspaceDir: worktreePath,
    };
  }

  function acquireScratchDir(workstreamId: WorkstreamId): AcquireResult {
    const scratchDir = getScratchDir(workstreamId);

    try {
      mkdirSync(scratchDir, { recursive: true });
      return {
        ok: true,
        workspaceDir: scratchDir,
      };
    } catch (e) {
      return {
        ok: false,
        refusalReason: `failed to create scratch directory: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  function release(workstreamId: WorkstreamId): void {
    const cached = worktreePathCache.get(workstreamId);
    if (cached) {
      const worktreePath = cached.worktreePath;
      try {
        execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
          cwd: cached.repoPath,
        });
      } catch {
        // ponytail: best-effort removal, continue even if git fails
      }
      worktreePathCache.delete(workstreamId);
    }

    const scratchDir = getScratchDir(workstreamId);
    if (existsSync(scratchDir)) {
      try {
        rmSync(scratchDir, { recursive: true, force: true });
      } catch {
        // ponytail: best-effort cleanup, continue even if rmSync fails
      }
    }
  }

  return {
    acquireGitWorktree,
    acquireScratchDir,
    release,
  };
}
