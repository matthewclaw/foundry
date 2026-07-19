/** E13 — interactive session manager: attach/join/detach lifecycle, busy gating,
 * capability honesty, and reuse of the exact audit fold the batch supervisor uses. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentId, Workstream, WorkstreamId } from "@foundry/core";
import { createStore, type Store } from "@foundry/store";
import type { EngineEvent, ExecutionAdapter, InteractiveEngineSession, RunSpec } from "@foundry/adapter-api";
import { createRunQueue } from "../scheduler/queue.js";
import { createInteractiveSessionManager } from "./session.js";

const ZERO_BUDGET = { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 };

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function testStore(): Store {
  dir = mkdtempSync(join(tmpdir(), "foundry-interactive-"));
  return createStore({ dataDir: dir, dbPath: ":memory:" });
}

function bootstrap(store: Store, engineId = "scripted"): { workstreamId: WorkstreamId; agentId: AgentId } {
  const team = store.commands.createTeam({ name: "Platform", description: "infra", default_policy: {} });
  const { agentId } = store.commands.createAgent({
    name: "Orbit",
    role: "Backend Engineer",
    team_id: team.id,
    engine_id: engineId,
    memory_ref: "agents/orbit/memory",
    charter_body_md: "# Orbit",
  });
  store.commands.transitionAgentState({ id: agentId, to: "active", actorId: null });
  const workstreamId = store.commands.createWorkstream({
    agent_id: agentId,
    title: "Bug #1",
    goal_md: "test goal",
    origin: "human",
    budget: ZERO_BUDGET,
  }).id;
  return { workstreamId, agentId };
}

/** Gives the workstream a prior completed run with a session id — "drop in" requires
 * one to attach to (any run with a session id, including completed, per the product
 * decision). */
function givePriorSession(store: Store, workstreamId: WorkstreamId, sessionId: string): void {
  // Mirrors supervisor.ts's ensureWorkstreamRunnable pre-amble — a real batch run
  // always does this before executing; a fresh workstream otherwise sits in "open",
  // which can't transition straight to "waiting" (attach()'s own transition).
  store.commands.transitionWorkstreamState({ id: workstreamId, to: "active", actorId: null });
  const run = store.commands.createRun({
    workstream_id: workstreamId,
    trigger: "human_message",
    input_context_ref: "ctx",
    engine_id: "scripted",
  });
  store.commands.transitionRunState({ id: run.id, workstreamId, to: "starting", actorId: null });
  store.commands.transitionRunState({ id: run.id, workstreamId, to: "running", actorId: null, engineSessionId: sessionId });
  store.commands.transitionRunState({
    id: run.id,
    workstreamId,
    to: "completed",
    actorId: null,
    result: { outcome: "completed", final_text: "done", artifact_refs: [] },
  });
}

/** Leaves the workstream genuinely paused — "waiting", with a run sitting in
 * `awaiting_input` — the exact motivating case for "drop in": a human wants to attach
 * to a run that's already stuck waiting on them, not just an idle completed one. */
function givePausedSession(store: Store, workstreamId: WorkstreamId, sessionId: string): void {
  store.commands.transitionWorkstreamState({ id: workstreamId, to: "active", actorId: null });
  const run = store.commands.createRun({
    workstream_id: workstreamId,
    trigger: "human_message",
    input_context_ref: "ctx",
    engine_id: "scripted",
  });
  store.commands.transitionRunState({ id: run.id, workstreamId, to: "starting", actorId: null });
  store.commands.transitionRunState({ id: run.id, workstreamId, to: "running", actorId: null, engineSessionId: sessionId });
  store.commands.transitionRunState({ id: run.id, workstreamId, to: "awaiting_input", actorId: null, prompt: "need more info" });
  store.commands.transitionWorkstreamState({ id: workstreamId, to: "waiting", actorId: null, waitingOnRef: null });
}

/** A scripted `InteractiveEngineSession` driven by pushing events onto a simple async
 * queue — stands in for a real spawned process the same way adapter-fake's Scenario
 * stands in for a real one-shot run. */
class ScriptedSession implements InteractiveEngineSession {
  sent: string[] = [];
  closed = false;
  private queue: EngineEvent[] = [];
  private waiters: ((e: EngineEvent) => void)[] = [];
  private crashPending = false;

  push(event: EngineEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(event);
    else this.queue.push(event);
  }

  /** Simulates the engine process dying right after the currently-queued events are
   * delivered — the next pull from `events()` throws instead of yielding. */
  crashAfterNextEvent(): void {
    this.crashPending = true;
  }

