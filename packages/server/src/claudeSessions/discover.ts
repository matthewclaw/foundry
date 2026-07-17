/**
 * Claude Code writes one JSONL transcript per session under
 * `~/.claude/projects/<encoded-repo-path>/<session-uuid>.jsonl` — for every session,
 * whether Foundry started it or a human ran `claude` directly in a terminal. This module
 * discovers those files (read-only, entirely outside Foundry's own store) so they can be
 * browsed grouped by the real repo folder they belong to.
 *
 * Tolerance rule (same as skills/discover.ts): the on-disk format is open-ended (new
 * `type`s appear over time) and files can be mid-write — never throw on a bad file or a
 * bad line, just skip it.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, join, resolve, sep } from "node:path";

export interface ClaudeSessionSummary {
  id: string;
  filePath: string;
  startedAtMs: number | null;
  mtimeMs: number;
  sizeBytes: number;
  preview: string | null;
}

export interface ClaudeSessionGroup {
  projectDir: string;
  repoPath: string;
  repoPathResolved: boolean;
  lastActiveAtMs: number;
  sessions: ClaudeSessionSummary[];
}

export interface ClaudeSessionTurn {
  role: "user" | "assistant";
  text: string;
  timestamp: string | null;
}

export interface ClaudeSessionDetail {
  id: string;
  projectDir: string;
  mtimeMs: number;
  sizeBytes: number;
  turns: ClaudeSessionTurn[];
}

const PREVIEW_MAX_CHARS = 200;
const PREVIEW_READ_BYTES = 65536;

/** Extracts the readable text from a `user`/`assistant` message's `content` field — a
 * plain string for simple turns, or every `text` block joined with `\n` for a
 * multi-block turn (tool_use/tool_result/thinking blocks are not readable transcript
 * text). Skips IDE "opened file" notice blocks — noise from the editor, not something
 * either party actually said. */
function parseContent(content: unknown): string | null {
  if (typeof content === "string") return content.length > 0 ? content : null;
  if (Array.isArray(content)) {
    let text = "";
    for (const block of content as Record<string, unknown>[]) {
      if (block?.type === "text" && typeof block.text === "string" && block.text.length > 0) {
        if (isIdeFile(block.text)) continue;
        text += block.text + "\n";
      }
    }
    return text.length > 0 ? text.trimEnd() : null;
  }
  return null;
}

function isIdeFile(text: string): boolean {
  return text.trim().startsWith("<ide_opened_file>");
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Splits NDJSON text into lines. A compliant JSON writer (Claude Code's is — verified
 * against every real session file on this machine, 23k+ lines, zero exceptions) always
 * escapes an embedded newline inside a string value as the two-character `\n` sequence,
 * never a raw byte — so a real record can never actually straddle a line break. Plain
 * splitting is therefore correct, not just convenient; a hand-rolled brace-depth tracker
 * would only earn its complexity if a non-compliant writer were ever observed in practice. */
function splitJsonRecords(text: string): string[] {
  return text.split("\n").filter((line) => line.trim().length > 0);
}

/** Bounded read: never `readFileSync` a whole session file just to preview it — some are
 * double-digit MB. 64KB reliably contains both the first `cwd` line and the first real
 * user-text line (8KB was tried and found insufficient: a single hook-injection line can
 * be ~7.6KB on its own). */
export function readSessionPreview(
  filePath: string
): { cwd: string | null; preview: string | null; startedAtMs: number | null } {
  const buf = Buffer.alloc(PREVIEW_READ_BYTES);
  const fd = openSync(filePath, "r");
  let bytesRead = 0;
  try {
    bytesRead = readSync(fd, buf, 0, PREVIEW_READ_BYTES, 0);
  } finally {
    closeSync(fd);
  }

  let cwd: string | null = null;
  let preview: string | null = null;
  let startedAtMs: number | null = null;
  const records = splitJsonRecords(buf.subarray(0, bytesRead).toString("utf8"));
  for (const record of records) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(record) as Record<string, unknown>;
    } catch {
      continue; // malformed or truncated (last record of the read window) — skip
    }
    // Lines appear in chronological order, so the first parseable timestamp — of any
    // line type, not just user/assistant — is when this session actually started.
    if (startedAtMs === null && typeof entry.timestamp === "string") {
      const parsed = Date.parse(entry.timestamp);
      if (!Number.isNaN(parsed)) startedAtMs = parsed;
    }
    if (cwd === null && typeof entry.cwd === "string") cwd = entry.cwd;
    if (preview === null && entry.type === "user" && entry.isSidechain !== true && entry.isMeta !== true) {
      const message = entry.message as Record<string, unknown> | undefined;
      const text = parseContent(message?.content);
      if (text) preview = truncate(text, PREVIEW_MAX_CHARS);
    }
    if (cwd !== null && preview !== null && startedAtMs !== null) break;
  }
  return { cwd, preview, startedAtMs };
}

/** Fallback only — used when no session in a project folder yields a `cwd`. The encoded
 * folder name is lossy (both `:` and path separators become `-`, and real repo names can
 * themselves contain hyphens), so this walks greedily left to right, testing each prefix
 * against the real filesystem rather than guessing blindly.
 * ponytail: greedy fallback, only reached when a folder has zero sessions with a
 * recoverable cwd — upgrade to exhaustive backtracking only if this is observed to
 * mis-decode a real folder. */
