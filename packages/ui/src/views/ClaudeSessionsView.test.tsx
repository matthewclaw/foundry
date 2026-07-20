import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ClaudeSessionDetailDto, ClaudeSessionGroupDto } from "../api/types.js";
import ClaudeSessionsView, { buildSessionTree } from "./ClaudeSessionsView.js";

vi.mock("../api/client.js", () => ({
  apiClient: {
    getClaudeSessions: vi.fn(),
    getClaudeSessionDetail: vi.fn(),
    revealClaudeSession: vi.fn(),
  },
}));
import { apiClient } from "../api/client.js";

const SESSION_1 = "11111111-1111-1111-1111-111111111111";
const SESSION_2 = "22222222-2222-2222-2222-222222222222";
const SESSION_3 = "33333333-3333-3333-3333-333333333333";
const SESSION_1_PATH = "C:\\repos\\ade\\.claude\\session1.jsonl";

const groups: ClaudeSessionGroupDto[] = [
  {
    projectDir: "c--repos-ade",
    repoPath: "C:\\repos\\ade",
    repoPathResolved: true,
    lastActiveAtMs: 2,
    sessions: [
      { id: SESSION_1, filePath: SESSION_1_PATH, startedAtMs: 1, mtimeMs: 2, sizeBytes: 100, preview: "Fix the bug" },
      { id: SESSION_2, filePath: "C:\\repos\\ade\\.claude\\session2.jsonl", startedAtMs: null, mtimeMs: 1, sizeBytes: 100, preview: "Add a test" },
    ],
  },
  {
    projectDir: "c--repos-unknown",
    repoPath: "c--repos-unknown",
    repoPathResolved: false,
    lastActiveAtMs: 0,
    sessions: [
      { id: SESSION_3, filePath: "c--repos-unknown\\session3.jsonl", startedAtMs: null, mtimeMs: 0, sizeBytes: 50, preview: null },
    ],
  },
];

const detail: ClaudeSessionDetailDto = {
  id: SESSION_1,
  projectDir: "c--repos-ade",
  mtimeMs: 2,
  sizeBytes: 100,
  turns: [
    { role: "user", text: "Fix the bug", timestamp: "2026-07-15T00:00:00Z" },
    { role: "assistant", text: "Done, **fixed** it.", timestamp: "2026-07-15T00:00:01Z" },
  ],
};

