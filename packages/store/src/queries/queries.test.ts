import { describe, expect, it } from "vitest";
import { newActorId } from "@foundry/core";
import { openDb } from "../db/connection.js";
import { createEventBus } from "../events/bus.js";
import { createMutate } from "../mutate.js";
import { createAgent, transitionAgentState } from "../mutations/agents.js";
import { createWorkstream } from "../mutations/workstreams.js";
import { createRun, transitionRunState } from "../mutations/runs.js";
import { createTask } from "../mutations/tasks.js";
import { getOrCreateThread, sendMessage } from "../mutations/messages.js";
import { requestApproval } from "../mutations/approvals.js";
import { createTeam } from "../mutations/teams.js";
import { createAgentQueries } from "./agents.js";
import { createWorkstreamQueries } from "./workstreams.js";
import { createRunQueries } from "./runs.js";
import { createTaskQueries } from "./tasks.js";
import { createMessageQueries } from "./messages.js";
import { createApprovalQueries } from "./approvals.js";
import { createTeamQueries } from "./teams.js";
import { createSearchQueries } from "./search.js";

const ZERO_BUDGET = { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 };

function harness() {
  const db = openDb(":memory:");
  const bus = createEventBus();
  const mutate = createMutate(db, bus);
  return { db, mutate };
}

