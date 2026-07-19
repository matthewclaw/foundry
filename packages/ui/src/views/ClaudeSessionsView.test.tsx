import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ClaudeSessionDetailDto, ClaudeSessionGroupDto } from "../api/types.js";
import ClaudeSessionsView from "./ClaudeSessionsView.js";

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

describe("ClaudeSessionsView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders groups collapsed, with repo path, session count, and unresolved-path hint", async () => {
    vi.mocked(apiClient.getClaudeSessions).mockResolvedValue({ groups });

    renderView();

    await screen.findByText("C:\\repos\\ade");
    expect(screen.getByText("2 chats")).toBeTruthy();
    expect(screen.getByText("c--repos-unknown")).toBeTruthy();
    expect(screen.getByText("path not found on disk")).toBeTruthy();
    // Sessions aren't shown until the group is expanded.
    expect(screen.queryByText("Fix the bug")).toBeNull();
  });

  it("expanding a group shows an id chip (first 8 chars, full file path as tooltip) and both dates; expanding a row lazily fetches its transcript", async () => {
    vi.mocked(apiClient.getClaudeSessions).mockResolvedValue({ groups });
    vi.mocked(apiClient.getClaudeSessionDetail).mockResolvedValue(detail);

    renderView();

    fireEvent.click(await screen.findByText("C:\\repos\\ade"));
    await screen.findByText("Fix the bug");
    expect(apiClient.getClaudeSessionDetail).not.toHaveBeenCalled();

    const chip = screen.getByText(SESSION_1.slice(0, 8));
    expect(chip.getAttribute("title")).toBe(SESSION_1_PATH);
    // Session with a startedAtMs shows both dates; the one without only shows "last active".
    expect(screen.getByText(/started .* · last active/)).toBeTruthy();
    expect(screen.getByText(/^last active/)).toBeTruthy();

    fireEvent.click(screen.getByText("Fix the bug"));
    await screen.findByText("Done, ", { exact: false });
    expect(apiClient.getClaudeSessionDetail).toHaveBeenCalledWith("c--repos-ade", SESSION_1);
    // Markdown renders — bold text becomes a <strong>, not literal asterisks.
    expect(screen.getByText("fixed").tagName).toBe("STRONG");
  });

  it("clicking the id chip reveals the file without toggling the row's expand state", async () => {
    vi.mocked(apiClient.getClaudeSessions).mockResolvedValue({ groups });
    vi.mocked(apiClient.revealClaudeSession).mockResolvedValue({ ok: true });

    renderView();

    fireEvent.click(await screen.findByText("C:\\repos\\ade"));
    const chip = await screen.findByText(SESSION_1.slice(0, 8));

    fireEvent.click(chip);

    await waitFor(() => expect(apiClient.revealClaudeSession).toHaveBeenCalledWith("c--repos-ade", SESSION_1));
    // Clicking the chip must not also expand the row (stopPropagation).
    expect(apiClient.getClaudeSessionDetail).not.toHaveBeenCalled();
    expect(screen.queryByText("Done, ", { exact: false })).toBeNull();
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