export function decodeProjectDir(encoded: string): string | null {
  let root: string;
  let rest: string;
  const driveMatch = /^([A-Za-z])--(.*)$/.exec(encoded);
  if (driveMatch) {
    root = `${driveMatch[1]}:\\`;
    rest = driveMatch[2] ?? "";
  } else if (encoded.startsWith("-")) {
    root = "/";
    rest = encoded.slice(1);
  } else {
    return null;
  }

  let current = root;
  let pending = "";
  for (const segment of rest.split("-")) {
    pending = pending ? `${pending}-${segment}` : segment;
    const candidate = join(current, pending);
    if (existsSync(candidate)) {
      current = candidate;
      pending = "";
    }
  }
  if (pending) {
    const candidate = join(current, pending);
    if (existsSync(candidate)) {
      current = candidate;
      pending = "";
    }
  }
  // Only trust a *fully* resolved path — a real-but-incomplete ancestor (the leaf
  // segment never matched, e.g. the repo was deleted/renamed) is worse than admitting
  // we don't know, since the caller displays this as "the repo folder."
  return pending === "" && current !== root ? current : null;
}

/** Lists every top-level session file (never recurses — this naturally excludes a
 * session's own `<uuid>/subagents/` folder and Claude Code's per-project `memory/`
 * folder, since both are directories, not `.jsonl` files) grouped by project, sorted
 * most-recently-active first. */
export function listSessionGroups(root: string): ClaudeSessionGroup[] {
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

  const groups: ClaudeSessionGroup[] = [];
  for (const projectDir of projectDirs) {
    try {
      const dirPath = join(root, projectDir);
      const files = readdirSync(dirPath, { withFileTypes: true }).filter(
        (e) => e.isFile() && e.name.endsWith(".jsonl")
      );
      if (files.length === 0) continue;

      const sessions: ClaudeSessionSummary[] = [];
      let cwd: string | null = null;
      for (const file of files) {
        try {
          const filePath = join(dirPath, file.name);
          const stat = statSync(filePath);
          const { cwd: fileCwd, preview, startedAtMs } = readSessionPreview(filePath);
          if (cwd === null && fileCwd) cwd = fileCwd;
          sessions.push({
            id: file.name.slice(0, -".jsonl".length),
            filePath,
            startedAtMs,
            mtimeMs: stat.mtimeMs,
            sizeBytes: stat.size,
            preview,
          });
        } catch {
          // Unreadable/mid-write session file — skip just this one
        }
      }
      if (sessions.length === 0) continue;
      sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);

      const decoded = cwd ?? decodeProjectDir(projectDir);
      groups.push({
        projectDir,
        repoPath: decoded ?? projectDir,
        repoPathResolved: decoded !== null,
        lastActiveAtMs: sessions[0]!.mtimeMs,
        sessions,
      });
    } catch {
      // Unreadable project folder — skip it
    }
  }

  groups.sort((a, b) => b.lastActiveAtMs - a.lastActiveAtMs);
  return groups;
}

/** Full parse of one session file (only ever called for a single, user-opened session —
 * not for the list view). Drops subagent sidechain lines and any turn that resolves to
 * no readable text (e.g. a tool-only assistant turn). */
export function readSessionDetail(filePath: string, id: string, projectDir: string): ClaudeSessionDetail {
  const stat = statSync(filePath);
  const turns: ClaudeSessionTurn[] = [];
  const raw = readFileSync(filePath, "utf8");
  for (const record of splitJsonRecords(raw)) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(record) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.isSidechain === true) continue;
    if (entry.isMeta === true) continue;
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    const message = entry.message as Record<string, unknown> | undefined;
    const text = parseContent(message?.content);
    if (!text) continue;
    turns.push({
      role: entry.type,
      text,
      timestamp: typeof entry.timestamp === "string" ? entry.timestamp : null,
    });
  }
  return { id, projectDir, mtimeMs: stat.mtimeMs, sizeBytes: stat.size, turns };
}

/** Opens the OS file browser with the session file pre-selected in its folder — the
 * "navigate to the file" affordance for the id chip. Fire-and-forget: explorer.exe
 * notoriously exits nonzero even on success, so the callback only exists to swallow
 * spawn errors (e.g. explorer.exe missing), not to report success. */
export function revealInFileExplorer(filePath: string): void {
  if (process.platform === "win32") {
    execFile("explorer.exe", [`/select,${filePath}`], () => undefined);
  } else if (process.platform === "darwin") {
    execFile("open", ["-R", filePath], () => undefined);
  } else {
    execFile("xdg-open", [dirname(filePath)], () => undefined);
  }
}

/** Validates untrusted URL segments before they're used to build a filesystem path
 * (real trust boundary — this data comes straight from the request) and returns the
 * resolved, verified-inside-root file path. Does NOT check existence — an invalid
 * shape (400) and a valid-but-missing file (404) are different problems, left to the
 * caller to distinguish. */
export function resolveSessionPath(root: string, projectDir: string, sessionId: string): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(projectDir)) return null;
  if (!/^[0-9a-f-]{36}$/.test(sessionId)) return null;
  const resolvedRoot = resolve(root, projectDir);
  const filePath = resolve(resolvedRoot, `${sessionId}.jsonl`);
  if (!filePath.startsWith(resolvedRoot + sep)) return null;
  return filePath;
}
