/**
 * E11.1 — git-versioned agent memory (doc-05 "Declarative memory", ADR-007): each
 * agent's memory dir is a git repo, auto-committed after runs that touched it, so
 * "what did it believe in March, and when did that change?" is `git log`. Human edits
 * and agent edits coexist because every run-end commit sweeps whatever is dirty —
 * append-discipline, no merges (doc-05: "merge-free append discipline").
 *
 * E11.4: Skills directory uses the same git-versioning pattern. Each agent's skills
 * dir is independently git-versioned, same best-effort semantics.
 *
 * Best-effort by design: memory/skills versioning must never fail a run.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

/**
 * Commits any pending changes in a given directory. Generic git-versioning for both
 * memory and skills directories. Returns true if a commit was made.
 */
function commitDirectory(dir: string, message: string): boolean {
  try {
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
    // ponytail: versioning is best-effort — a git hiccup must never fail a run.
    return false;
  }
}

/** Commits any pending changes in the agent's memory dir. Returns true if a commit was made. */
export function commitAgentMemory(dataDir: string, memoryRef: string, message: string): boolean {
  const dir = resolve(dataDir, memoryRef);
  return commitDirectory(dir, message);
}

/** Commits any pending changes in the agent's skills dir. Returns true if a commit was made. */
export function commitAgentSkills(dataDir: string, memoryRef: string, message: string): boolean {
  const skillsDir = resolve(dataDir, memoryRef.replace(/[\\/]memory$/, ""), "skills");
  return commitDirectory(skillsDir, message);
}
