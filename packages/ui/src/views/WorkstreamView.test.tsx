/**
 * E7.4 tests: runs group into conversation cards by shared engine_session_id; only the
 * most recent conversation gets a Reply box (resume:true); "+ New conversation" always
 * starts fresh (resume:false); conversations can be renamed; capability degradation
 * (transcriptSource "none") stays visible regardless.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { FeedEvent, Timeline, TimelineRunEntry } from "../api/types.js";
import WorkstreamView from "./WorkstreamView.js";

vi.mock("../api/client.js", () => ({
  apiClient: { getTimeline: vi.fn(), postWorkstreamMessage: vi.fn(), setRunTitle: vi.fn() },
}));
import { apiClient } from "../api/client.js";

let feedOnEvent: ((event: FeedEvent) => void) | undefined;
vi.mock("../api/sse.js", () => ({
  connectFeed: vi.fn((options: { onEvent: (event: FeedEvent) => void }) => {
    feedOnEvent = options.onEvent;
    return { disconnect: vi.fn() };
  }),
}));

/** Stand-in for the browser's `WebSocket` — jsdom has none. Tracks every instance so a
 * test can simulate the server's control frames (attached/busy/error). */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  sent: string[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.onclose?.();
  }
}
vi.stubGlobal("WebSocket", FakeWebSocket);

const run1: TimelineRunEntry = {
  run: {
    id: "run1",
    seq: 1,
    trigger: "human_message",
    state: "completed",
    started_at: "2026-07-01T10:00:00Z",
    ended_at: "2026-07-01T10:05:00Z",
    usage: { cost_usd: 0.42, tokens_in: 1000, tokens_out: 500 },
    engine_session_id: "sess-a",
    title: null,
  },
  events: [
    { seq: 10, type: "run_queued", payload: { trigger: "human_message", message_md: "Fix the auth module" } },
    { seq: 11, type: "run_tool_call", payload: { name: "Bash", phase: "start" } },
  ],
  transcriptText: "I refactored the auth module.",
  transcriptSource: "live",
};

// Same session id as run1 — same conversation, a second turn.
const run2SameConvo: TimelineRunEntry = {
  run: {
    id: "run2",
    seq: 2,
    trigger: "human_message",
    state: "completed",
    started_at: "2026-07-01T10:10:00Z",
    ended_at: "2026-07-01T10:12:00Z",
    usage: { cost_usd: 0.1 },
    engine_session_id: "sess-a",
    title: null,
  },
  events: [{ seq: 20, type: "run_queued", payload: { trigger: "human_message", message_md: "Also add a test" } }],
  transcriptText: "Added a regression test.",
  transcriptSource: "live",
};

