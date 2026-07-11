/**
 * E7.4 tests: run timeline renders collapsed cards that expand to the event stream;
 * capability degradation (transcriptSource "none") is explicitly visible; the
 * redirect composer POSTs {kind:"redirect"} and shows the returned run_id.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Timeline, TimelineRunEntry } from "../api/types.js";
import WorkstreamView from "./WorkstreamView.js";

vi.mock("../api/client.js", () => ({
  apiClient: { getTimeline: vi.fn(), postWorkstreamMessage: vi.fn() },
}));
import { apiClient } from "../api/client.js";

const fullRun: TimelineRunEntry = {
  run: {
    id: "run1",
    seq: 1,
    trigger: "human_message",
    state: "completed",
    started_at: "2026-07-01T10:00:00Z",
    ended_at: "2026-07-01T10:05:00Z",
    usage: { cost_usd: 0.42, tokens_in: 1000, tokens_out: 500 },
  },
  events: [
    { seq: 10, type: "run_tool_call", payload: { name: "Bash", phase: "start" } },
    { seq: 11, type: "run_usage_delta", payload: { costUsd: 0.42 } },
  ],
  transcriptText: "I refactored the auth module.",
  transcriptSource: "live",
};

const degradedRun: TimelineRunEntry = {
  run: {
    id: "run2",
    seq: 2,
    trigger: "resume",
    state: "completed",
    started_at: null,
    ended_at: "2026-07-02T09:00:00Z",
    usage: null,
  },
  events: [],
  transcriptText: null,
  transcriptSource: "none",
};

function renderView(timeline: Timeline) {
  vi.mocked(apiClient.getTimeline).mockResolvedValue(timeline);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/workstreams/ws1"]}>
        <Routes>
          <Route path="/workstreams/:id" element={<WorkstreamView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("WorkstreamView", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders full-capability runs: collapsed card expands to events + live transcript", async () => {
    renderView({ workstreamId: "ws1", runs: [fullRun] });

    await screen.findByText("Run #1");
    expect(screen.getByText("$0.4200")).toBeTruthy();
    // collapsed: event stream not visible yet
    expect(screen.queryByText(/run_tool_call/)).toBeNull();

    fireEvent.click(screen.getByText("Run #1"));
    expect(screen.getByText(/run_tool_call/)).toBeTruthy();
    expect(screen.getByText(/refactored the auth module/)).toBeTruthy();
    expect(screen.getByText(/transcript \(live\)/)).toBeTruthy();
    expect(screen.queryByText(/limited engine detail/)).toBeNull();
  });

  it("makes capability degradation visible on text-only/none runs (ADR-003)", async () => {
    renderView({ workstreamId: "ws1", runs: [degradedRun] });

    await screen.findByText("Run #2");
    // marker visible even collapsed
    expect(screen.getByText("limited engine detail")).toBeTruthy();

    fireEvent.click(screen.getByText("Run #2"));
    expect(screen.getByText(/No transcript available/)).toBeTruthy();
  });

  it("redirect composer POSTs {kind:'redirect'} and shows the returned run_id", async () => {
    vi.mocked(apiClient.postWorkstreamMessage).mockResolvedValue({
      message_id: "m1",
      run_id: "run-777",
    });
    renderView({ workstreamId: "ws1", runs: [] });

    await screen.findByText("No runs yet.");
    fireEvent.change(screen.getByLabelText("Redirect message"), {
      target: { value: "Focus on the flaky test first." },
    });
    fireEvent.click(screen.getByText("Send redirect"));

    await waitFor(() =>
      expect(apiClient.postWorkstreamMessage).toHaveBeenCalledWith("ws1", {
        kind: "redirect",
        body_md: "Focus on the flaky test first.",
      })
    );
    expect(await screen.findByText(/run enqueued: run-777/)).toBeTruthy();
  });
});
