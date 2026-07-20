import { describe, expect, it } from "vitest";
import { openDb } from "../db/connection.js";
import { createEventBus } from "../events/bus.js";
import { createMutate } from "../mutate.js";
import { createAgent } from "./agents.js";
import { createWorkstream, transitionWorkstreamState } from "./workstreams.js";
import { createRun, transitionRunState } from "./runs.js";
import { createTask } from "./tasks.js";
import { getOrCreateThread, sendMessage } from "./messages.js";
import { deleteWorkstream, deleteAgent } from "./deletes.js";

const BUDGET = { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 };

function harness() {
  const db = openDb(":memory:");
  return { db, mutate: createMutate(db, createEventBus()) };
}

/** Seed an agent with a workstream that has a run (+ its events) and a thread + message. */
function seedAgentWithWork(db: ReturnType<typeof openDb>, mutate: ReturnType<typeof createMutate>) {
  const { agentId, actorId } = createAgent(mutate, {
    name: "Wynn",
    role: "Backend Engineer",
    team_id: null,
    engine_id: "fake",
    memory_ref: "agents/wynn/memory",
    charter_body_md: "# Wynn",
  });
  const ws = createWorkstream(mutate, {
    agent_id: agentId,
    title: "Do a thing",
    goal_md: "goal",
    origin: "human",
    budget: BUDGET,
  });
  const run = createRun(mutate, {
    workstream_id: ws.id,
    trigger: "human_message",
    input_context_ref: "runs/{run_id}/context.md",
    engine_id: "fake",
  });
  transitionRunState(db, mutate, { id: run.id, workstreamId: ws.id, to: "starting", actorId: null });
  const thread = getOrCreateThread(db, mutate, "workstream", ws.id);
  sendMessage(mutate, { thread_id: thread.id, from_actor_id: actorId, type: "answer", body_md: "hi" });
  return { agentId, actorId, wsId: ws.id, runId: run.id, threadId: thread.id };
}

const count = (db: ReturnType<typeof openDb>, sql: string, ...args: unknown[]) =>
  (db.prepare(sql).get(...args) as { n: number }).n;

/** No dangling foreign-key references anywhere in the DB. */
const fkClean = (db: ReturnType<typeof openDb>) => db.prepare(`PRAGMA foreign_key_check`).all().length === 0;

describe("deleteWorkstream", () => {
  it("purges the workstream and everything it owns, leaving the agent and FK integrity intact", () => {
    const { db, mutate } = harness();
    const { agentId, wsId, runId, threadId } = seedAgentWithWork(db, mutate);

    deleteWorkstream(db, mutate, wsId);

    expect(count(db, `SELECT COUNT(*) n FROM workstreams WHERE id = ?`, wsId)).toBe(0);
    expect(count(db, `SELECT COUNT(*) n FROM runs WHERE id = ?`, runId)).toBe(0);
    expect(count(db, `SELECT COUNT(*) n FROM events WHERE workstream_id = ?`, wsId)).toBe(0);
    expect(count(db, `SELECT COUNT(*) n FROM messages WHERE thread_id = ?`, threadId)).toBe(0);
    expect(count(db, `SELECT COUNT(*) n FROM threads WHERE id = ?`, threadId)).toBe(0);
    expect(count(db, `SELECT COUNT(*) n FROM workstreams_fts WHERE id = ?`, wsId)).toBe(0);
    // agent survives — a workstream delete doesn't touch its owner
    expect(count(db, `SELECT COUNT(*) n FROM agents WHERE id = ?`, agentId)).toBe(1);
    expect(fkClean(db)).toBe(true);
  });

  it("throws on an unknown workstream", () => {
    const { db, mutate } = harness();
    expect(() => deleteWorkstream(db, mutate, "01ARZ3NDEKTSV4RRFFQ69G5FAV" as never)).toThrow(/not found/);
  });
});

describe("deleteAgent", () => {
  it("purges the agent, its actor, workstreams, tasks and charter with FK integrity intact", () => {
    const { db, mutate } = harness();
    const { agentId, actorId, wsId } = seedAgentWithWork(db, mutate);
    // a task assigned to this agent
    const task = createTask(db, mutate, {
      parent_task_id: null,
      delegator_actor_id: actorId,
      assignee_agent_id: agentId,
      spec_md: "spec",
      acceptance_criteria_md: "ac",
      budget: BUDGET,
    });

    deleteAgent(db, mutate, agentId);

    expect(count(db, `SELECT COUNT(*) n FROM agents WHERE id = ?`, agentId)).toBe(0);
    expect(count(db, `SELECT COUNT(*) n FROM actors WHERE id = ?`, actorId)).toBe(0);
    expect(count(db, `SELECT COUNT(*) n FROM workstreams WHERE id = ?`, wsId)).toBe(0);
    expect(count(db, `SELECT COUNT(*) n FROM tasks WHERE id = ?`, task.id)).toBe(0);
    expect(count(db, `SELECT COUNT(*) n FROM agent_charters WHERE agent_id = ?`, agentId)).toBe(0);
    expect(fkClean(db)).toBe(true);
  });

  it("keeps a child task delegated to another agent, re-rooting it instead of dangling", () => {
    const { db, mutate } = harness();
    const { agentId, actorId } = seedAgentWithWork(db, mutate);
    const other = createAgent(mutate, {
      name: "Other",
      role: "QA",
      team_id: null,
      engine_id: "fake",
      memory_ref: "agents/other/memory",
      charter_body_md: "# Other",
    });
    const parent = createTask(db, mutate, {
      parent_task_id: null,
      delegator_actor_id: actorId,
      assignee_agent_id: agentId,
      spec_md: "parent",
      acceptance_criteria_md: "ac",
      budget: BUDGET,
    });
    const child = createTask(db, mutate, {
      parent_task_id: parent.id,
      delegator_actor_id: actorId,
      assignee_agent_id: other.agentId,
      spec_md: "child",
      acceptance_criteria_md: "ac",
      budget: BUDGET,
    });

    deleteAgent(db, mutate, agentId);

    // parent (assigned to the deleted agent) is gone; child survives, re-rooted to null
    expect(count(db, `SELECT COUNT(*) n FROM tasks WHERE id = ?`, parent.id)).toBe(0);
    const childRow = db.prepare(`SELECT parent_task_id FROM tasks WHERE id = ?`).get(child.id) as
      | { parent_task_id: string | null }
      | undefined;
    expect(childRow?.parent_task_id).toBeNull();
    expect(fkClean(db)).toBe(true);
  });
});
