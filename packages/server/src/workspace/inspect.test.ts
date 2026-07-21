import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, Workstream } from "@foundry/core";
import { resolveWorkspaceDir, inspectWorkspace, promoteToBranch, branchNameFor } from "./inspect.js";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "foundry-ws-"));
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t"]);
  git(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "README.md"), "# repo\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "init"]);
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

const ws = (over: Partial<Workstream> = {}): Workstream =>
  ({ id: "01HWSABCDEF0000000000MKA9HP", agent_id: "01AG", title: "Fix the login bug!", workspace_ref: null, ...over }) as Workstream;
const agent = (over: Partial<Agent> = {}): Agent => ({ id: "01AG", default_workspace_ref: null, ...over }) as Agent;

describe("resolveWorkspaceDir", () => {
  it("uses the workstream ref, else the agent default, else scratch — matching the runtime paths", () => {
    const data = "/data";
    expect(resolveWorkspaceDir(data, ws({ workspace_ref: { kind: "plain_dir", path: "/x" } }), agent()).path).toBe("/x");
    expect(
      resolveWorkspaceDir(data, ws(), agent({ default_workspace_ref: { kind: "git_worktree", repo_path: "/r", worktree_path: "/r", branch: "main" } })).kind
    ).toBe("git_worktree");
    const scratch = resolveWorkspaceDir(data, ws(), agent());
    expect(scratch.kind).toBe("scratch");
    expect(scratch.path).toContain("scratch-01HWSABCDEF0000000000MKA9HP");
  });
});

describe("inspectWorkspace", () => {
  it("reports a missing dir, and lists untracked changes for a git dir", () => {
    expect(inspectWorkspace("/definitely/not/here", "scratch")).toMatchObject({ exists: false, git: null });

    writeFileSync(join(repo, "new.md"), "hi");
    const info = inspectWorkspace(repo, "git_worktree");
    expect(info.exists).toBe(true);
    expect(info.git?.branch).toBe("main");
    expect(info.git?.changed).toEqual([{ status: "??", path: "new.md" }]);
    expect(info.git?.committed).toBe(false);
  });
});

describe("promoteToBranch", () => {
  it("commits the working changes onto a new branch, visible from the repo", () => {
    writeFileSync(join(repo, "agent-work.md"), "done");
    const branch = branchNameFor(ws());
    expect(branch).toBe("foundry/fix-the-login-bug-mka9hp");

    const result = promoteToBranch(repo, branch, "Foundry: work");
    expect(result.ok).toBe(true);
    expect(git(repo, ["branch", "--list", branch]).trim()).toContain(branch);
    expect(git(repo, ["log", "-1", "--pretty=%s", branch]).trim()).toBe("Foundry: work");
    expect(git(repo, ["show", "--stat", "--oneline", branch])).toContain("agent-work.md");
  });

  it("refuses when there's nothing to promote", () => {
    expect(promoteToBranch(repo, "foundry/x", "m")).toMatchObject({ ok: false });
  });
});
