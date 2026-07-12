/**
 * E7.4 tests: run timeline renders collapsed cards that expand to the event stream;
 * capability degradation (transcriptSource "none") is explicitly visible; the
 * redirect composer POSTs {kind:"redirect"} and shows the returned run_id.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { FeedEvent, Timeline, TimelineRunEntry } from "../api/types.js";
import WorkstreamView from "./WorkstreamView.js";

vi.mock("../api/client.js", () => ({
  apiClient: { getTimeline: vi.fn(), postWorkstreamMessage: vi.fn() },
}));
import { apiClient } from "../api/client.js";

let feedOnEvent: ((event: FeedEvent) => void) | undefined;
vi.mock("../api/sse.js", () => ({
  connectFeed: vi.fn((options: { onEvent: (event: FeedEvent) => void }) => {
    feedOnEvent = options.onEvent;
    return { disconnect: vi.fn() };
  }),
}));

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

  it("renders full-capability runs: the most recent run defaults open with events + live transcript, and can be collapsed", async () => {
    renderView({ workstreamId: "ws1", runs: [fullRun] });

    await screen.findByText("Run #1");
    expect(screen.getByText("$0.4200")).toBeTruthy();
    // it's the only (and therefore most recent) run — defaults expanded, no click needed
    expect(screen.getByText(/run_tool_call/)).toBeTruthy();
    expect(screen.getByText(/refactored the auth module/)).toBeTruthy();
    expect(screen.getByText(/transcript \(live\)/)).toBeTruthy();
    expect(screen.queryByText(/limited engine detail/)).toBeNull();

    // clicking the header collapses it
    fireEvent.click(screen.getByText("Run #1"));
    expect(screen.queryByText(/run_tool_call/)).toBeNull();
  });

  it("makes capability degradation visible on text-only/none runs (ADR-003)", async () => {
    renderView({ workstreamId: "ws1", runs: [degradedRun] });

    await screen.findByText("Run #2");
    // marker visible regardless of expand state
    expect(screen.getByText("limited engine detail")).toBeTruthy();
    // defaults expanded (most recent run) — no transcript, so the degradation message
    // is already visible without clicking
    expect(screen.getByText(/No transcript available/)).toBeTruthy();
  });

  it("only the most recent run defaults open; earlier runs stay collapsed until clicked", async () => {
    const earlierRun: TimelineRunEntry = { ...fullRun, run: { ...fullRun.run, id: "run0", seq: 0 } };
    renderView({ workstreamId: "ws1", runs: [earlierRun, degradedRun] });

    await screen.findByText("Run #0");
    // earlier run (run0) is collapsed by default
    expect(screen.queryByText(/refactored the auth module/)).toBeNull();
    // most recent run (run2/degradedRun) is expanded by default
    expect(screen.getByText(/No transcript available/)).toBeTruthy();

    fireEvent.click(screen.getByText("Run #0"));
    expect(screen.getByText(/refactored the auth module/)).toBeTruthy();
  });

  it("streams run_output_delta text live for a non-terminal run, auto-expanded, and clears on the terminal event", async () => {
    const runningRun: TimelineRunEntry = {
      run: { id: "run3", seq: 3, trigger: "human_message", state: "running", started_at: "2026-07-01T10:00:00Z", ended_at: null, usage: null },
      events: [],
      transcriptText: null,
      transcriptSource: "live",
    };
    renderView({ workstreamId: "ws1", runs: [runningRun] });
    await screen.findByText("Run #3");
    expect(feedOnEvent).toBeDefined();

    act(() => {
      feedOnEvent!({
        seq: 100,
        ts: "2026-07-01T10:00:01Z",
        type: "run_output_delta",
        entity_type: "run",
        entity_id: "run3",
        payload: { text: "Looking at the code" },
        actor_id: null,
        run_id: "run3",
        workstream_id: "ws1",
        task_id: null,
      });
    });

    expect(screen.getByText("● live")).toBeTruthy();
    expect(screen.getByText(/Looking at the code/)).toBeTruthy();

    act(() => {
      feedOnEvent!({
        seq: 101,
        ts: "2026-07-01T10:00:02Z",
        type: "run_output_delta",
        entity_type: "run",
        entity_id: "run3",
        payload: { text: "...found it." },
        actor_id: null,
        run_id: "run3",
        workstream_id: "ws1",
        task_id: null,
      });
    });
    // Appended, not replaced.
    expect(screen.getByText(/Looking at the code\.\.\.found it\./)).toBeTruthy();

    // Events for a different workstream must not leak into this buffer.
    act(() => {
      feedOnEvent!({
        seq: 102,
        ts: "2026-07-01T10:00:03Z",
        type: "run_output_delta",
        entity_type: "run",
        entity_id: "run-other",
        payload: { text: "SHOULD NOT APPEAR" },
        actor_id: null,
        run_id: "run-other",
        workstream_id: "ws-other",
        task_id: null,
      });
    });
    expect(screen.queryByText(/SHOULD NOT APPEAR/)).toBeNull();
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