// A different session id — a separate, later conversation.
const run3NewConvo: TimelineRunEntry = {
  run: {
    id: "run3",
    seq: 3,
    trigger: "human_message",
    state: "completed",
    started_at: "2026-07-02T09:00:00Z",
    ended_at: "2026-07-02T09:05:00Z",
    usage: null,
    engine_session_id: "sess-b",
    title: null,
  },
  events: [{ seq: 30, type: "run_queued", payload: { trigger: "human_message", message_md: "Unrelated question" } }],
  transcriptText: "Sure, here's the answer.",
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
    engine_session_id: null,
    title: null,
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
  beforeEach(() => {
    vi.clearAllMocks();
    FakeWebSocket.instances.length = 0;
  });

  it("groups runs sharing a session id into one conversation card with both turns", async () => {
    renderView({ workstreamId: "ws1", runs: [run1, run2SameConvo] });

    // Default title comes from the first turn's message, truncated.
    await screen.findAllByText(/Fix the auth module/);
    expect(screen.getAllByTestId("conversation-card")).toHaveLength(1);
    expect(screen.getByText("2 turns")).toBeTruthy();
    expect(screen.getByText(/refactored the auth module/)).toBeTruthy();
    expect(screen.getByText(/Added a regression test/)).toBeTruthy();
    // appears in both the message bubble and the raw event JSON below it
    expect(screen.getAllByText(/Also add a test/).length).toBeGreaterThanOrEqual(1);
    // costs summed across the conversation's runs
    expect(screen.getByText("$0.5200")).toBeTruthy();
  });

  it("a run with a different session id starts a new, separate conversation card", async () => {
    renderView({ workstreamId: "ws1", runs: [run1, run2SameConvo, run3NewConvo] });

    await screen.findAllByText(/Fix the auth module/);
    expect(screen.getAllByTestId("conversation-card")).toHaveLength(2);
    // the older conversation (2 turns) is collapsed by default — only the current one is open
    expect(screen.queryByText(/refactored the auth module/)).toBeNull();
    // the most recent conversation defaults open
    expect(screen.getByText(/Sure, here's the answer/)).toBeTruthy();
  });

  it("makes capability degradation visible on text-only/none runs (ADR-003)", async () => {
    renderView({ workstreamId: "ws1", runs: [degradedRun] });

    // shown at both the conversation header and the individual turn
    expect((await screen.findAllByText("limited engine detail")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/No transcript available/)).toBeTruthy();
  });

  it("only the current (most recent) conversation gets a message box", async () => {
    renderView({ workstreamId: "ws1", runs: [run1, run2SameConvo, run3NewConvo] });
    await screen.findAllByText(/Fix the auth module/);

    // Only one composer exists (on the current conversation), not one per turn.
    expect(screen.getAllByLabelText("Reply")).toHaveLength(1);
  });

  it("replying uses resume:true", async () => {
    vi.mocked(apiClient.postWorkstreamMessage).mockResolvedValue({ message_id: "m1", run_id: "run-999" });
    renderView({ workstreamId: "ws1", runs: [run1] });

    await screen.findAllByText(/Fix the auth module/);
    fireEvent.change(screen.getByLabelText("Reply"), { target: { value: "And the flaky test?" } });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() =>
      expect(apiClient.postWorkstreamMessage).toHaveBeenCalledWith("ws1", {
        kind: "message",
        body_md: "And the flaky test?",
        resume: true,
      })
    );
  });

  it("+ New conversation uses resume:false", async () => {
    vi.mocked(apiClient.postWorkstreamMessage).mockResolvedValue({ message_id: "m2", run_id: "run-1000" });
    renderView({ workstreamId: "ws1", runs: [run1] });

    await screen.findAllByText(/Fix the auth module/);
    fireEvent.click(screen.getByText("+ New conversation"));
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Totally different topic" } });
    fireEvent.click(screen.getByText("Send message"));

    await waitFor(() =>
      expect(apiClient.postWorkstreamMessage).toHaveBeenCalledWith("ws1", {
        kind: "message",
        body_md: "Totally different topic",
        resume: false,
      })
    );
  });

  it("shows the New-conversation form when there are no runs yet", async () => {
    renderView({ workstreamId: "ws1", runs: [] });
    await screen.findByText("No conversations yet.");
    expect(screen.queryByLabelText("Message")).toBeNull();

    fireEvent.click(screen.getByText("+ New conversation"));
    expect(screen.getByLabelText("Message")).toBeTruthy();
  });

  it("renames a conversation via the edit control, PATCHing the last run in the group", async () => {
    vi.mocked(apiClient.setRunTitle).mockResolvedValue({});
    renderView({ workstreamId: "ws1", runs: [run1, run2SameConvo] });

    await screen.findAllByText(/Fix the auth module/);
    fireEvent.click(screen.getByText("✎"));
    fireEvent.change(screen.getByLabelText("Conversation title"), { target: { value: "Auth bugfix" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(apiClient.setRunTitle).toHaveBeenCalledWith("run2", "Auth bugfix"));
  });

  it("toggles a conversation between raw (default) and formatted views, formatted also shows token usage", async () => {
    const toolRun: TimelineRunEntry = {
      run: {
        id: "run4",
        seq: 4,
        trigger: "human_message",
        state: "completed",
        started_at: "2026-07-01T10:00:00Z",
        ended_at: "2026-07-01T10:05:00Z",
        usage: null,
        engine_session_id: "sess-c",
        title: null,
      },
      events: [
        { seq: 20, type: "run_tool_call", payload: { name: "Glob", phase: "start", detail: { input: { pattern: "README.md" } } } },
        { seq: 21, type: "run_tool_call", payload: { name: "Glob", phase: "end", detail: {} } },
        { seq: 22, type: "run_usage_updated", payload: { tokens_in: 5, tokens_out: 199, cost_usd: 0.0802 } },
      ],
      transcriptText: "Done.",
      transcriptSource: "live",
    };
    renderView({ workstreamId: "ws1", runs: [toolRun] });

    await screen.findByText("Done.");
    expect(screen.getAllByText(/run_tool_call/)).toHaveLength(2);
    expect(screen.getByText(/run_usage_updated/)).toBeTruthy();

    fireEvent.click(screen.getByText("Formatted"));
    expect(screen.queryByText(/run_tool_call/)).toBeNull();
    expect(screen.getByText("Glob")).toBeTruthy();
    expect(screen.getByText(/"pattern": "README.md"/)).toBeTruthy();
    expect(screen.getByText(/5 in \/ 199 out/)).toBeTruthy();
    expect(screen.getByText(/\$0\.0802/)).toBeTruthy();

    fireEvent.click(screen.getByText("Raw"));
    expect(screen.getAllByText(/run_tool_call/)).toHaveLength(2);
  });

  it("streams run_output_delta text live for a non-terminal run, auto-expanded, and clears on the terminal event", async () => {
    const runningRun: TimelineRunEntry = {
      run: {
        id: "run5",
        seq: 5,
        trigger: "human_message",
        state: "running",
        started_at: "2026-07-01T10:00:00Z",
        ended_at: null,
        usage: null,
        engine_session_id: "sess-d",
        title: null,
      },
      events: [],
      transcriptText: null,
      transcriptSource: "live",
    };
    renderView({ workstreamId: "ws1", runs: [runningRun] });
    await screen.findByText("Conversation");
    expect(feedOnEvent).toBeDefined();

    act(() => {
      feedOnEvent!({
        seq: 100,
        ts: "2026-07-01T10:00:01Z",
        type: "run_output_delta",
        entity_type: "run",
        entity_id: "run5",
        payload: { text: "Looking at the code" },
        actor_id: null,
        run_id: "run5",
        workstream_id: "ws1",
        task_id: null,
      });
    });

    // shown at both the conversation header and the individual turn
    expect(screen.getAllByText("● live").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Looking at the code/)).toBeTruthy();

    act(() => {
      feedOnEvent!({
        seq: 101,
        ts: "2026-07-01T10:00:02Z",
        type: "run_output_delta",
        entity_type: "run",
        entity_id: "run5",
        payload: { text: "...found it." },
        actor_id: null,
        run_id: "run5",
        workstream_id: "ws1",
        task_id: null,
      });
    });
    expect(screen.getByText(/Looking at the code\.\.\.found it\./)).toBeTruthy();

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

  it("shows Drop in only for a conversation with a session id, not one without", async () => {
    renderView({ workstreamId: "ws1", runs: [degradedRun] }); // engine_session_id: null
    await screen.findByText(/No transcript available/);
    expect(screen.queryByText("Drop in")).toBeNull();
  });

  it("Drop in connects a live session, shows attached status, and sends typed text over the socket", async () => {
    renderView({ workstreamId: "ws1", runs: [run1] }); // engine_session_id: "sess-a"
    await screen.findAllByText(/Fix the auth module/);

    fireEvent.click(screen.getByText("Drop in"));
    const socket = FakeWebSocket.instances.at(-1);
    expect(socket).toBeTruthy();
    expect(socket!.url).toContain("/api/workstreams/ws1/interactive");

    act(() => {
      socket!.onmessage?.({ data: JSON.stringify({ type: "attached", engineSessionId: "sess-a" }) });
    });
    expect(screen.getByText(/attached \(session sess-a/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Reply"), { target: { value: "hi there" } });
    fireEvent.click(screen.getByText("Send"));
    expect(socket!.sent).toEqual([JSON.stringify({ type: "send", text: "hi there" })]);

    // "Exit live" toggles the panel back to the plain headless composer.
    fireEvent.click(screen.getByText("Exit live"));
    expect(screen.queryByText(/attached \(session/)).toBeNull();
  });

  it("Drop in shows a busy status when the server rejects a send while a turn is in flight", async () => {
    renderView({ workstreamId: "ws1", runs: [run1] });
    await screen.findAllByText(/Fix the auth module/);

    fireEvent.click(screen.getByText("Drop in"));
    const socket = FakeWebSocket.instances.at(-1)!;
    act(() => socket.onmessage?.({ data: JSON.stringify({ type: "attached", engineSessionId: "sess-a" }) }));

    act(() => socket.onmessage?.({ data: JSON.stringify({ type: "busy" }) }));
    expect(screen.getByText(/busy/)).toBeTruthy();
  });
});
