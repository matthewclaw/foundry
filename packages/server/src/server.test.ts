/** E10.4 anomaly rules — crash loop and budget threshold escalations. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecutionAdapter, RunSpec } from "@foundry/adapter-api";
import { createFakeAdapter, loadScenario } from "@foundry/adapter-fake";
import { createServer, type FoundryServer } from "./server.js";

let server: FoundryServer;
let tempDir: string;
let capturedSpecs: RunSpec[];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "foundry-server-"));
  capturedSpecs = [];
  const inner = createFakeAdapter(loadScenario("happy-path"));
  const capturing: ExecutionAdapter = {
    id: inner.id,
    capabilities: () => inner.capabilities(),
    start: (spec) => {
      capturedSpecs.push(spec);
      return inner.start(spec);
    },
    resume: inner.resume ? (spec) => inner.resume!(spec) : undefined,
    cancel: (h) => inner.cancel(h),
    events: (h) => inner.events(h),
  };
  server = createServer({ dataDir: tempDir, dbPath: ":memory:", adapters: { fake: capturing } });
});

afterEach(() => {
  try {
    server.store.close();
  } catch {
    /* closed */
  }
  rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function bootstrapAgent(scenarioName = "happy-path"): { agentId: string; wsId: string } {
  const { agentId } = server.store.commands.createAgent({
    name: `Agent-${scenarioName}`,
    role: "Worker",
    team_id: null,
    engine_id: "fake",
    engine_config: { scenarioName },
    memory_ref: "agents/{agent_id}/memory",
    charter_body_md: "# Test Agent",
  });
  server.store.commands.transitionAgentState({ id: agentId, to: "active", actorId: null });
  const ws = server.store.commands.createWorkstream({
    agent_id: agentId,
    title: "Test work",
    goal_md: "test goal",
    origin: "human",
    budget: { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 },
  });
  return { agentId, wsId: ws.id };
}

async function idle(): Promise<void> {
  while (server.runtime.pendingCount() > 0 || server.runtime.activeCount() > 0) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A scenario that ends cleanly in run_ended{outcome:"failed"} — no crash/hang/resume. */
const FAIL_SCENARIO = {
  name: "test-clean-fail",
  description: "Ends in a clean failed outcome for E10.4 crash-loop testing.",
  steps: [
    { type: "event" as const, event: { t: "run_started" as const, sessionRef: "s" } },
    { type: "event" as const, event: { t: "run_ended" as const, outcome: "failed" as const, error: "boom" } },
  ],
};

describe("E10.4 anomaly rules — crash loop escalation", () => {
  it("escalates exactly once, on the 2nd consecutive failed run — not the 1st or 3rd", async () => {
    const { agentId } = server.store.commands.createAgent({
      name: "Flaky",
      role: "Worker",
      team_id: null,
      engine_id: "fake",
      engine_config: { scenario: FAIL_SCENARIO },
      memory_ref: "agents/{agent_id}/memory",
      charter_body_md: "# Flaky",
    });
    server.store.commands.transitionAgentState({ id: agentId, to: "active", actorId: null });
    const agent = server.store.agents.get(agentId as never)!;
    const ws = server.store.commands.createWorkstream({
      agent_id: agentId,
      title: "Flaky work",
      goal_md: "g",
      origin: "human",
      budget: { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 },
    });
    const thread = server.store.commands.getOrCreateThread("workstream", agent.id);

    // Run 1: fails, but this is the 1st consecutive failure — no escalation yet.
    server.runtime.enqueue({ workstreamId: ws.id, trigger: "human_message" });
    await idle();
    expect(server.store.messages.listByThread(thread.id).filter((m) => m.type === "escalation")).toHaveLength(0);

    // Run 2: fails again — the 2nd consecutive failure crosses into "degraded". Exactly one escalation.
    server.runtime.enqueue({ workstreamId: ws.id, trigger: "human_message" });
    await idle();
    const afterSecond = server.store.messages.listByThread(thread.id).filter((m) => m.type === "escalation");
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0]!.visibility).toBe("surfaced");
    expect(afterSecond[0]!.body_md).toContain("degraded");

    // Run 3: fails again (still consecutive) — must NOT fire a second escalation.
    server.runtime.enqueue({ workstreamId: ws.id, trigger: "human_message" });
    await idle();
    expect(server.store.messages.listByThread(thread.id).filter((m) => m.type === "escalation")).toHaveLength(1);
  });
});

describe("E10.4 anomaly rules — budget threshold escalation", () => {
  it("escalates the first time a workstream crosses 80% of its USD budget, not again on a later run", async () => {
    const { agentId, wsId } = bootstrapAgent("happy-path");
    const agent = server.store.agents.get(agentId as never)!;
    // Directly set spend to just under 80% — no run has driven real spend tracking here
    // (nothing in the runtime yet folds usage_delta into workstream.budget, OPEN_ISSUES —
    // this test exercises the escalation-firing logic against store state directly, which
    // is what afterRun actually reads).
    server.store.mutate({
      apply: (tx) => {
        tx.db
          .prepare(`UPDATE workstreams SET budget_json = ? WHERE id = ?`)
          .run(JSON.stringify({ limit_usd: 100, limit_tokens: null, spent_usd: 79, spent_tokens: 0 }), wsId);
      },
      events: [],
    });
    const thread = server.store.commands.getOrCreateThread("workstream", wsId);

    // Run 1: happy-path completes; spend is still 79/100 (nothing bumped it) — no escalation.
    server.runtime.enqueue({ workstreamId: wsId as never, trigger: "human_message" });
    await idle();
    expect(server.store.messages.listByThread(thread.id).filter((m) => m.type === "escalation")).toHaveLength(0);

    // Now push spend to 85/100 (crossing 80%) directly, then run again.
    server.store.mutate({
      apply: (tx) => {
        tx.db
          .prepare(`UPDATE workstreams SET budget_json = ? WHERE id = ?`)
          .run(JSON.stringify({ limit_usd: 100, limit_tokens: null, spent_usd: 85, spent_tokens: 0 }), wsId);
      },
      events: [],
    });
    server.runtime.enqueue({ workstreamId: wsId as never, trigger: "human_message" });
    await idle();
    const afterCrossing = server.store.messages.listByThread(thread.id).filter((m) => m.type === "escalation");
    expect(afterCrossing).toHaveLength(1);
    expect(afterCrossing[0]!.visibility).toBe("surfaced");
    expect(afterCrossing[0]!.body_md).toContain("85%");
    expect(afterCrossing[0]!.body_md).toContain("USD budget");

    // A further run, still over 80%, must not fire a duplicate.
    server.runtime.enqueue({ workstreamId: wsId as never, trigger: "human_message" });
    await idle();
    expect(server.store.messages.listByThread(thread.id).filter((m) => m.type === "escalation")).toHaveLength(1);
    void agent;
  });
});
