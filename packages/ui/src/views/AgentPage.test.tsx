/**
 * E7.3 tests: agent page renders its sections from a fixture agentPage projection;
 * the charter edit flow PATCHes {charter_md} and invalidates (refetches) the agent query.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentPageDto } from "../api/types.js";
import AgentPage from "./AgentPage.js";

vi.mock("../api/client.js", () => ({
  apiClient: { getAgent: vi.fn(), patchAgent: vi.fn() },
}));
import { apiClient } from "../api/client.js";

const fixture: AgentPageDto = {
  agent: {
    id: "ag1" as AgentPageDto["agent"]["id"],
    name: "Orbit Backend Engineer",
    role: "Backend",
    team_id: null,
    state: "active",
    engine: { id: "claude-code" },
  },
  charter: { version: 3, body_md: "# Purpose\nKeep the backend healthy." },
  status: "waiting",
  workstreams: [
    { id: "ws1", title: "Authentication Refactor", state: "active" },
    { id: "ws2", title: "Bug #482", state: "waiting" },
  ],
  openTasks: [{ id: "t1", spec_md: "Fix the login timeout", state: "in_progress" }],
  relationships: [{ actor_id: "actor-99", weight: 4, last_interaction_at: "2026-07-01T00:00:00Z" }],
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/agents/ag1"]}>
        <Routes>
          <Route path="/agents/:id" element={<AgentPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("AgentPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiClient.getAgent).mockResolvedValue(fixture);
  });

  it("renders header, charter, workstreams (linked), tasks, relationships, engine", async () => {
    renderPage();

    await screen.findByText("Orbit Backend Engineer");
    // status badge (also appears as ws2's state text, hence AllBy)
    expect(screen.getAllByText("waiting").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/engine: claude-code/)).toBeTruthy();
    expect(screen.getByText("v3")).toBeTruthy();
    expect(screen.getByText(/Keep the backend healthy/)).toBeTruthy();
    expect(screen.getByText(/Fix the login timeout/)).toBeTruthy();
    expect(screen.getByText(/actor-99/)).toBeTruthy();

    const wsLink = screen.getByText("Authentication Refactor");
    expect(wsLink.getAttribute("href")).toBe("/workstreams/ws1");
  });

  it("charter edit round-trips: PATCHes {charter_md} and refetches the agent", async () => {
    vi.mocked(apiClient.patchAgent).mockResolvedValue({});
    renderPage();

    await screen.findByText("Orbit Backend Engineer");
    fireEvent.click(screen.getByText("Edit"));

    const editor = screen.getByLabelText("Charter editor");
    fireEvent.change(editor, { target: { value: "# New charter" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() =>
      expect(apiClient.patchAgent).toHaveBeenCalledWith("ag1", { charter_md: "# New charter" })
    );
    // invalidation → refetch of ["agent", id]
    await waitFor(() => expect(vi.mocked(apiClient.getAgent).mock.calls.length).toBeGreaterThanOrEqual(2));
  });
});
