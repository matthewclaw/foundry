/**
 * E4.4 — workspace manager: per-workstream git worktrees and scratch directories.
 *
 * Two workstreams on one repo get isolated worktrees; dirty worktree ⇒ run refused +
 * workstream blocked. Non-code workstreams get plain scratch directories.
 */
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
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
  const { store } = options;
  // Must be absolute: git commands for git_worktree acquisition run with cwd set to
  // the target repo (possibly anywhere on disk), so a relative worktreesRoot would get
  // resolved against that repo's path instead of where Foundry actually meant it.
  const worktreesRoot = resolve(options.worktreesRoot);
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
        windowsHide: true,
      });
      return output.length > 0;
    } catch {
      // ponytail: git status failure means dirty, be conservative
      return true;
    }
  }

  function acquireGitWorktree(workstreamId: WorkstreamId, repoPath: string): AcquireResult {
    const worktreePath = getWorktreePath(workstreamId);

    const cached = worktreePathCache.get(workstreamId);
    if (cached && cached.repoPath !== repoPath) {
      return {
        ok: false,
        refusalReason: `workstream already has a worktree for repo ${cached.repoPath}, cannot switch to ${repoPath}`,
      };
    }

    // The directory on disk — not the in-memory cache — is the real source of truth
    // for "has this workstream already been provisioned": the cache is empty after
    // every control-plane restart, but `git worktree add` still fails if the target
    // directory is already there from before the restart. Without this check, every
    // workstream's first acquire after a restart refused with "failed to create
    // worktree ... already exists", which broke a normal back-and-forth conversation
    // the moment the daemon had ever been restarted in between messages.
    if (existsSync(worktreePath)) {
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

      worktreePathCache.set(workstreamId, { repoPath, worktreePath });
      return {
        ok: true,
        workspaceDir: worktreePath,
      };
    }

    // First time this workstream has needed a worktree — create it.
    try {
      execFileSync("git", ["worktree", "add", worktreePath, "HEAD"], {
        cwd: repoPath,
        windowsHide: true,
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
          windowsHide: true,
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
