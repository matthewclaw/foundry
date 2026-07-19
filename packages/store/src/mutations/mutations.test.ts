import { describe, expect, it } from "vitest";
import { newActorId } from "@foundry/core";
import { openDb } from "../db/connection.js";
import { createEventBus } from "../events/bus.js";
import { createMutate } from "../mutate.js";
import { createAgent, transitionAgentState } from "./agents.js";
import { createTeam, updateTeam, deleteTeam } from "./teams.js";
import { createWorkstream, transitionWorkstreamState } from "./workstreams.js";
import { createTask, transitionTaskState } from "./tasks.js";
import { createRun, transitionRunState, setRunTitle } from "./runs.js";
import { getOrCreateThread, resolveMessageDisposition, sendMessage } from "./messages.js";
import { InvalidTransitionError } from "./transition-helper.js";

function harness() {
  const db = openDb(":memory:");
  const bus = createEventBus();
  const mutate = createMutate(db, bus);
  return { db, mutate };
}

describe("agent mutation helpers", () => {
  it("walks the full lifecycle and rejects invalid transitions (02 Agent Lifecycle)", () => {
    const { db, mutate } = harness();
    const { agentId } = createAgent(mutate, {
      name: "Orbit",
      role: "Backend Engineer",
      team_id: null,
      engine_id: "claude-code",
      memory_ref: "agents/orbit/memory",
      charter_body_md: "# Orbit",
    });

    transitionAgentState(db, mutate, { id: agentId, to: "active", actorId: null });
    transitionAgentState(db, mutate, { id: agentId, to: "suspended", actorId: null, reason: "seasonal" });
    transitionAgentState(db, mutate, { id: agentId, to: "active", actorId: null });
    transitionAgentState(db, mutate, { id: agentId, to: "retired", actorId: null });

    const row = db.prepare(`SELECT state FROM agents WHERE id = ?`).get(agentId) as { state: string };
    expect(row.state).toBe("retired");

    expect(() => transitionAgentState(db, mutate, { id: agentId, to: "active", actorId: null })).toThrow(
      InvalidTransitionError
    );

    const events = db.prepare(`SELECT type FROM events ORDER BY seq`).all() as { type: string }[];
    expect(events.map((e) => e.type)).toEqual([
      "agent_created",
      "agent_activated",
      "agent_suspended",
      "agent_resumed",
      "agent_retired",
    ]);
  });
});

describe("workstream mutation helpers (OPEN_ISSUES.md #6)", () => {
  it("allows waiting -> blocked directly, and close from any non-terminal state", () => {
    const { db, mutate } = harness();
    const { agentId } = createAgent(mutate, {
      name: "A",
      role: "R",
      team_id: null,
      engine_id: "claude-code",
      memory_ref: "m",
      charter_body_md: "#",
    });
    const ws = createWorkstream(mutate, {
      agent_id: agentId,
      title: "Bug #482",
      goal_md: "fix it",
      origin: "human",
      budget: { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 },
    });

    transitionWorkstreamState(db, mutate, { id: ws.id, to: "active", actorId: null });
    transitionWorkstreamState(db, mutate, { id: ws.id, to: "waiting", actorId: null, waitingOnRef: null });
    transitionWorkstreamState(db, mutate, { id: ws.id, to: "blocked", actorId: null, reason: "discovered a blocker" });
    transitionWorkstreamState(db, mutate, { id: ws.id, to: "closed", actorId: null });

    const row = db.prepare(`SELECT state, closed_at FROM workstreams WHERE id = ?`).get(ws.id) as {
      state: string;
      closed_at: string | null;
    };
    expect(row.state).toBe("closed");
    expect(row.closed_at).not.toBeNull();
  });

  it("rejects an edge not in the transition table", () => {
    const { db, mutate } = harness();
    const { agentId } = createAgent(mutate, {
      name: "A",
      role: "R",
      team_id: null,
      engine_id: "claude-code",
      memory_ref: "m",
      charter_body_md: "#",
    });
    const ws = createWorkstream(mutate, {
      agent_id: agentId,
      title: "T",
      goal_md: "g",
      origin: "human",
      budget: { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 },
    });
    expect(() => transitionWorkstreamState(db, mutate, { id: ws.id, to: "archived", actorId: null })).toThrow(
      InvalidTransitionError
    );
  });
});

