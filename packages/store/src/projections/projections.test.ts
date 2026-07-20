import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newActorId } from "@foundry/core";
import { openDb } from "../db/connection.js";
import { createEventBus } from "../events/bus.js";
import { createMutate } from "../mutate.js";
import { createAgent, transitionAgentState } from "../mutations/agents.js";
import { createTeam } from "../mutations/teams.js";
import { createWorkstream, transitionWorkstreamState } from "../mutations/workstreams.js";
import { createRun, transitionRunState, emitRunDetailEvent } from "../mutations/runs.js";
import { createTask, transitionTaskState } from "../mutations/tasks.js";
import { getOrCreateThread, sendMessage } from "../mutations/messages.js";
import { requestApproval } from "../mutations/approvals.js";
import { createEventFeed } from "../events/feed.js";
import { createProjections } from "./index.js";

const ZERO_BUDGET = { limit_usd: 10, limit_tokens: null, spent_usd: 1.5, spent_tokens: 0 };

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function harness() {
  dir = mkdtempSync(join(tmpdir(), "foundry-proj-"));
  const db = openDb(":memory:");
  const bus = createEventBus();
  const mutate = createMutate(db, bus);
  const feed = createEventFeed(db, bus, mutate, dir);
  const projections = createProjections(db, dir);
  return { db, mutate, feed, projections, dataDir: dir };
}