  send(text: string): void {
    this.sent.push(text);
  }

  async *events(): AsyncIterable<EngineEvent> {
    for (;;) {
      if (this.closed && this.queue.length === 0) return;
      const event =
        this.queue.length > 0
          ? this.queue.shift()!
          : await new Promise<EngineEvent>((resolve) => this.waiters.push(resolve));
      yield event;
      // Checked uniformly after either delivery path — push() resolves a pending
      // waiter directly (bypassing the queue) once the generator is already awaiting,
      // so a check only on the queue-shift branch would never fire in steady state.
      if (this.crashPending) {
        this.crashPending = false;
        throw new Error("scripted crash");
      }
    }
  }

  close(): void {
    this.closed = true;
    this.waiters.splice(0).forEach(() => {}); // let any pending events() loop notice `closed` next tick
  }
}

function makeAdapter(session: ScriptedSession, interactive = true): ExecutionAdapter {
  return {
    id: "scripted",
    capabilities: () => ({
      resume: false,
      stream_events: true,
      tool_events: true,
      usage: true,
      reasoning_summaries: false,
      permission_hooks: false,
      mcp: false,
      interactive,
    }),
    start: async () => ({ runId: "" as never, adapterId: "scripted" }),
    cancel: async () => {},
    events: async function* () {},
    ...(interactive ? { attachInteractive: async (_spec: RunSpec & { sessionRef?: string }) => session } : {}),
  };
}

function testManager(store: Store, adapter: ExecutionAdapter) {
  const queue = createRunQueue({ store, execute: async () => {} });
  const resolve = (workstreamId: WorkstreamId): { workstream: Workstream; agent: Agent } => {
    const workstream = store.workstreams.get(workstreamId)!;
    const agent = store.agents.get(workstream.agent_id)!;
    return { workstream, agent };
  };
  const manager = createInteractiveSessionManager({
    store,
    adapters: { scripted: adapter },
    queue,
    resolve,
    acquireWorkspace: () => ({ ok: true, workspaceDir: dir }),
  });
  return { manager, queue };
}