describe("task mutation helpers (OPEN_ISSUES.md #7: rejection loop reuses task_started)", () => {
  it("rejected -> in_progress emits task_started, not a new event type", () => {
    const { db, mutate } = harness();
    const { agentId, actorId } = createAgent(mutate, {
      name: "A",
      role: "R",
      team_id: null,
      engine_id: "claude-code",
      memory_ref: "m",
      charter_body_md: "#",
    });
    const humanActor = newActorId();
    const task = createTask(db, mutate, {
      parent_task_id: null,
      delegator_actor_id: humanActor,
      assignee_agent_id: agentId,
      spec_md: "do the thing",
      acceptance_criteria_md: "it works",
      budget: { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 },
    });
    expect(task.root_task_id).toBe(task.id);
    expect(task.depth).toBe(0);

    transitionTaskState(db, mutate, { id: task.id, to: "in_progress", actorId });
    transitionTaskState(db, mutate, {
      id: task.id,
      to: "delivered",
      actorId,
      deliverableRef: { message_id: newActorId() as never, artifact_refs: [] },
    });
    transitionTaskState(db, mutate, { id: task.id, to: "rejected", actorId: humanActor, reason: "not quite" });
    transitionTaskState(db, mutate, { id: task.id, to: "in_progress", actorId });

    const row = db.prepare(`SELECT state, rejection_count FROM tasks WHERE id = ?`).get(task.id) as {
      state: string;
      rejection_count: number;
    };
    expect(row.state).toBe("in_progress");
    expect(row.rejection_count).toBe(1);

    const eventTypes = db
      .prepare(`SELECT type FROM events WHERE entity_type = 'task' ORDER BY seq`)
      .all()
      .map((r) => (r as { type: string }).type);
    expect(eventTypes).toEqual(["task_created", "task_started", "task_delivered", "task_rejected", "task_started"]);
  });

  it("child tasks inherit root_task_id and increment depth (delegation tree)", () => {
    const { db, mutate } = harness();
    const { agentId } = createAgent(mutate, {
      name: "A",
      role: "R",
      team_id: null,
      engine_id: "claude-code",
      memory_ref: "m",
      charter_body_md: "#",
    });
    const humanActor = newActorId();
    const root = createTask(db, mutate, {
      parent_task_id: null,
      delegator_actor_id: humanActor,
      assignee_agent_id: agentId,
      spec_md: "root",
      acceptance_criteria_md: "ac",
      budget: { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 },
    });
    const child = createTask(db, mutate, {
      parent_task_id: root.id,
      delegator_actor_id: humanActor,
      assignee_agent_id: agentId,
      spec_md: "child",
      acceptance_criteria_md: "ac",
      budget: { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 },
    });
    expect(child.root_task_id).toBe(root.id);
    expect(child.depth).toBe(1);
  });
});

describe("run mutation helpers", () => {
  it("assigns per-workstream seq and walks queued -> starting -> running -> completed", () => {
    const { db, mutate } = harness();
    const { agentId } = createAgent(mutate, {
      name: "A",
      role: "R",
      team_id: null,
      engine_id: "claude-code",
      memory_ref: "m",
      charter_body_md: "#",
    });
    const ws = createWorkstream(mutate, {
      agent_id: agentId,
      title: "T",
      goal_md: "g",
      origin: "human",
      budget: { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 },
    });
    const run1 = createRun(mutate, {
      workstream_id: ws.id,
      trigger: "human_message",
      input_context_ref: "runs/1/context.md",
      engine_id: "claude-code",
    });
    const run2 = createRun(mutate, {
      workstream_id: ws.id,
      trigger: "human_message",
      input_context_ref: "runs/2/context.md",
      engine_id: "claude-code",
    });
    expect(run1.seq).toBe(1);
    expect(run2.seq).toBe(2);

    transitionRunState(db, mutate, { id: run1.id, workstreamId: ws.id, to: "starting", actorId: null });
    transitionRunState(db, mutate, { id: run1.id, workstreamId: ws.id, to: "running", actorId: null });
    transitionRunState(db, mutate, {
      id: run1.id,
      workstreamId: ws.id,
      to: "completed",
      actorId: null,
      result: { outcome: "completed", final_text: "done", artifact_refs: [] },
    });

    const row = db.prepare(`SELECT state, ended_at FROM runs WHERE id = ?`).get(run1.id) as {
      state: string;
      ended_at: string | null;
    };
    expect(row.state).toBe("completed");
    expect(row.ended_at).not.toBeNull();
  });

  it("setRunTitle renames a run's conversation without touching its state", () => {
    const { db, mutate } = harness();
    const { agentId } = createAgent(mutate, {
      name: "A",
      role: "R",
      team_id: null,
      engine_id: "claude-code",
      memory_ref: "m",
      charter_body_md: "#",
    });
    const ws = createWorkstream(mutate, {
      agent_id: agentId,
      title: "T",
      goal_md: "g",
      origin: "human",
      budget: { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 },
    });
    const run = createRun(mutate, {
      workstream_id: ws.id,
      trigger: "human_message",
      input_context_ref: "runs/1/context.md",
      engine_id: "claude-code",
    });
    expect(run.title).toBeNull();

    setRunTitle(mutate, { id: run.id, workstreamId: ws.id, title: "Debugging the login flow" });

    const row = db.prepare(`SELECT title, state FROM runs WHERE id = ?`).get(run.id) as {
      title: string | null;
      state: string;
    };
    expect(row.title).toBe("Debugging the login flow");
    expect(row.state).toBe("queued");
  });
});