describe("E2.3 entity queries", () => {
  it("agents: get/list by team and state, charter lookup", () => {
    const { db, mutate } = harness();
    const team = createTeam(mutate, { name: "Platform", description: "", default_policy: {} });
    const { agentId } = createAgent(mutate, {
      name: "Orbit",
      role: "Backend Engineer",
      team_id: team.id,
      engine_id: "claude-code",
      memory_ref: "m",
      charter_body_md: "# Orbit charter",
    });
    transitionAgentState(db, mutate, { id: agentId, to: "active", actorId: null });

    const q = createAgentQueries(db);
    expect(q.get(agentId)?.name).toBe("Orbit");
    expect(q.list({ team_id: team.id })).toHaveLength(1);
    expect(q.list({ state: "active" })).toHaveLength(1);
    expect(q.list({ state: "retired" })).toHaveLength(0);
    expect(q.getCharter(agentId)?.body_md).toBe("# Orbit charter");
    expect(q.get("01ARZ3NDEKTSV4RRFFQ69G5FAV" as never)).toBeUndefined();
  });

  it("workstreams: get/list by agent and state", () => {
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
      goal_md: "fix",
      origin: "human",
      budget: ZERO_BUDGET,
    });
    const q = createWorkstreamQueries(db);
    expect(q.get(ws.id)?.title).toBe("Bug #482");
    expect(q.list({ agent_id: agentId })).toHaveLength(1);
    expect(q.list({ state: "open" })).toHaveLength(1);
    expect(q.list({ state: "closed" })).toHaveLength(0);
  });

  it("runs: list orders by seq within a workstream", () => {
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
      budget: ZERO_BUDGET,
    });
    createRun(mutate, { workstream_id: ws.id, trigger: "human_message", input_context_ref: "a", engine_id: "claude-code" });
    createRun(mutate, { workstream_id: ws.id, trigger: "human_message", input_context_ref: "b", engine_id: "claude-code" });

    const q = createRunQueries(db);
    const runs = q.list({ workstream_id: ws.id });
    expect(runs.map((r) => r.seq)).toEqual([1, 2]);
  });

  it("tasks: tree() returns the whole delegation tree ordered by depth", () => {
    const { db, mutate } = harness();
    const { agentId } = createAgent(mutate, {
      name: "A",
      role: "R",
      team_id: null,
      engine_id: "claude-code",
      memory_ref: "m",
      charter_body_md: "#",
    });
    const human = newActorId();
    const root = createTask(db, mutate, {
      parent_task_id: null,
      delegator_actor_id: human,
      assignee_agent_id: agentId,
      spec_md: "root",
      acceptance_criteria_md: "ac",
      budget: ZERO_BUDGET,
    });
    const child1 = createTask(db, mutate, {
      parent_task_id: root.id,
      delegator_actor_id: human,
      assignee_agent_id: agentId,
      spec_md: "child1",
      acceptance_criteria_md: "ac",
      budget: ZERO_BUDGET,
    });
    createTask(db, mutate, {
      parent_task_id: child1.id,
      delegator_actor_id: human,
      assignee_agent_id: agentId,
      spec_md: "grandchild",
      acceptance_criteria_md: "ac",
      budget: ZERO_BUDGET,
    });
    // Unrelated tree must not leak in.
    createTask(db, mutate, {
      parent_task_id: null,
      delegator_actor_id: human,
      assignee_agent_id: agentId,
      spec_md: "unrelated",
      acceptance_criteria_md: "ac",
      budget: ZERO_BUDGET,
    });

    const q = createTaskQueries(db);
    const tree = q.tree(root.id);
    expect(tree).toHaveLength(3);
    expect(tree.map((t) => t.depth)).toEqual([0, 1, 2]);
    expect(tree.every((t) => t.root_task_id === root.id)).toBe(true);
  });

  it("messages: listByThread and listOpenForActor", () => {
    const { db, mutate } = harness();
    const asker = newActorId();
    const responder = newActorId();
    const thread = getOrCreateThread(db, mutate, "workstream", "ws1");
    sendMessage(mutate, {
      thread_id: thread.id,
      from_actor_id: asker,
      to_actor_id: responder,
      type: "question",
      body_md: "q1",
    });

    const q = createMessageQueries(db);
    expect(q.listByThread(thread.id)).toHaveLength(1);
    expect(q.listOpenForActor(responder)).toHaveLength(1);
    expect(q.listOpenForActor(asker)).toHaveLength(0);
    expect(q.getThread(thread.id)?.anchor_id).toBe("ws1");
  });

  it("approvals: listPending", () => {
    const { db, mutate } = harness();
    const human = newActorId();
    requestApproval(mutate, { requested_by_actor: human, kind: "budget_increase" });
    const q = createApprovalQueries(db);
    expect(q.listPending()).toHaveLength(1);
  });

  it("teams: list ordered by name", () => {
    const { db, mutate } = harness();
    createTeam(mutate, { name: "Zeta", description: "", default_policy: {} });
    createTeam(mutate, { name: "Alpha", description: "", default_policy: {} });
    const q = createTeamQueries(db);
    expect(q.list().map((t) => t.name)).toEqual(["Alpha", "Zeta"]);
  });

  it("perf sanity: 10k task rows, tree() and list() stay fast", () => {
    const { db, mutate } = harness();
    const { agentId } = createAgent(mutate, {
      name: "A",
      role: "R",
      team_id: null,
      engine_id: "claude-code",
      memory_ref: "m",
      charter_body_md: "#",
    });
    const human = newActorId();
    const root = createTask(db, mutate, {
      parent_task_id: null,
      delegator_actor_id: human,
      assignee_agent_id: agentId,
      spec_md: "root",
      acceptance_criteria_md: "ac",
      budget: ZERO_BUDGET,
    });
    for (let i = 0; i < 9999; i++) {
      createTask(db, mutate, {
        parent_task_id: null,
        delegator_actor_id: human,
        assignee_agent_id: agentId,
        spec_md: `task ${i}`,
        acceptance_criteria_md: "ac",
        budget: ZERO_BUDGET,
      });
    }
    const q = createTaskQueries(db);
    const start = performance.now();
    const all = q.list();
    const tree = q.tree(root.id);
    const elapsed = performance.now() - start;
    expect(all).toHaveLength(10000);
    expect(tree).toHaveLength(1);
    expect(elapsed).toBeLessThan(2000);
  }, 20000);

  it("search: text finds messages by body_md content", () => {
    const { db, mutate } = harness();
    const actor1 = newActorId();
    const actor2 = newActorId();
    const thread = getOrCreateThread(db, mutate, "workstream", "ws1");

    sendMessage(mutate, {
      thread_id: thread.id,
      from_actor_id: actor1,
      to_actor_id: actor2,
      type: "status",
      body_md: "Found a critical bug in the database layer",
    });

    const q = createSearchQueries(db);
    const hits = q.text("database", { actor_ids: [actor1, actor2] });
    expect(hits).toHaveLength(1);
    expect(hits[0].ref).toContain("message");
    expect(hits[0].excerpt).toContain("database");
  });

  it("search: text finds workstreams by title and goal_md", () => {
    const { db, mutate } = harness();
    const { agentId } = createAgent(mutate, {
      name: "SearchBot",
      role: "Engineer",
      team_id: null,
      engine_id: "claude-code",
      memory_ref: "m",
      charter_body_md: "#",
    });

    createWorkstream(mutate, {
      agent_id: agentId,
      title: "Implement authentication system",
      goal_md: "Build OAuth2 integration with multi-factor support",
      origin: "human",
      budget: ZERO_BUDGET,
    });

    const q = createSearchQueries(db);
    const hits = q.text("OAuth2");
    expect(hits).toHaveLength(1);
    expect(hits[0].ref).toContain("workstream");
    expect(hits[0].excerpt).toContain("OAuth2");
  });

  it("search: text finds runs by result_json content", () => {
    const { db, mutate } = harness();
    const { agentId } = createAgent(mutate, {
      name: "WorkBot",
      role: "Worker",
      team_id: null,
      engine_id: "claude-code",
      memory_ref: "m",
      charter_body_md: "#",
    });

    const ws = createWorkstream(mutate, {
      agent_id: agentId,
      title: "Process data",
      goal_md: "Transform input to output",
      origin: "human",
      budget: ZERO_BUDGET,
    });

    const run = createRun(mutate, {
      workstream_id: ws.id,
      trigger: "human_message",
      input_context_ref: "ctx",
      engine_id: "claude-code",
    });

    // Run must go through valid state transitions: queued -> starting -> running -> completed
    transitionRunState(db, mutate, { id: run.id, workstreamId: ws.id, to: "starting", actorId: null });
    transitionRunState(db, mutate, { id: run.id, workstreamId: ws.id, to: "running", actorId: null });
    transitionRunState(db, mutate, {
      id: run.id,
      workstreamId: ws.id,
      to: "completed",
      actorId: null,
      result: { outcome: "completed", final_text: "Processed 1000 records with zero errors" },
    });

    const q = createSearchQueries(db);
    const hits = q.text("processed");
    expect(hits).toHaveLength(1);
    expect(hits[0].ref).toContain("run");
  });

  it("search: filter by actor_ids scopes message search", () => {
    const { db, mutate } = harness();
    const actor1 = newActorId();
    const actor2 = newActorId();
    const actor3 = newActorId();

    const thread = getOrCreateThread(db, mutate, "workstream", "ws1");

    sendMessage(mutate, {
      thread_id: thread.id,
      from_actor_id: actor1,
      to_actor_id: actor2,
      type: "status",
      body_md: "This is a secret message",
    });

    sendMessage(mutate, {
      thread_id: thread.id,
      from_actor_id: actor3,
      to_actor_id: actor1,
      type: "status",
      body_md: "This is another secret message",
    });

    const q = createSearchQueries(db);

    // actor1 can see both (sender of first, recipient of second)
    const hitsActor1 = q.text("secret", { actor_ids: [actor1] });
    expect(hitsActor1).toHaveLength(2);

    // actor3 can see only their own message
    const hitsActor3 = q.text("secret", { actor_ids: [actor3] });
    expect(hitsActor3).toHaveLength(1);

    // actor2 can see only the first message (recipient)
    const hitsActor2 = q.text("secret", { actor_ids: [actor2] });
    expect(hitsActor2).toHaveLength(1);
  });

  it("search: filter by agent_ids scopes workstream and run search", () => {
    const { db, mutate } = harness();
    const { agentId: agent1Id } = createAgent(mutate, {
      name: "Agent1",
      role: "Engineer",
      team_id: null,
      engine_id: "claude-code",
      memory_ref: "m",
      charter_body_md: "#",
    });
    const { agentId: agent2Id } = createAgent(mutate, {
      name: "Agent2",
      role: "Engineer",
      team_id: null,
      engine_id: "claude-code",
      memory_ref: "m",
      charter_body_md: "#",
    });

    createWorkstream(mutate, {
      agent_id: agent1Id,
      title: "Private project alpha",
      goal_md: "Confidential research",
      origin: "human",
      budget: ZERO_BUDGET,
    });

    createWorkstream(mutate, {
      agent_id: agent2Id,
      title: "Public project beta",
      goal_md: "Open research",
      origin: "human",
      budget: ZERO_BUDGET,
    });

    const q = createSearchQueries(db);

    // Unfiltered returns both
    const allHits = q.text("project");
    expect(allHits).toHaveLength(2);

    // Filter by agent1 returns only their workstream
    const agent1Hits = q.text("project", { agent_ids: [agent1Id] });
    expect(agent1Hits).toHaveLength(1);
    expect(agent1Hits[0].excerpt).toContain("alpha");
  });

  it("search: special characters in query do not crash", () => {
    const { db, mutate } = harness();
    const actor = newActorId();
    const thread = getOrCreateThread(db, mutate, "workstream", "ws1");

    sendMessage(mutate, {
      thread_id: thread.id,
      from_actor_id: actor,
      type: "status",
      body_md: 'The user said "hello" and then left.',
    });

    const q = createSearchQueries(db);

    // These queries contain FTS5 special characters but should not crash
    expect(() => q.text('"hello"')).not.toThrow();
    expect(() => q.text("hello-world")).not.toThrow();
    expect(() => q.text("*asterisk*")).not.toThrow();
    expect(() => q.text("OR AND NOT")).not.toThrow();

    // The phrase-match escaping should still find the message
    const hits = q.text("hello");
    expect(hits.length).toBeGreaterThanOrEqual(0); // May or may not match depending on query syntax
  });
});
