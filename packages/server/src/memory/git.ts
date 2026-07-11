/**
 * E11.1 — git-versioned agent memory (doc-05 "Declarative memory", ADR-007): each
 * agent's memory dir is a git repo, auto-committed after runs that touched it, so
 * "what did it believe in March, and when did that change?" is `git log`. Human edits
 * and agent edits coexist because every run-end commit sweeps whatever is dirty —
 * append-discipline, no merges (doc-05: "merge-free append discipline").
 *
 * Best-effort by design: memory versioning must never fail a run.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

/** Commits any pending changes in the agent's memory dir. Returns true if a commit was made. */
export function commitAgentMemory(dataDir: string, memoryRef: string, message: string): boolean {
  try {
    const dir = resolve(dataDir, memoryRef);
    if (!existsSync(dir)) return false;
    if (!existsSync(join(dir, ".git"))) {
      git(dir, "init");
    }
    git(dir, "add", "-A");
    const staged = git(dir, "status", "--porcelain");
    if (staged.trim().length === 0) return false;
    git(
      dir,
      "-c",
      "user.name=foundry",
      "-c",
      "user.email=foundry@localhost",
      "commit",
      "-m",
      message,
      "--no-gpg-sign"
    );
    return true;
  } catch {
    // ponytail: memory versioning is best-effort — a git hiccup must never fail a run.
    return false;
  }
}
