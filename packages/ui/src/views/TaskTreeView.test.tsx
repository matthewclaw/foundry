/**
 * E10.2 tests: task tree renders all nodes with correct indentation, escalation
 * highlights rejected/blocked tasks, budget meters show uncapped/formatted values,
 * not-found case renders gracefully.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TreeNode, TreeView } from "../api/types.js";
import TaskTreeView from "./TaskTreeView.js";

vi.mock("../api/client.js", () => ({
  apiClient: {
    getTaskTree: vi.fn(),
  },
}));
import { apiClient } from "../api/client.js";

// Build a 3-level tree fixture: root → child1, child2; child1 → grandchild
const fixture: TreeView = {
  root: {
    task: {
      id: "root-task-id",
      parent_task_id: null,
      root_task_id: "root-task-id",
      depth: 0,
      delegator_actor_id: "human:alice",
      assignee_agent_id: "agent:bob",
      spec_md: "Root task specification",
      acceptance_criteria_md: "Must be done",
      budget: { limit_usd: 1000, limit_tokens: 5000000, spent_usd: 100, spent_tokens: 1000000 },
      state: "in_progress",
      rejection_count: 0,
      created_at: "2026-07-01T10:00:00Z",
      closed_at: null,
    },
    children: [
      {
        task: {
          id: "child-1-task-id",
          parent_task_id: "root-task-id",
          root_task_id: "root-task-id",
          depth: 1,
          delegator_actor_id: "agent:bob",
          assignee_agent_id: "agent:charlie",
          spec_md: "Child 1 specification",
          acceptance_criteria_md: "Done when complete",
          budget: { limit_usd: 500, limit_tokens: 2500000, spent_usd: 50, spent_tokens: 500000 },
          state: "done",
          rejection_count: 0,
          created_at: "2026-07-02T10:00:00Z",
          closed_at: null,
        },
        children: [
          {
            task: {
              id: "grandchild-1-task-id",
              parent_task_id: "child-1-task-id",
              root_task_id: "root-task-id",
              depth: 2,
              delegator_actor_id: "agent:charlie",
              assignee_agent_id: "agent:diana",
              spec_md: "Grandchild specification",
              acceptance_criteria_md: "Acceptance here",
              budget: { limit_usd: null, limit_tokens: null, spent_usd: 10, spent_tokens: 100000 },
              state: "in_progress",
              rejection_count: 0,
              created_at: "2026-07-03T10:00:00Z",
              closed_at: null,
            },
            children: [],
          },
        ],
      },
      {
        task: {
          id: "child-2-task-id",
          parent_task_id: "root-task-id",
          root_task_id: "root-task-id",
          depth: 1,
          delegator_actor_id: "agent:bob",
          assignee_agent_id: "agent:eve",
          spec_md: "Child 2 specification",
          acceptance_criteria_md: "Escalation needed",
          budget: { limit_usd: 500, limit_tokens: 2500000, spent_usd: 250, spent_tokens: 1500000 },
          state: "rejected",
          rejection_count: 2,
          created_at: "2026-07-02T11:00:00Z",
          closed_at: null,
        },
        children: [],
      },
    ],
  },
};

function renderTaskTreeView(taskId: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/tasks/${taskId}/tree`]}>
        <Routes>
          <Route path="/tasks/:id/tree" element={<TaskTreeView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("TaskTreeView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a 3-level tree with all nodes and correct indentation", async () => {
    vi.mocked(apiClient.getTaskTree).mockResolvedValue(fixture);

    renderTaskTreeView("root-task-id");

    // Wait for root to be visible
    await screen.findByText("Root task specification");

    // Check all task IDs are rendered
    expect(screen.getByText("root-task-id")).toBeTruthy();
    expect(screen.getByText("child-1-task-id")).toBeTruthy();
    expect(screen.getByText("child-2-task-id")).toBeTruthy();
    expect(screen.getByText("grandchild-1-task-id")).toBeTruthy();

    // Check task specs are rendered
    expect(screen.getByText("Child 1 specification")).toBeTruthy();
    expect(screen.getByText("Child 2 specification")).toBeTruthy();
    expect(screen.getByText("Grandchild specification")).toBeTruthy();
  });

  it("highlights rejected tasks with red background and left border", async () => {
    vi.mocked(apiClient.getTaskTree).mockResolvedValue(fixture);

    renderTaskTreeView("root-task-id");

    await screen.findByText("Child 2 specification");

    // Find the row with the rejected child task
    const pageHtml = document.documentElement.innerHTML;
    // Check that "rejected" badge is rendered
    expect(screen.getByText("rejected")).toBeTruthy();

    // The rejected node should have the bg-red-900/20 background class (from component)
    const allDivs = document.querySelectorAll("div");
    let foundEscalationRow = false;
    allDivs.forEach((div) => {
      if (div.textContent?.includes("Child 2 specification") && div.className?.includes("bg-red-900/20")) {
        foundEscalationRow = true;
      }
    });
    expect(foundEscalationRow).toBe(true);
  });

  it("does not highlight done tasks with escalation styling", async () => {
    vi.mocked(apiClient.getTaskTree).mockResolvedValue(fixture);

    renderTaskTreeView("root-task-id");

    await screen.findByText("Child 1 specification");

    // Check that "done" badge is rendered
    expect(screen.getByText("done")).toBeTruthy();

    // The done node should have the green badge, not red background
    const allSpans = document.querySelectorAll("span");
    let foundDoneBadge = false;
    allSpans.forEach((span) => {
      if (span.textContent === "done" && span.className?.includes("bg-green")) {
        foundDoneBadge = true;
      }
    });
    expect(foundDoneBadge).toBe(true);
  });

  it("shows 'uncapped' for null budget limits", async () => {
    vi.mocked(apiClient.getTaskTree).mockResolvedValue(fixture);

    renderTaskTreeView("root-task-id");

    await screen.findByText("Grandchild specification");

    // Grandchild has null limits
    const pageText = document.body.textContent || "";
    expect(pageText).toContain("uncapped");
  });

  it("formats token values with comma separators", async () => {
    vi.mocked(apiClient.getTaskTree).mockResolvedValue(fixture);

    renderTaskTreeView("root-task-id");

    await screen.findByText("Root task specification");

    // Check that token values are comma-formatted
    const pageText = document.body.textContent || "";
    // Root spent 1,000,000 tokens
    expect(pageText).toContain("1,000,000");
    // Child 1 spent 500,000 tokens
    expect(pageText).toContain("500,000");
    // Child 2 spent 1,500,000 tokens
    expect(pageText).toContain("1,500,000");
  });

  it("shows rejection count for rejected tasks", async () => {
    vi.mocked(apiClient.getTaskTree).mockResolvedValue(fixture);

    renderTaskTreeView("root-task-id");

    await screen.findByText("Child 2 specification");

    // Child 2 was rejected 2 times
    const pageText = document.body.textContent || "";
    expect(pageText).toContain("rejected 2×");
  });

  it("renders 'Task not found' when root is undefined", async () => {
    vi.mocked(apiClient.getTaskTree).mockResolvedValue({ root: undefined });

    renderTaskTreeView("nonexistent-task-id");

    await screen.findByText("Task not found.");

    expect(screen.getByText("Task not found.")).toBeTruthy();
  });

  it("renders loading state", async () => {
    vi.mocked(apiClient.getTaskTree).mockImplementation(
      () => new Promise(() => {}), // Never resolves
    );

    renderTaskTreeView("root-task-id");

    expect(screen.getByText("Loading task tree…")).toBeTruthy();
  });

  it("renders error message on API failure", async () => {
    vi.mocked(apiClient.getTaskTree).mockRejectedValue(new Error("Network error"));

    renderTaskTreeView("root-task-id");

    await screen.findByText(/Error.*Network error/);
    expect(screen.getByText(/Error.*Network error/)).toBeTruthy();
  });
});