describe("createInteractiveSessionManager — E13", () => {
  it("attach fails clearly when the engine doesn't declare capabilities().interactive", async () => {
    const store = testStore();
    const { workstreamId } = bootstrap(store);
    givePriorSession(store, workstreamId, "sess-1");
    const { manager } = testManager(store, makeAdapter(new ScriptedSession(), false));

    const result = await manager.attach(workstreamId);
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("does not support interactive attach") });
  });

  it("attach fails clearly when there's no prior session to attach to", async () => {
    const store = testStore();
    const { workstreamId } = bootstrap(store);
    const { manager } = testManager(store, makeAdapter(new ScriptedSession()));

    const result = await manager.attach(workstreamId);
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("no prior session") });
  });

  it("attach succeeds, a turn folds into an ordinary Run through the same audit path as a batch run", async () => {
    const store = testStore();
    const { workstreamId } = bootstrap(store);
    givePriorSession(store, workstreamId, "sess-1");
    const session = new ScriptedSession();
    const { manager } = testManager(store, makeAdapter(session));

    const result = await manager.attach(workstreamId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.engineSessionId).toBe("sess-1");

    const sendResult = result.handle.send("hello");
    expect(sendResult).toEqual({ ok: true });
    expect(session.sent).toEqual(["hello"]);

    // The user's text is recorded on the run_queued event so the timeline can render it
    // as the turn's message (not appear out of nowhere).
    const queued = store.events.after(0).find((e) => e.type === "run_queued" && e.payload && (e.payload as { message_md?: string }).message_md === "hello");
    expect(queued).toBeDefined();

    session.push({ t: "run_started", sessionRef: "sess-1" });
    session.push({ t: "output_delta", text: "hi there" });
    session.push({ t: "run_ended", outcome: "completed", finalText: "hi there", sessionRef: "sess-1" });

    await vi.waitFor(() => {
      const runs = store.runs.list({ workstream_id: workstreamId });
      const interactiveRun = runs.find((r) => r.trigger === "interactive_message");
      expect(interactiveRun?.state).toBe("completed");
    });

    const events = store.events.after(0).filter((e) => e.type === "run_output_delta");
    expect(events.some((e) => (e.payload as { text: string }).text === "hi there")).toBe(true);
  });

  it("rejects a second send while a turn is still in flight", async () => {
    const store = testStore();
    const { workstreamId } = bootstrap(store);
    givePriorSession(store, workstreamId, "sess-1");
    const session = new ScriptedSession();
    const { manager } = testManager(store, makeAdapter(session));

    const result = await manager.attach(workstreamId);
    if (!result.ok) throw new Error("expected attach to succeed");

    expect(result.handle.send("first")).toEqual({ ok: true });
    expect(result.handle.send("second")).toEqual({ ok: false, reason: "busy" });

    session.push({ t: "run_started", sessionRef: "sess-1" });
    session.push({ t: "run_ended", outcome: "completed", sessionRef: "sess-1" });
    await vi.waitFor(() => expect(result.handle.send("now ok")).toEqual({ ok: true }));
  });

  it("a second attach to the same workstream joins the existing session instead of spawning another", async () => {
    const store = testStore();
    const { workstreamId } = bootstrap(store);
    givePriorSession(store, workstreamId, "sess-1");
    const session = new ScriptedSession();
    const adapter = makeAdapter(session);
    const attachSpy = vi.spyOn(adapter, "attachInteractive" as never);
    const { manager } = testManager(store, adapter);

    const first = await manager.attach(workstreamId);
    const second = await manager.attach(workstreamId);
    expect(first.ok && second.ok).toBe(true);
    expect(attachSpy).toHaveBeenCalledTimes(1);
  });

  it("detach only closes the session and releases the workstream once every attached caller has detached", async () => {
    const store = testStore();
    const { workstreamId } = bootstrap(store);
    givePriorSession(store, workstreamId, "sess-1");
    const session = new ScriptedSession();
    const { manager, queue } = testManager(store, makeAdapter(session));

    const first = await manager.attach(workstreamId);
    const second = await manager.attach(workstreamId);
    if (!first.ok || !second.ok) throw new Error("expected both attaches to succeed");

    expect(store.workstreams.get(workstreamId)?.state).toBe("waiting");
    expect(queue.reserveWorkstream(workstreamId)).toBe(false); // still reserved

    first.handle.detach();
    expect(session.closed).toBe(false); // second caller still attached
    expect(store.workstreams.get(workstreamId)?.state).toBe("waiting");

    second.handle.detach();
    expect(session.closed).toBe(true);
    expect(store.workstreams.get(workstreamId)?.state).toBe("active");
    expect(queue.reserveWorkstream(workstreamId)).toBe(true); // released
  });

  it("attaches to a workstream already paused on awaiting_input (the motivating case) without clobbering that wait, and leaves it alone on detach", async () => {
    const store = testStore();
    const { workstreamId } = bootstrap(store);
    givePausedSession(store, workstreamId, "sess-1");
    const session = new ScriptedSession();
    const { manager } = testManager(store, makeAdapter(session));

    expect(store.workstreams.get(workstreamId)?.state).toBe("waiting"); // already paused

    const result = await manager.attach(workstreamId);
    expect(result.ok).toBe(true);
    expect(store.workstreams.get(workstreamId)?.state).toBe("waiting"); // untouched, not re-transitioned

    if (result.ok) result.handle.detach();
    // This attach didn't cause the wait, so detaching must not clear it — the paused
    // run is still genuinely waiting on human input, unrelated to our attach/detach.
    expect(store.workstreams.get(workstreamId)?.state).toBe("waiting");
  });

  it("a broken turn (engine dies mid-turn) folds the stuck run to a terminal state instead of leaving busy stuck forever", async () => {
    const store = testStore();
    const { workstreamId } = bootstrap(store);
    givePriorSession(store, workstreamId, "sess-1");
    const session = new ScriptedSession();
    const { manager } = testManager(store, makeAdapter(session));

    const result = await manager.attach(workstreamId);
    if (!result.ok) throw new Error("expected attach to succeed");

    expect(result.handle.send("first")).toEqual({ ok: true });
    // run_started with no matching run_ended, then the process just dies — the reader
    // loop's for-await throws once the underlying iterable errors.
    session.push({ t: "run_started", sessionRef: "sess-1" });
    session.crashAfterNextEvent();

    await vi.waitFor(() => {
      const runs = store.runs.list({ workstream_id: workstreamId });
      const interactiveRun = runs.find((r) => r.trigger === "interactive_message");
      expect(interactiveRun?.state).toBe("interrupted");
    });
    // busy was cleared too — a later send() isn't stuck forever behind the crash.
    expect(result.handle.send("recovered")).toEqual({ ok: true });
  });
});