describe("E2.5 projections (fixture-based)", () => {
  it("orgView: groups agents by team, worst-of status roll-up", () => {
    const { db, mutate, projections } = harness();
    const team = createTeam(mutate, { name: "Platform", description: "", default_policy: {} });
    const { agentId: a1 } = createAgent(mutate, {
      name: "Orbit",
      role: "Backend",
      team_id: team.id,
      engine_id: "claude-code",
      memory_ref: "m1",
      charter_body_md: "#",
    });
    transitionAgentState(db, mutate, { id: a1, to: "active", actorId: null });
    const ws = createWorkstream(mutate, {
      agent_id: a1,
      title: "Bug #1",
      goal_md: "g",
      origin: "human",
      budget: ZERO_BUDGET,
    });
    transitionWorkstreamState(db, mutate, { id: ws.id, to: "active", actorId: null });
    transitionWorkstreamState(db, mutate, { id: ws.id, to: "blocked", actorId: null, reason: "waiting on infra" });

    const view = projections.orgView();
    expect(view.teams).toHaveLength(1);
    expect(view.teams[0]!.name).toBe("Platform");
    expect(view.teams[0]!.agents).toHaveLength(1);
    expect(view.teams[0]!.agents[0]!.status).toBe("blocked");
    expect(view.teams[0]!.status).toBe("blocked");
  });

  it("agentPage: charter, status, workstreams, open tasks, relationships", () => {
    const { db, mutate, projections } = harness();
    const { agentId, actorId } = createAgent(mutate, {
      name: "Orbit",
      role: "Backend",
      team_id: null,
      engine_id: "claude-code",
      memory_ref: "m1",
      charter_body_md: "# Orbit charter",
    });
    transitionAgentState(db, mutate, { id: agentId, to: "active", actorId: null });
    createWorkstream(mutate, { agent_id: agentId, title: "WS1", goal_md: "g", origin: "human", budget: ZERO_BUDGET });

    const human = newActorId();
    const task = createTask(db, mutate, {
      parent_task_id: null,
      delegator_actor_id: human,
      assignee_agent_id: agentId,
      spec_md: "do it",
      acceptance_criteria_md: "ac",
      budget: ZERO_BUDGET,
    });
    void task;
    const thread = getOrCreateThread(db, mutate, "workstream", "ws-fixture");
    sendMessage(mutate, { thread_id: thread.id, from_actor_id: human, to_actor_id: actorId, type: "question", body_md: "hi" });

    const page = projections.agentPage(agentId);
    expect(page).toBeDefined();
    expect(page!.charter?.body_md).toBe("# Orbit charter");
    expect(page!.workstreams).toHaveLength(1);
    expect(page!.openTasks).toHaveLength(1);
    expect(page!.relationships).toHaveLength(1);
    expect(page!.relationships[0]!.actor_id).toBe(human);
    expect(page!.relationships[0]!.weight).toBe(2); // one task + one message

    expect(projections.agentPage("01ARZ3NDEKTSV4RRFFQ69G5FAV" as never)).toBeUndefined();
  });

  it("agentPage relationships resolve a counterpart agent's name and id for linking", () => {
    const { db, mutate, projections } = harness();
    const lead = createAgent(mutate, { name: "Lead", role: "Lead", team_id: null, engine_id: "fake", memory_ref: "m1", charter_body_md: "#" });
    transitionAgentState(db, mutate, { id: lead.agentId, to: "active", actorId: null });
    const wynn = createAgent(mutate, { name: "Wynn", role: "Backend", team_id: null, engine_id: "fake", memory_ref: "m2", charter_body_md: "#" });
    transitionAgentState(db, mutate, { id: wynn.agentId, to: "active", actorId: null });
    createTask(db, mutate, {
      parent_task_id: null,
      delegator_actor_id: lead.actorId,
      assignee_agent_id: wynn.agentId,
      spec_md: "x",
      acceptance_criteria_md: "ac",
      budget: ZERO_BUDGET,
    });

    // From Lead's page, the counterpart is Wynn — a real agent, so it resolves to a name
    // and a linkable agent id rather than a bare actor id.
    const rel = projections.agentPage(lead.agentId)!.relationships.find((r) => r.counterpart_agent_id === wynn.agentId);
    expect(rel).toBeDefined();
    expect(rel!.counterpart_name).toBe("Wynn");
    expect(rel!.counterpart_kind).toBe("agent");
  });

  it("workstreamTimeline: renders live deltas, then falls back to the transcript file post-compaction (E2.6)", () => {
    const { db, mutate, feed, projections } = harness();
    const { agentId } = createAgent(mutate, {
      name: "A",
      role: "R",
      team_id: null,
      engine_id: "claude-code",
      memory_ref: "m",
      charter_body_md: "#",
    });
    const ws = createWorkstream(mutate, { agent_id: agentId, title: "T", goal_md: "g", origin: "human", budget: ZERO_BUDGET });
    const run = createRun(mutate, { workstream_id: ws.id, trigger: "human_message", input_context_ref: "a", engine_id: "claude-code" });
    transitionRunState(db, mutate, { id: run.id, workstreamId: ws.id, to: "starting", actorId: null });
    transitionRunState(db, mutate, { id: run.id, workstreamId: ws.id, to: "running", actorId: null });
    emitRunDetailEvent(mutate, { entity_id: run.id, type: "run_output_delta", payload: { text: "Hello " }, run_id: run.id, workstream_id: ws.id, actor_id: null });
    emitRunDetailEvent(mutate, { entity_id: run.id, type: "run_output_delta", payload: { text: "world" }, run_id: run.id, workstream_id: ws.id, actor_id: null });
    transitionRunState(db, mutate, {
      id: run.id,
      workstreamId: ws.id,
      to: "completed",
      actorId: null,
      result: { outcome: "completed", final_text: "Hello world", artifact_refs: [] },
    });

    const before = projections.workstreamTimeline(ws.id);
    expect(before.runs).toHaveLength(1);
    expect(before.runs[0]!.transcriptSource).toBe("live");
    expect(before.runs[0]!.transcriptText).toBe("Hello world");
    expect(before.runs[0]!.events.some((e) => e.type === "run_completed")).toBe(true);

    feed.compactRunDeltas(run.id);

    const after = projections.workstreamTimeline(ws.id);
    expect(after.runs).toHaveLength(1);
    expect(after.runs[0]!.transcriptSource).toBe("file");
    expect(after.runs[0]!.transcriptText).toBe("Hello world");
    // The run's own lifecycle events (not output deltas) are untouched by compaction.
    expect(after.runs[0]!.events.some((e) => e.type === "run_completed")).toBe(true);
  });

  it("delegationTree: reconstructs the parent_task_id tree", () => {
    const { db, mutate, projections } = harness();
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
    const child = createTask(db, mutate, {
      parent_task_id: root.id,
      delegator_actor_id: human,
      assignee_agent_id: agentId,
      spec_md: "child",
      acceptance_criteria_md: "ac",
      budget: ZERO_BUDGET,
    });

    const tree = projections.delegationTree(root.id);
    expect(tree.root?.task.id).toBe(root.id);
    expect(tree.root?.children).toHaveLength(1);
    expect(tree.root?.children[0]!.task.id).toBe(child.id);

    expect(projections.delegationTree("01ARZ3NDEKTSV4RRFFQ69G5FAV" as never).root).toBeUndefined();
  });

  it("inbox: pending approvals and surfaced messages, oldest first", () => {
    const { db, mutate, projections } = harness();
    const human = newActorId();
    const responder = newActorId();
    requestApproval(mutate, { requested_by_actor: human, kind: "budget_increase" });
    const thread = getOrCreateThread(db, mutate, "workstream", "x");
    sendMessage(mutate, {
      thread_id: thread.id,
      from_actor_id: human,
      to_actor_id: responder,
      type: "escalation",
      body_md: "need a decision",
      visibility: "surfaced",
    });

    const items = projections.inbox();
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.kind).sort()).toEqual(["approval_pending", "message_surfaced"]);
    // Oldest first: approval was requested before the message was sent.
    expect(items[0]!.kind).toBe("approval_pending");
  });

  it("costRollup: sums budget spend at workstream/agent/org granularity", () => {
    const { mutate, projections } = harness();
    const team = createTeam(mutate, { name: "Platform", description: "", default_policy: {} });
    const { agentId } = createAgent(mutate, {
      name: "A",
      role: "R",
      team_id: team.id,
      engine_id: "claude-code",
      memory_ref: "m",
      charter_body_md: "#",
    });
    createWorkstream(mutate, { agent_id: agentId, title: "WS1", goal_md: "g", origin: "human", budget: { limit_usd: 10, limit_tokens: null, spent_usd: 2, spent_tokens: 100 } });
    createWorkstream(mutate, { agent_id: agentId, title: "WS2", goal_md: "g", origin: "human", budget: { limit_usd: 5, limit_tokens: null, spent_usd: 3, spent_tokens: 50 } });

    const agentReport = projections.costRollup({ level: "agent", agent_id: agentId });
    expect(agentReport.spent_usd).toBe(5);
    expect(agentReport.spent_tokens).toBe(150);
    expect(agentReport.limit_usd).toBe(15);
    expect(agentReport.breakdown).toHaveLength(2);

    const orgReport = projections.costRollup({ level: "org" });
    expect(orgReport.spent_usd).toBe(5);

    const teamReport = projections.costRollup({ level: "team", team_id: team.id });
    expect(teamReport.spent_usd).toBe(5);
  });
});
