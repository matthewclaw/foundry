/**
 * E6.4 — approvals loop: engine permission_request → approval item (supervisor) →
 * grant/deny via API → grant schedules the follow-up run with the decision composed
 * into its context.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeAdapter, loadScenario } from "@foundry/adapter-fake";
import { createServer, type FoundryServer } from "../server.js";

let server: FoundryServer;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "foundry-approvals-"));
  server = createServer({
    dataDir: tempDir,
    adapters: { fake: createFakeAdapter(loadScenario("permission-request-granted")) },
  });
});

afterEach(() => {
  try {
    server.store.close();
  } catch {
    /* closed */
  }
  rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function bootstrap(): { agentId: string; wsId: string } {
  const { agentId } = server.store.commands.createAgent({
    name: "Orbit",
    role: "Backend",
    team_id: null,
    engine_id: "fake",
    engine_config: { scenarioName: "permission-request-granted" },
    memory_ref: "agents/{agent_id}/memory",
    charter_body_md: "# Orbit",
  });
  server.store.commands.transitionAgentState({ id: agentId, to: "active", actorId: null });
  const ws = server.store.commands.createWorkstream({
    agent_id: agentId,
    title: "Needs permission",
    goal_md: "g",
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

describe("approvals loop — E6.4", () => {
  it("permission_request creates a pending approval and flips the workstream to waiting on it", async () => {
    const { wsId } = bootstrap();
    server.runtime.enqueue({ workstreamId: wsId as never, trigger: "human_message" });
    await idle();

    const pending = server.store.approvals.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.kind).toBe("engine_permission");
    expect((pending[0]?.payload as { description?: string }).description).toContain("npm install");

    const ws = server.store.workstreams.get(wsId as never);
    expect(ws?.state).toBe("waiting");
    // #25: this waiting has a real ref
    const waitingEvent = server.store.events.after(0).findLast((e) => e.type === "workstream_waiting");
    expect((waitingEvent?.payload as { waiting_on_ref?: string }).waiting_on_ref).toBe(`approval:${pending[0]!.id}`);
  });

  it("grant decides the approval, schedules an approval_granted run, and the decision is in its context", async () => {
    const { wsId } = bootstrap();
    server.runtime.enqueue({ workstreamId: wsId as never, trigger: "human_message" });
    await idle();
    const approval = server.store.approvals.listPending()[0]!;

    const res = await server.app.inject({
      method: "POST",
      url: `/api/approvals/${approval.id}/grant`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.approval.state).toBe("granted");
    expect(body.run_id).toBeTruthy();

    await idle();
    const run = server.store.runs.get(body.run_id);
    expect(run?.trigger).toBe("approval_granted");
    expect(run?.state).toBe("completed");
    const context = readFileSync(join(tempDir, run!.input_context_ref), "utf8");
    expect(context).toContain("An approval you were waiting on has been decided");
    expect(context).toContain("GRANTED");
    expect(context).toContain("npm install");
  });

  it("deny records the decision; double-deciding is 409; unknown approval is 404", async () => {
    const { wsId } = bootstrap();
    server.runtime.enqueue({ workstreamId: wsId as never, trigger: "human_message" });
    await idle();
    const approval = server.store.approvals.listPending()[0]!;

    const deny = await server.app.inject({
      method: "POST",
      url: `/api/approvals/${approval.id}/deny`,
      payload: { reason: "not on a Friday" },
    });
    expect(deny.statusCode).toBe(200);
    expect(JSON.parse(deny.body).approval.state).toBe("denied");
    // Deny schedules nothing.
    expect(server.runtime.pendingCount() + server.runtime.activeCount()).toBe(0);

    const again = await server.app.inject({ method: "POST", url: `/api/approvals/${approval.id}/grant`, payload: {} });
    expect(again.statusCode).toBe(409);

    const missing = await server.app.inject({
      method: "POST",
      url: `/api/approvals/01JUNKJUNKJUNKJUNKJUNKJUNK/deny`,
      payload: {},
    });
    expect(missing.statusCode).toBe(404);
  });
});
