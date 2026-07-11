/** E8.1 — human-facing task decisions: POST /api/tasks/:id/{accept,reject}. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeAdapter, loadScenario } from "@foundry/adapter-fake";
import { createServer, type FoundryServer } from "../server.js";

let server: FoundryServer;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "foundry-tasks-"));
  server = createServer({
    dataDir: tempDir,
    dbPath: ":memory:",
    adapters: { fake: createFakeAdapter(loadScenario("happy-path")) },
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

function bootstrapAgent(name: string) {
  const { agentId } = server.store.commands.createAgent({
    name,
    role: "Backend",
    team_id: null,
    engine_id: "fake",
    engine_config: { scenarioName: "happy-path" },
    memory_ref: "agents/{agent_id}/memory",
    charter_body_md: `# ${name}`,
  });
  server.store.commands.transitionAgentState({ id: agentId, to: "active", actorId: null });
  return server.store.agents.get(agentId as never)!;
}

/** A root task (no parent, human delegator) already delivered by its assignee. */
function bootstrapDeliveredRootTask() {
  const human = server.store.commands.getOrCreateHumanActor();
  const assignee = bootstrapAgent("Assignee");
  const task = server.store.commands.createTask({
    parent_task_id: null,
    delegator_actor_id: human,
    assignee_agent_id: assignee.id,
    spec_md: "spec",
    acceptance_criteria_md: "AC",
    budget: { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 },
  });
  server.store.commands.transitionTaskState({ id: task.id, to: "in_progress", actorId: null });
  const thread = server.store.commands.getOrCreateThread("task", task.id);
  const msg = server.store.commands.sendMessage({
    thread_id: thread.id,
    from_actor_id: assignee.actor_id,
    to_actor_id: human,
    type: "completion",
    body_md: "done",
    refs: [],
    visibility: "surfaced",
  });
  server.store.commands.transitionTaskState({
    id: task.id,
    to: "delivered",
    actorId: assignee.actor_id,
    deliverableRef: { message_id: msg.id, artifact_refs: [] },
  });
  return task;
}

describe("POST /api/tasks/:id/accept", () => {
  it("accepts a delivered root task: state -> done", async () => {
    const task = bootstrapDeliveredRootTask();
    const res = await server.app.inject({ method: "POST", url: `/api/tasks/${task.id}/accept`, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(server.store.tasks.get(task.id)!.state).toBe("done");
  });

  it("409s with invalid_transition when the task isn't delivered", async () => {
    const human = server.store.commands.getOrCreateHumanActor();
    const assignee = bootstrapAgent("Assignee2");
    const task = server.store.commands.createTask({
      parent_task_id: null,
      delegator_actor_id: human,
      assignee_agent_id: assignee.id,
      spec_md: "spec",
      acceptance_criteria_md: "AC",
      budget: { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 },
    });
    const res = await server.app.inject({ method: "POST", url: `/api/tasks/${task.id}/accept`, payload: {} });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("invalid_transition");
  });
});

describe("POST /api/tasks/:id/reject", () => {
  it("rejects a delivered root task with a reason: state -> rejected, not escalated (1st rejection, cap is 2)", async () => {
    const task = bootstrapDeliveredRootTask();
    const res = await server.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/reject`,
      payload: { reason: "missing tests" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.escalated).toBe(false);
    // Under the cap: reused task_started edge sends it back to in_progress (OPEN_ISSUES #7).
    expect(server.store.tasks.get(task.id)!.state).toBe("in_progress");
  });

  it("400s when no reason is given (RejectTaskRequestSchema requires one)", async () => {
    const task = bootstrapDeliveredRootTask();
    const res = await server.app.inject({ method: "POST", url: `/api/tasks/${task.id}/reject`, payload: {} });
    expect(res.statusCode).toBe(400);
  });
});
