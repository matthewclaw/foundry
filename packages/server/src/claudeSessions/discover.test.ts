import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeProjectDir,
  listSessionGroups,
  readSessionDetail,
  resolveSessionPath,
  revealInFileExplorer,
} from "./discover.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
import { execFile } from "node:child_process";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** Mirrors Claude Code's own encoding: drive letter + colon + backslash → `--`, every
 * other path separator → `-`. Real repo names containing literal hyphens are what make
 * this lossy (see decodeProjectDir's doc comment) — deliberately exercised below. */
function encodePath(absPath: string): string {
  const driveMatch = /^([A-Za-z]):\\(.*)$/.exec(absPath);
  if (!driveMatch) throw new Error(`expected an absolute Windows path, got: ${absPath}`);
  return `${driveMatch[1]}--${(driveMatch[2] ?? "").replaceAll("\\", "-")}`;
}

function writeJsonl(path: string, lines: Record<string, unknown>[]): void {
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
}

describe("decodeProjectDir", () => {
  it("decodes a plain path with no ambiguous hyphens", () => {
    dir = mkdtempSync(join(tmpdir(), "foundry-decode-"));
    const real = join(dir, "plainrepo");
    mkdirSync(real, { recursive: true });

    expect(decodeProjectDir(encodePath(real))).toBe(real);
  });

  it("resolves a real folder name that itself contains hyphens (the ambiguous case)", () => {
    dir = mkdtempSync(join(tmpdir(), "foundry-decode-"));
    const real = join(dir, "bsp-bootstrap-job");
    mkdirSync(real, { recursive: true });

    expect(decodeProjectDir(encodePath(real))).toBe(real);
  });

  it("returns null when nothing on disk matches", () => {
    dir = mkdtempSync(join(tmpdir(), "foundry-decode-"));
    const fake = join(dir, "totally-fake-nonexistent-xyz123");

    expect(decodeProjectDir(encodePath(fake))).toBeNull();
  });
});

describe("listSessionGroups", () => {
  it("groups sessions by folder, resolves repoPath via cwd, skips subagent/memory dirs, and skips non-text lines when scanning for a preview", () => {
    dir = mkdtempSync(join(tmpdir(), "foundry-sessions-"));
    const root = join(dir, "projects");
    const projA = join(root, "c--repos-projA");
    mkdirSync(projA, { recursive: true });

    // Normal session: has a cwd line, a timestamp on its first line, and a real
    // user-text line.
    writeJsonl(join(projA, "11111111-1111-1111-1111-111111111111.jsonl"), [
      { type: "queue-operation", timestamp: "2026-07-01T09:00:00.000Z" },
      { type: "attachment", isSidechain: false, cwd: "C:\\repos\\projA", timestamp: "2026-07-01T09:00:01.000Z" },
      { type: "user", isSidechain: false, cwd: "C:\\repos\\projA", message: { role: "user", content: "Fix the bug" } },
      { type: "assistant", isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "Sure." }] } },
    ]);

    // Session whose first user-type line is a pure tool_result — must be skipped, scan
    // must continue to the later line with real text.
    writeJsonl(join(projA, "22222222-2222-2222-2222-222222222222.jsonl"), [
      { type: "user", isSidechain: false, message: { role: "user", content: [{ type: "tool_result", content: "4" }] } },
      { type: "user", isSidechain: false, message: { role: "user", content: "Now do the other thing" } },
    ]);

    // Sibling subagent transcript + per-project memory dir — must never appear as sessions.
    mkdirSync(join(projA, "11111111-1111-1111-1111-111111111111", "subagents"), { recursive: true });
    writeJsonl(join(projA, "11111111-1111-1111-1111-111111111111", "subagents", "agent-x.jsonl"), [
      { type: "user", isSidechain: true, message: { role: "user", content: "subagent prompt" } },
    ]);
    mkdirSync(join(projA, "memory"), { recursive: true });
    writeFileSync(join(projA, "memory", "note.md"), "not a session", "utf8");

    // A second project folder whose only session is a stub (no cwd, no readable text) —
    // exercises the decode-fallback path.
    const decodeTarget = join(dir, "repos", "stub-target");
    mkdirSync(decodeTarget, { recursive: true });
    const projB = join(root, encodePath(decodeTarget));
    mkdirSync(projB, { recursive: true });
    writeJsonl(join(projB, "33333333-3333-3333-3333-333333333333.jsonl"), [
      { type: "queue-operation" },
      { type: "queue-operation" },
    ]);

    const groups = listSessionGroups(root);

    expect(groups).toHaveLength(2);

    const groupA = groups.find((g) => g.projectDir === "c--repos-projA")!;
    expect(groupA.repoPath).toBe("C:\\repos\\projA");
    expect(groupA.repoPathResolved).toBe(true);
    expect(groupA.sessions).toHaveLength(2);
    const normalSession = groupA.sessions.find((s) => s.id === "11111111-1111-1111-1111-111111111111")!;
    expect(normalSession.preview).toBe("Fix the bug");
    expect(normalSession.startedAtMs).toBe(Date.parse("2026-07-01T09:00:00.000Z"));
    const skipSession = groupA.sessions.find((s) => s.id === "22222222-2222-2222-2222-222222222222")!;
    expect(skipSession.preview).toBe("Now do the other thing");
    expect(skipSession.startedAtMs).toBeNull();

    const groupB = groups.find((g) => g.projectDir === encodePath(decodeTarget))!;
    expect(groupB.repoPath).toBe(decodeTarget);
    expect(groupB.repoPathResolved).toBe(true);
    expect(groupB.sessions).toHaveLength(1);
    expect(groupB.sessions[0]!.preview).toBeNull();
  });

  it("returns an empty list when the root doesn't exist", () => {
    expect(listSessionGroups(join(tmpdir(), "foundry-does-not-exist-xyz"))).toEqual([]);
  });

  it("skips isMeta entries when scanning for a preview", () => {
    dir = mkdtempSync(join(tmpdir(), "foundry-sessions-"));
    const root = join(dir, "projects");
    const projA = join(root, "c--repos-projA");
    mkdirSync(projA, { recursive: true });
    writeJsonl(join(projA, "99999999-9999-9999-9999-999999999999.jsonl"), [
      { type: "user", isSidechain: false, isMeta: true, message: { role: "user", content: "Meta housekeeping" } },
      { type: "user", isSidechain: false, message: { role: "user", content: "Real first message" } },
    ]);

    const groups = listSessionGroups(root);

    expect(groups[0]!.sessions[0]!.preview).toBe("Real first message");
  });
});