function renderView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/claude-sessions"]}>
        <Routes>
          <Route path="/claude-sessions" element={<ClaudeSessionsView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("buildSessionTree", () => {
  it("compacts a single-child folder chain into one combined segment", () => {
    const tree = buildSessionTree(groups, "\\");
    // C: -> repos -> ade all have a single child (until ade's chats) → one node.
    const ade = tree.find((n) => n.name === "C:\\repos\\ade");
    expect(ade).toBeTruthy();
    expect(ade!.group?.projectDir).toBe("c--repos-ade");
    expect(ade!.folders).toHaveLength(0);
    // the single-segment unresolved path stays as-is.
    const unknown = tree.find((n) => n.name === "c--repos-unknown");
    expect(unknown?.group?.repoPathResolved).toBe(false);
  });

  it("stops compacting at a fork where a folder has multiple children", () => {
    const tree = buildSessionTree(
      [
        { ...groups[0]!, projectDir: "a", repoPath: "C:\\repos\\ade", sessions: [] },
        { ...groups[0]!, projectDir: "b", repoPath: "C:\\repos\\other", sessions: [] },
      ],
      "\\"
    );
    const repos = tree.find((n) => n.name === "C:\\repos");
    expect(repos).toBeTruthy();
    expect(repos!.folders.map((f) => f.name).sort()).toEqual(["ade", "other"]);
  });

  it("groups paths that differ only in case under one node (Windows is case-insensitive)", () => {
    const tree = buildSessionTree(
      [
        { ...groups[0]!, projectDir: "a", repoPath: "c:\\repos\\ade", sessions: [] },
        { ...groups[0]!, projectDir: "b", repoPath: "C:\\repos\\other", sessions: [] },
      ],
      "\\"
    );
    // One root, not two — `c:` and `C:` are the same drive.
    expect(tree).toHaveLength(1);
    expect(tree[0]!.folders.map((f) => f.name).sort()).toEqual(["ade", "other"]);
  });
});

describe("ClaudeSessionsView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the folder tree with compacted paths, its chats, and the unresolved hint", async () => {
    vi.mocked(apiClient.getClaudeSessions).mockResolvedValue({ groups });
    renderView();

    await screen.findByText("C:\\repos\\ade");
    expect(screen.getByText("c--repos-unknown")).toBeTruthy();
    expect(screen.getByText("path not found on disk")).toBeTruthy();
    // Folders default to expanded, so chats show in the explorer immediately.
    expect(screen.getByText("Fix the bug")).toBeTruthy();
    expect(screen.getByText("Add a test")).toBeTruthy();
    // Nothing selected yet — the transcript pane prompts, and no detail is fetched.
    expect(screen.getByText("Select a chat")).toBeTruthy();
    expect(apiClient.getClaudeSessionDetail).not.toHaveBeenCalled();
  });

  it("selecting a chat loads its transcript (markdown rendered) and shows its dates + id chip", async () => {
    vi.mocked(apiClient.getClaudeSessions).mockResolvedValue({ groups });
    vi.mocked(apiClient.getClaudeSessionDetail).mockResolvedValue(detail);
    renderView();

    const chip = await screen.findByText(SESSION_1.slice(0, 8));
    expect(chip.getAttribute("title")).toBe(SESSION_1_PATH);

    fireEvent.click(screen.getByText("Fix the bug"));
    await screen.findByText("Done, ", { exact: false });
    expect(apiClient.getClaudeSessionDetail).toHaveBeenCalledWith("c--repos-ade", SESSION_1);
    // Markdown renders — bold becomes <strong>, not literal asterisks.
    expect(screen.getByText("fixed").tagName).toBe("STRONG");
    // Dates live in the transcript header.
    expect(screen.getByText(/started .* · last active/)).toBeTruthy();
  });

  it("clicking the id chip reveals the file without selecting the chat", async () => {
    vi.mocked(apiClient.getClaudeSessions).mockResolvedValue({ groups });
    vi.mocked(apiClient.revealClaudeSession).mockResolvedValue({ ok: true });
    renderView();

    const chip = await screen.findByText(SESSION_1.slice(0, 8));
    fireEvent.click(chip);

    await waitFor(() => expect(apiClient.revealClaudeSession).toHaveBeenCalledWith("c--repos-ade", SESSION_1));
    // stopPropagation: the row's select handler must not fire, so no transcript loads.
    expect(apiClient.getClaudeSessionDetail).not.toHaveBeenCalled();
    expect(screen.queryByText("Done, ", { exact: false })).toBeNull();
  });

  it("collapsing a folder hides its chats", async () => {
    vi.mocked(apiClient.getClaudeSessions).mockResolvedValue({ groups });
    renderView();

    await screen.findByText("Fix the bug");
    fireEvent.click(screen.getByText("C:\\repos\\ade"));
    expect(screen.queryByText("Fix the bug")).toBeNull();
  });

  it("closes the transcript panel, then reopens it when a chat is selected", async () => {
    vi.mocked(apiClient.getClaudeSessions).mockResolvedValue({ groups });
    vi.mocked(apiClient.getClaudeSessionDetail).mockResolvedValue(detail);
    renderView();

    fireEvent.click(await screen.findByText("Fix the bug"));
    await screen.findByText("Done, ", { exact: false });

    // Close → the transcript pane unmounts, the explorer stays.
    fireEvent.click(screen.getByLabelText("Close panel"));
    expect(screen.queryByText("Done, ", { exact: false })).toBeNull();
    expect(screen.queryByLabelText("Close panel")).toBeNull();
    expect(screen.getByText("C:\\repos\\ade")).toBeTruthy();

    // Selecting another chat brings the panel back.
    fireEvent.click(screen.getByText("Add a test"));
    expect(screen.getByLabelText("Close panel")).toBeTruthy();
  });

  it("renders an empty state when there are no sessions", async () => {
    vi.mocked(apiClient.getClaudeSessions).mockResolvedValue({ groups: [] });
    renderView();
    await screen.findByText("No sessions found.");
  });

  it("renders loading and error states", async () => {
    vi.mocked(apiClient.getClaudeSessions).mockImplementation(() => new Promise(() => {}));
    renderView();
    expect(screen.getByText("Loading Claude sessions…")).toBeTruthy();
  });

  it("renders an error message on API failure", async () => {
    vi.mocked(apiClient.getClaudeSessions).mockRejectedValue(new Error("Network error"));
    renderView();
    await screen.findByText("Something went wrong");
    await screen.findByText("Network error");
  });
});
