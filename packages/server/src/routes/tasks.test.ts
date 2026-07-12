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

describe("POST /api/tasks/:id/cancel", () => {
  it("cancels a task with no children: transitions root only", async () => {
    const task = bootstrapDeliveredRootTask();
    const res = await server.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/cancel`,
      payload: { reason: "cancelled by human" },
    });
    expect(res.statusCode).toBe(200);
    expect(server.store.tasks.get(task.id)!.state).toBe("cancelled");
  });

  it("cancels a task subtree: all descendants transition to cancelled", async () => {
    const human = server.store.commands.getOrCreateHumanActor();
    const root = bootstrapAgent("Root");
    const child = bootstrapAgent("Child");

    // Create root task delegated to Root
    const rootTask = server.store.commands.createTask({
      parent_task_id: null,
      delegator_actor_id: human,
      assignee_agent_id: root.id,
      spec_md: "root spec",
      acceptance_criteria_md: "root AC",
      budget: { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 },
    });
    server.store.commands.transitionTaskState({ id: rootTask.id, to: "in_progress", actorId: null });

    // Create child task delegated by Root to Child
    const childTask = server.store.commands.createTask({
      parent_task_id: rootTask.id,
      delegator_actor_id: root.actor_id,
      assignee_agent_id: child.id,
      spec_md: "child spec",
      acceptance_criteria_md: "child AC",
      budget: { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 },
    });
    server.store.commands.transitionTaskState({ id: childTask.id, to: "in_progress", actorId: null });

    // Cancel the root — should cascade to child
    const res = await server.app.inject({
      method: "POST",
      url: `/api/tasks/${rootTask.id}/cancel`,
      payload: { reason: "cascade test" },
    });
    expect(res.statusCode).toBe(200);

    // Both root and child should be cancelled
    expect(server.store.tasks.get(rootTask.id)!.state).toBe("cancelled");
    expect(server.store.tasks.get(childTask.id)!.state).toBe("cancelled");
  });

  it("refuses to cancel an already-done task", async () => {
    const human = server.store.commands.getOrCreateHumanActor();
    const assignee = bootstrapAgent("Done");
    const task = server.store.commands.createTask({
      parent_task_id: null,
      delegator_actor_id: human,
      assignee_agent_id: assignee.id,
      spec_md: "spec",
      acceptance_criteria_md: "AC",
      budget: { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 },
    });

    // Manually transition to done (skipping the normal delivered path for test simplicity)
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
    server.store.commands.transitionTaskState({ id: task.id, to: "done", actorId: human, acceptedBy: human });

    // Attempt to cancel — should skip silently (terminal state)
    const res = await server.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/cancel`,
      payload: { reason: "should skip done tasks" },
    });
    expect(res.statusCode).toBe(200);
    // Task remains done
    expect(server.store.tasks.get(task.id)!.state).toBe("done");
  });
});