describe("readSessionDetail / resolveSessionFile", () => {
  it("parses turns, dropping sidechain lines and tool-only turns with no text", () => {
    dir = mkdtempSync(join(tmpdir(), "foundry-detail-"));
    const projDir = join(dir, "c--repos-projA");
    mkdirSync(projDir, { recursive: true });
    const sessionId = "44444444-4444-4444-4444-444444444444";
    const filePath = join(projDir, `${sessionId}.jsonl`);
    writeJsonl(filePath, [
      { type: "user", isSidechain: false, timestamp: "2026-07-15T00:00:00Z", message: { role: "user", content: "Hello" } },
      { type: "assistant", isSidechain: false, message: { role: "assistant", content: [{ type: "tool_use", name: "Read" }] } },
      { type: "assistant", isSidechain: false, timestamp: "2026-07-15T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "Hi there" }] } },
      { type: "user", isSidechain: true, message: { role: "user", content: "subagent-only turn" } },
    ]);

    const detail = readSessionDetail(filePath, sessionId, "c--repos-projA");

    expect(detail.turns).toEqual([
      { role: "user", text: "Hello", timestamp: "2026-07-15T00:00:00Z" },
      { role: "assistant", text: "Hi there", timestamp: "2026-07-15T00:00:01Z" },
    ]);
  });

  it("concatenates every text block (not just the first), skips ide_opened_file notice blocks, and drops isMeta entries entirely", () => {
    dir = mkdtempSync(join(tmpdir(), "foundry-detail-"));
    const projDir = join(dir, "c--repos-projA");
    mkdirSync(projDir, { recursive: true });
    const sessionId = "88888888-8888-8888-8888-888888888888";
    const filePath = join(projDir, `${sessionId}.jsonl`);
    writeJsonl(filePath, [
      {
        type: "assistant",
        isSidechain: false,
        timestamp: "2026-07-16T00:00:00Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "First block." },
            { type: "text", text: "Second block." },
          ],
        },
      },
      {
        type: "user",
        isSidechain: false,
        timestamp: "2026-07-16T00:00:01Z",
        message: {
          role: "user",
          content: [
            { type: "text", text: "<ide_opened_file>The user opened some file.</ide_opened_file>" },
            { type: "text", text: "Real question here." },
          ],
        },
      },
      {
        type: "user",
        isMeta: true,
        isSidechain: false,
        timestamp: "2026-07-16T00:00:02Z",
        message: { role: "user", content: "Meta housekeeping message, not a real turn" },
      },
    ]);

    const detail = readSessionDetail(filePath, sessionId, "c--repos-projA");

    expect(detail.turns).toEqual([
      { role: "assistant", text: "First block.\nSecond block.", timestamp: "2026-07-16T00:00:00Z" },
      { role: "user", text: "Real question here.", timestamp: "2026-07-16T00:00:01Z" },
    ]);
  });

  it("accepted trade-off: a record that's pretty-printed across multiple physical lines is silently dropped, not reconstructed", () => {
    dir = mkdtempSync(join(tmpdir(), "foundry-detail-"));
    const projDir = join(dir, "c--repos-projA");
    mkdirSync(projDir, { recursive: true });
    const sessionId = "77777777-7777-7777-7777-777777777777";
    const filePath = join(projDir, `${sessionId}.jsonl`);
    // Real Claude Code output is always one compact object per line (verified against
    // every real session file on this machine — see discover.ts's splitJsonRecords doc
    // comment), so plain line-splitting is deliberately not defended against a record
    // that spans multiple physical lines: each of its lines fails to parse standalone
    // and is skipped, same tolerant "drop the bad entry" behaviour as any other
    // malformed line — it just never happens with a real writer.
    const prettyPrinted = JSON.stringify(
      {
        type: "assistant",
        isSidechain: false,
        timestamp: "2026-07-15T00:00:02Z",
        message: { role: "assistant", content: [{ type: "text", text: "Would be dropped" }] },
      },
      null,
      2
    );
    const compactBefore = JSON.stringify({
      type: "user",
      isSidechain: false,
      timestamp: "2026-07-15T00:00:00Z",
      message: { role: "user", content: "Before" },
    });
    const compactAfter = JSON.stringify({
      type: "user",
      isSidechain: false,
      timestamp: "2026-07-15T00:00:03Z",
      message: { role: "user", content: "After" },
    });
    writeFileSync(filePath, [compactBefore, prettyPrinted, compactAfter].join("\n") + "\n", "utf8");

    const detail = readSessionDetail(filePath, sessionId, "c--repos-projA");

    expect(detail.turns).toEqual([
      { role: "user", text: "Before", timestamp: "2026-07-15T00:00:00Z" },
      { role: "user", text: "After", timestamp: "2026-07-15T00:00:03Z" },
    ]);
  });

  it("resolveSessionPath rejects malformed/traversal params but doesn't check existence", () => {
    dir = mkdtempSync(join(tmpdir(), "foundry-resolve-"));
    const projDir = join(dir, "c--repos-projA");
    mkdirSync(projDir, { recursive: true });
    const sessionId = "55555555-5555-5555-5555-555555555555";
    writeJsonl(join(projDir, `${sessionId}.jsonl`), [{ type: "user", message: { role: "user", content: "hi" } }]);

    expect(resolveSessionPath(dir, "c--repos-projA", sessionId)).toBe(join(projDir, `${sessionId}.jsonl`));
    // Valid shape, file doesn't exist — still resolves; existence is the route's job (404).
    expect(resolveSessionPath(dir, "c--repos-projA", "66666666-6666-6666-6666-666666666666")).toBe(
      join(projDir, "66666666-6666-6666-6666-666666666666.jsonl")
    );
    expect(resolveSessionPath(dir, "../../etc", sessionId)).toBeNull();
    expect(resolveSessionPath(dir, "c--repos-projA", "../../../etc/passwd")).toBeNull();
    expect(resolveSessionPath(dir, "c--repos-projA", "not-a-real-uuid")).toBeNull();
  });
});

describe("revealInFileExplorer", () => {
  const originalPlatform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    vi.mocked(execFile).mockClear();
  });

  it("uses explorer.exe /select, on Windows", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    revealInFileExplorer("C:\\repos\\ade\\file.jsonl");
    expect(execFile).toHaveBeenCalledWith("explorer.exe", ["/select,C:\\repos\\ade\\file.jsonl"], expect.any(Function));
  });

  it("uses open -R on macOS", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    revealInFileExplorer("/repos/ade/file.jsonl");
    expect(execFile).toHaveBeenCalledWith("open", ["-R", "/repos/ade/file.jsonl"], expect.any(Function));
  });

  it("uses xdg-open on the containing folder on Linux", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    revealInFileExplorer("/repos/ade/file.jsonl");
    expect(execFile).toHaveBeenCalledWith("xdg-open", ["/repos/ade"], expect.any(Function));
  });
});