describe("message disposition helpers (OPEN_ISSUES.md #8)", () => {
  it("a question opens and can be answered", () => {
    const { db, mutate } = harness();
    const asker = newActorId();
    const responder = newActorId();
    const thread = getOrCreateThread(db, mutate, "workstream", "ws_fixture");
    const question = sendMessage(mutate, {
      thread_id: thread.id,
      from_actor_id: asker,
      to_actor_id: responder,
      type: "question",
      body_md: "What's the deploy target?",
    });
    expect(question.disposition).toBe("open");

    resolveMessageDisposition(db, mutate, {
      id: question.id,
      messageType: "question",
      to: "answered",
      actorId: responder,
    });

    const row = db.prepare(`SELECT disposition FROM messages WHERE id = ?`).get(question.id) as {
      disposition: string;
    };
    expect(row.disposition).toBe("answered");
  });

  it("status messages carry no disposition lifecycle", () => {
    const { db, mutate } = harness();
    const from = newActorId();
    const to = newActorId();
    const thread = getOrCreateThread(db, mutate, "workstream", "ws_fixture_2");
    const status = sendMessage(mutate, {
      thread_id: thread.id,
      from_actor_id: from,
      to_actor_id: to,
      type: "status",
      body_md: "still working on it",
    });
    expect(status.disposition).toBe("none");
  });
});

describe("teams", () => {
  it("creates a team with no emitted event (labels only, 02)", () => {
    const { db, mutate } = harness();
    const team = createTeam(mutate, { name: "Platform", description: "infra", default_policy: {} });
    const row = db.prepare(`SELECT name FROM teams WHERE id = ?`).get(team.id) as { name: string };
    expect(row.name).toBe("Platform");
  });

  it("renames a team, leaving fields not passed untouched", () => {
    const { db, mutate } = harness();
    const team = createTeam(mutate, { name: "Platform", description: "infra", default_policy: {} });

    const renamed = updateTeam(db, mutate, { id: team.id, name: "Core Platform" });
    expect(renamed.name).toBe("Core Platform");
    expect(renamed.description).toBe("infra");

    const row = db.prepare(`SELECT name, description FROM teams WHERE id = ?`).get(team.id) as {
      name: string;
      description: string;
    };
    expect(row).toEqual({ name: "Core Platform", description: "infra" });
  });

  it("throws renaming a team that doesn't exist", () => {
    const { db, mutate } = harness();
    expect(() => updateTeam(db, mutate, { id: "nonexistent" as never, name: "X" })).toThrow(/not found/);
  });

  it("deletes a team and unassigns its member agents rather than touching them", () => {
    const { db, mutate } = harness();
    const team = createTeam(mutate, { name: "Platform", description: "infra", default_policy: {} });
    const { agentId } = createAgent(mutate, {
      name: "Orbit",
      role: "Backend Engineer",
      team_id: team.id,
      engine_id: "claude-code",
      memory_ref: "agents/orbit/memory",
      charter_body_md: "# Orbit",
    });

    deleteTeam(db, mutate, team.id);

    expect(db.prepare(`SELECT id FROM teams WHERE id = ?`).get(team.id)).toBeUndefined();
    const agentRow = db.prepare(`SELECT team_id FROM agents WHERE id = ?`).get(agentId) as { team_id: string | null };
    expect(agentRow.team_id).toBeNull();
  });

  it("throws deleting a team that doesn't exist", () => {
    const { db, mutate } = harness();
    expect(() => deleteTeam(db, mutate, "nonexistent" as never)).toThrow(/not found/);
  });
});
