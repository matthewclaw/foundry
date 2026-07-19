import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentId, WorkstreamId } from "@foundry/core";
import { createStore, type Store } from "@foundry/store";
import { createRunQueue } from "./queue.js";

const ZERO_BUDGET = { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 };

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function testStore(): Store {
  dir = mkdtempSync(join(tmpdir(), "foundry-runtime-queue-"));
  return createStore({ dataDir: dir, dbPath: ":memory:" });
}

function bootstrapAgent(store: Store): AgentId {
  const team = store.commands.createTeam({ name: "Platform", description: "infra", default_policy: {} });
  const { agentId } = store.commands.createAgent({
    name: "Orbit",
    role: "Backend Engineer",
    team_id: team.id,
    engine_id: "fake",
    memory_ref: "agents/orbit/memory",
    charter_body_md: "# Orbit",
  });
  return agentId;
}

function makeWorkstream(store: Store, agentId: AgentId, title: string): WorkstreamId {
  return store.commands.createWorkstream({
    agent_id: agentId,
    title,
    goal_md: "test goal",
    origin: "human",
    budget: ZERO_BUDGET,
  }).id;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForIdle(queue: { pendingCount(): number; activeCount(): number }): Promise<void> {
  while (queue.pendingCount() > 0 || queue.activeCount() > 0) {
    await sleep(1);
  }
}

describe("createRunQueue — E4.1", () => {
  it("serializes runs on the same workstream (never more than one active at once)", async () => {
    const store = testStore();
    const agentId = bootstrapAgent(store);
    const ws = makeWorkstream(store, agentId, "Bug #1");

    const order: string[] = [];
    let concurrent = 0;
    let maxConcurrentSeen = 0;
    const queue = createRunQueue({
      store,
      execute: async (run) => {
        concurrent++;
        maxConcurrentSeen = Math.max(maxConcurrentSeen, concurrent);
        order.push(run.id);
        await sleep(5);
        concurrent--;
      },
    });

    queue.enqueue({ workstreamId: ws, trigger: "human_message", inputContextRef: "a", engineId: "fake" });
    queue.enqueue({ workstreamId: ws, trigger: "human_message", inputContextRef: "b", engineId: "fake" });
    queue.enqueue({ workstreamId: ws, trigger: "human_message", inputContextRef: "c", engineId: "fake" });

    await waitForIdle(queue);

    expect(maxConcurrentSeen).toBe(1);
    expect(order).toHaveLength(3);
  });

  it("honours the org-wide concurrency cap under load", async () => {
    const store = testStore();
    const agentId = bootstrapAgent(store);

    let concurrent = 0;
    let maxConcurrentSeen = 0;
    const queue = createRunQueue({
      store,
      limits: { maxConcurrentOrg: 2 },
      execute: async () => {
        concurrent++;
        maxConcurrentSeen = Math.max(maxConcurrentSeen, concurrent);
        await sleep(5);
        concurrent--;
      },
    });

    for (let i = 0; i < 6; i++) {
      const ws = makeWorkstream(store, agentId, `Workstream ${i}`);
      queue.enqueue({ workstreamId: ws, trigger: "agent_message", inputContextRef: `ctx-${i}`, engineId: "fake" });
    }

    await waitForIdle(queue);

    expect(maxConcurrentSeen).toBeGreaterThan(0);
    expect(maxConcurrentSeen).toBeLessThanOrEqual(2);
  });

  it("prioritizes a human-triggered job over an earlier-queued agent-triggered one", async () => {
    const store = testStore();
    const agentId = bootstrapAgent(store);
    const wsA = makeWorkstream(store, agentId, "A");
    const wsB = makeWorkstream(store, agentId, "B");
    const wsC = makeWorkstream(store, agentId, "C");

    const order: WorkstreamId[] = [];
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));

    const queue = createRunQueue({
      store,
      limits: { maxConcurrentOrg: 1 },
      execute: async (_run, job) => {
        order.push(job.workstreamId);
        if (job.workstreamId === wsA) await gateA;
      },
    });

    queue.enqueue({ workstreamId: wsA, trigger: "agent_message", inputContextRef: "a", engineId: "fake" }); // takes the only slot
    queue.enqueue({ workstreamId: wsB, trigger: "agent_message", inputContextRef: "b", engineId: "fake" }); // queued first
    queue.enqueue({ workstreamId: wsC, trigger: "human_message", inputContextRef: "c", engineId: "fake" }); // queued second, but human

    releaseA();
    await waitForIdle(queue);

    expect(order).toEqual([wsA, wsC, wsB]);
  });

  it("restore() executes an already-persisted run without creating a second row or event", async () => {
    const store = testStore();
    const agentId = bootstrapAgent(store);
    const ws = makeWorkstream(store, agentId, "Requeued after restart");
    // The run row already exists — created by the pre-crash control plane.
    const run = store.commands.createRun({
      workstream_id: ws,
      trigger: "agent_message",
      input_context_ref: "ctx",
      engine_id: "fake",
    });

    const executed: string[] = [];
    const queue = createRunQueue({ store, execute: async (r) => void executed.push(r.id) });
    queue.restore(run, { workstreamId: ws, trigger: run.trigger, inputContextRef: "ctx", engineId: "fake" });
    await waitForIdle(queue);

    expect(executed).toEqual([run.id]);
    expect(store.runs.list({ workstream_id: ws })).toHaveLength(1);
    expect(store.events.after(0).filter((e) => e.type === "run_queued")).toHaveLength(1);
  });

  it("reserveWorkstream holds a workstream's slot for something outside the queue (E13 interactive attach)", async () => {
    const store = testStore();
    const agentId = bootstrapAgent(store);
    const ws = makeWorkstream(store, agentId, "Interactive session live");

    const executed: string[] = [];
    const queue = createRunQueue({ store, execute: async (run) => void executed.push(run.id) });

    expect(queue.reserveWorkstream(ws)).toBe(true);
    expect(queue.reserveWorkstream(ws)).toBe(false); // already reserved

    const run = queue.enqueue({ workstreamId: ws, trigger: "human_message", inputContextRef: "a", engineId: "fake" });
    await sleep(20);
    expect(executed).toEqual([]); // held behind the reservation, not started

    queue.releaseWorkstream(ws);
    await waitForIdle(queue);
    expect(executed).toEqual([run.id]);

    // Releasing again (nothing reserved) is a no-op, not an error.
    expect(() => queue.releaseWorkstream(ws)).not.toThrow();
  });

  it("emits a run_queued event as part of enqueueing", () => {
    const store = testStore();
    const agentId = bootstrapAgent(store);
    const ws = makeWorkstream(store, agentId, "Bug #2");

    const queue = createRunQueue({ store, execute: async () => {} });
    const run = queue.enqueue({ workstreamId: ws, trigger: "human_message", inputContextRef: "x", engineId: "fake" });

    const events = store.events.after(0);
    expect(events.some((e) => e.type === "run_queued" && e.entity_id === run.id)).toBe(true);
  });
});
