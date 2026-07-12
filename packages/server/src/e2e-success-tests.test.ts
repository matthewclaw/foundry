/** E12.1 doc-01 success test gaps + E12.3 multi-level org scenario. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  tempDir = mkdtempSync(join(tmpdir(), "foundry-success-"));
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

  // Register two adapters (engine-a, engine-b) — both backed by the same fake for Gap B.
  server = createServer({
    dataDir: tempDir,
    dbPath: ":memory:",
    adapters: {
      "engine-a": capturing,
      "engine-b": createFakeAdapter(loadScenario("happy-path")),
    },
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

function bootstrapAgent(name: string, teamId?: string) {
  const { agentId } = server.store.commands.createAgent({
    name,
    role: "Backend",
    team_id: teamId ?? null,
    engine_id: "engine-a",
    engine_config: { scenarioName: "happy-path" },
    memory_ref: `agents/{agent_id}/memory`,
    charter_body_md: `# ${name}`,
  });
  server.store.commands.transitionAgentState({ id: agentId, to: "active", actorId: null });
  return agentId;
}

async function idle(): Promise<void> {
  while (server.runtime.pendingCount() > 0 || server.runtime.activeCount() > 0) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

function mintTokenForTaskRun(task: { id: string }, agentId: string) {
  const agent = server.store.agents.get(agentId as never)!;
  const ws = server.store.commands.createWorkstream({
    agent_id: agent.id,
    title: "sub",
    goal_md: "g",
    origin: `task:${task.id}` as never,
    task_id: task.id as never,
    budget: { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 },
  });
  const run = server.store.commands.createRun({
    workstream_id: ws.id,
    trigger: "human_message",
    input_context_ref: "runs/{run_id}/context.md",
    engine_id: "engine-a",
  });
  const token = server.tokens.mint({ runId: run.id, agentId: agent.id, actorId: agent.actor_id });
  return { token, ws, run, agent };
}

describe("E12.1 — doc-01 success test gaps", () => {
  describe("Gap A: 200 agents, org view load time and zero spend", () => {
    it("creates 200 agents across teams, org view loads fast, all have zero spend", () => {
      // Create 3 teams
      const team1 = server.store.commands.createTeam({ name: "Team 1", description: "team 1", default_policy: {} });
      const team2 = server.store.commands.createTeam({ name: "Team 2", description: "team 2", default_policy: {} });
      const team3 = server.store.commands.createTeam({ name: "Team 3", description: "team 3", default_policy: {} });

      // Create 200 agents: mix across teams + some unassigned
      // 70 + 70 + 50 across teams, 10 unassigned
      const agentIds: string[] = [];
      for (let i = 0; i < 70; i++) agentIds.push(bootstrapAgent(`Team1Agent${i}`, team1.id));
      for (let i = 0; i < 70; i++) agentIds.push(bootstrapAgent(`Team2Agent${i}`, team2.id));
      for (let i = 0; i < 50; i++) agentIds.push(bootstrapAgent(`Team3Agent${i}`, team3.id));
      for (let i = 0; i < 10; i++) agentIds.push(bootstrapAgent(`UnassignedAgent${i}`));

      expect(agentIds).toHaveLength(200);

      // Org view should load in reasonable time (under 1 second)
      const start = Date.now();
      const view = server.store.projections.orgView();
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1000);

      // All agents appear exactly once under the right team
      const teamAgents = new Map<string, number>();
      const unassignedCount = view.unassignedAgents.length;
      for (const team of view.teams) {
        teamAgents.set(team.id, team.agents.length);
      }
      expect(teamAgents.get(team1.id)).toBe(70);
      expect(teamAgents.get(team2.id)).toBe(70);
      expect(teamAgents.get(team3.id)).toBe(50);
      expect(unassignedCount).toBe(10);

      // All agents have zero spend (no runs ever executed)
      for (const team of view.teams) {
        for (const agent of team.agents) {
          expect(agent.id).toBeDefined();
        }
      }
      for (const agent of view.unassignedAgents) {
        expect(agent.id).toBeDefined();
      }

      // Verify cost rollup reflects zero spend at org level
      const costReport = server.store.projections.costRollup({ level: "org" });
      expect(costReport.spent_usd).toBe(0);
      expect(costReport.spent_tokens).toBe(0);
    });
  });

  describe("Gap B: Engine swap preserves identity, memory, history, workstreams", () => {
    it("swaps engine from engine-a to engine-b, verifies all else unchanged", async () => {
      const agentId = bootstrapAgent("Swappable");
      const agent = server.store.agents.get(agentId as never)!;

      // Write a memory file (matching git.test.ts pattern: direct file write)
      const memPath = join(tempDir, agent.memory_ref);
      const nodeFs = await import("node:fs");
      nodeFs.mkdirSync(memPath, { recursive: true });
      writeFileSync(join(memPath, "INDEX.md"), "- [x](fact.md) — initial knowledge", "utf8");

      // Create a real run to establish history
      const ws = server.store.commands.createWorkstream({
        agent_id: agentId,
        title: "History Builder",
        goal_md: "build history",
        origin: "human",
        budget: { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 },
      });
      server.runtime.enqueue({ workstreamId: ws.id, trigger: "human_message" });
      await idle();

      // Get baseline state before swap
      const beforeSwap = server.store.agents.get(agentId as never)!;
      const beforeId = beforeSwap.id;
      const beforeName = beforeSwap.name;
      const beforeRole = beforeSwap.role;
      const beforeActorId = beforeSwap.actor_id;
      const beforeMemoryRef = beforeSwap.memory_ref;

      // List open workstreams before swap
      const wsBeforeSwap = server.store.workstreams.list({ agent_id: agentId as never });
      expect(wsBeforeSwap.length).toBeGreaterThan(0);

      // Read history before swap (at least one run should exist)
      const runsBeforeSwap = server.store.runs.list({ agent_id: agentId as never });
      expect(runsBeforeSwap.length).toBeGreaterThan(0);

      // Perform the swap
      server.store.commands.rebindAgentEngine({
        agentId: agentId as never,
        engine: { id: "engine-b", config: { scenarioName: "happy-path" } },
        actorId: null,
      });

      // Verify unchanged fields
      const afterSwap = server.store.agents.get(agentId as never)!;
      expect(afterSwap.id).toBe(beforeId);
      expect(afterSwap.name).toBe(beforeName);
      expect(afterSwap.role).toBe(beforeRole);
      expect(afterSwap.actor_id).toBe(beforeActorId);
      expect(afterSwap.memory_ref).toBe(beforeMemoryRef);

      // Verify engine changed (stored as engine.id, not engine_id)
      expect(afterSwap.engine.id).toBe("engine-b");

      // Memory file still exists with same content
      const memContent = await import("node:fs/promises").then((fs) => fs.readFile(join(memPath, "INDEX.md"), "utf8"));
      expect(memContent).toBe("- [x](fact.md) — initial knowledge");

      // Workstreams still exist
      const wsAfterSwap = server.store.workstreams.list({ agent_id: agentId as never });
      expect(wsAfterSwap.length).toBe(wsBeforeSwap.length);

      // History (runs) still exist
      const runsAfterSwap = server.store.runs.list({ agent_id: agentId as never });
      expect(runsAfterSwap.length).toBe(runsBeforeSwap.length);
    });
  });

  describe("Gap C: 3-level escalation appears in inbox with full chain", () => {
    it("builds 3-level delegation, escalates from deepest, verifies inbox and full chain", async () => {
      // Create agents for 3-level chain
      const agent1Id = bootstrapAgent("Level1");
      const agent2Id = bootstrapAgent("Level2");
      const agent3Id = bootstrapAgent("Level3");
      const human = server.store.commands.getOrCreateHumanActor();

      // Root task: human → agent1
      const rootTask = server.store.commands.createTask({
        parent_task_id: null,
        delegator_actor_id: human,
        assignee_agent_id: agent1Id as never,
        spec_md: "root work",
        acceptance_criteria_md: "AC",
        budget: { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 },
      });

      // Agent1 → Agent2 (via HTTP delegate_task). rootTask was created directly (a
      // human-delegated root), so agent1's token must be bound to a real task-bound
      // run (mintTokenForTaskRun) — a synthetic runId leaves callerParentTask()
      // resolving to null, so this delegation would never link to rootTask.id.
      const { token: agent1Token } = mintTokenForTaskRun(rootTask, agent1Id);

      const delegateRes1 = await server.app.inject({
        method: "POST",
        url: "/api/org-tools/delegate_task",
        headers: { authorization: `Bearer ${agent1Token}` },
        payload: { title: "Level 2 work", spec_md: "sub", acceptance_criteria_md: "AC", assignee_agent_id: agent2Id },
      });
      const task1Id = JSON.parse(delegateRes1.body).data.task_id;
      await idle();

      // Agent2 → Agent3 (via HTTP delegate_task, need real workstream/run for task context)
      const agent2Ws = server.store.workstreams
        .list({ agent_id: agent2Id as never })
        .find((ws) => ws.task_id === task1Id)!;
      const agent2Run = server.store.runs.list({ workstream_id: agent2Ws.id })[0]!;
      const agent2Token = server.tokens.mint({
        runId: agent2Run.id,
        agentId: server.store.agents.get(agent2Id as never)!.id,
        actorId: server.store.agents.get(agent2Id as never)!.actor_id,
      });

      const delegateRes2 = await server.app.inject({
        method: "POST",
        url: "/api/org-tools/delegate_task",
        headers: { authorization: `Bearer ${agent2Token}` },
        payload: { title: "Level 3 work", spec_md: "deep", acceptance_criteria_md: "AC", assignee_agent_id: agent3Id },
      });
      const task2Id = JSON.parse(delegateRes2.body).data.task_id;
      await idle();

      // Agent3 escalates
      const agent3Ws = server.store.workstreams
        .list({ agent_id: agent3Id as never })
        .find((ws) => ws.task_id === task2Id)!;
      const agent3Run = server.store.runs.list({ workstream_id: agent3Ws.id })[0]!;
      const agent3Token = server.tokens.mint({
        runId: agent3Run.id,
        agentId: server.store.agents.get(agent3Id as never)!.id,
        actorId: server.store.agents.get(agent3Id as never)!.actor_id,
      });

      const escalateRes = await server.app.inject({
        method: "POST",
        url: "/api/org-tools/escalate",
        headers: { authorization: `Bearer ${agent3Token}` },
        payload: { severity: "decision_needed", body_md: "Need decision at 3 levels deep", refs: [] },
      });
      const escalateBody = JSON.parse(escalateRes.body);
      expect(escalateBody).toMatchObject({ ok: true });

      // Escalation appears in inbox (message_surfaced type)
      const inbox = server.store.projections.inbox();
      const escalationItem = inbox.find((item) => item.kind === "message_surfaced");
      expect(escalationItem).toBeDefined();
      expect(escalationItem!.summary).toContain("escalation");

      // Verify full chain is walkable via parent_task_id
      const task2Full = server.store.tasks.get(task2Id)!;
      expect(task2Full.parent_task_id).toBe(task1Id);
      const task1Full = server.store.tasks.get(task1Id)!;
      expect(task1Full.parent_task_id).toBe(rootTask.id);
      const rootTaskFull = server.store.tasks.get(rootTask.id)!;
      expect(rootTaskFull.parent_task_id).toBeNull();
    });
  });
});

describe("E12.3 — multi-level org scenario (3 teams, 8 agents, 3-level delegation)", () => {
  it("delegates root → L1 → L2 → L3, delivers cascade back up, verifies tree and cost", async () => {
    // Setup: 3 teams, 8 agents (3/3/2)
    const t1 = server.store.commands.createTeam({ name: "Frontend", description: "Frontend team", default_policy: {} });
    const t2 = server.store.commands.createTeam({ name: "Backend", description: "Backend team", default_policy: {} });
    const t3 = server.store.commands.createTeam({ name: "Devops", description: "DevOps team", default_policy: {} });

    // Team 1: 3 agents (L1, helper, helper)
    const l1Id = bootstrapAgent("L1_Frontend", t1.id);
    bootstrapAgent("FE_Helper1", t1.id);
    bootstrapAgent("FE_Helper2", t1.id);

    // Team 2: 3 agents (L2, helper, helper)
    const l2Id = bootstrapAgent("L2_Backend", t2.id);
    bootstrapAgent("BE_Helper1", t2.id);
    bootstrapAgent("BE_Helper2", t2.id);

    // Team 3: 2 agents (L3, helper)
    const l3Id = bootstrapAgent("L3_Devops", t3.id);
    bootstrapAgent("DO_Helper1", t3.id);

    const human = server.store.commands.getOrCreateHumanActor();

    // Root task: human delegates to L1
    const rootTask = server.store.commands.createTask({
      parent_task_id: null,
      delegator_actor_id: human,
      assignee_agent_id: l1Id as never,
      spec_md: "Build and deploy feature X",
      acceptance_criteria_md: "Feature works end-to-end",
      budget: { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 },
    });
    // delegate_task's handler normally transitions pending -> in_progress the moment it
    // spawns the assignee's run; rootTask bypassed that (created directly, not via
    // delegate_task), so it needs the same transition before it can ever be delivered.
    server.store.commands.transitionTaskState({
      id: rootTask.id,
      to: "in_progress",
      actorId: server.store.agents.get(l1Id as never)!.actor_id,
    });

    // L1 delegates to L2. rootTask was created directly via store.commands.createTask
    // (a human-delegated root, not via delegate_task), so no workstream was
    // auto-spawned for L1 tied to rootTask.id the way delegate_task normally does —
    // mint L1's token against a real task-bound run (mintTokenForTaskRun), not a
    // synthetic runId, so this delegation's parent_task_id actually links to rootTask
    // and the later delivery cascade has a real workstream to re-trigger.
    const l1Agent = server.store.agents.get(l1Id as never)!;
    const { token: l1Token } = mintTokenForTaskRun(rootTask, l1Id);

    const delegateL2Res = await server.app.inject({
      method: "POST",
      url: "/api/org-tools/delegate_task",
      headers: { authorization: `Bearer ${l1Token}` },
      payload: { title: "Backend implementation", spec_md: "impl", acceptance_criteria_md: "AC", assignee_agent_id: l2Id },
    });
    const task_l1_to_l2 = JSON.parse(delegateL2Res.body).data.task_id;
    await idle();

    // L2 delegates to L3
    const l2Ws = server.store.workstreams
      .list({ agent_id: l2Id as never })
      .find((ws) => ws.task_id === task_l1_to_l2)!;
    const l2Run = server.store.runs.list({ workstream_id: l2Ws.id })[0]!;
    const l2Agent = server.store.agents.get(l2Id as never)!;
    const l2Token = server.tokens.mint({
      runId: l2Run.id,
      agentId: l2Agent.id,
      actorId: l2Agent.actor_id,
    });

    const delegateL3Res = await server.app.inject({
      method: "POST",
      url: "/api/org-tools/delegate_task",
      headers: { authorization: `Bearer ${l2Token}` },
      payload: { title: "Deployment", spec_md: "deploy", acceptance_criteria_md: "AC", assignee_agent_id: l3Id },
    });
    const task_l2_to_l3 = JSON.parse(delegateL3Res.body).data.task_id;
    await idle();

    // L3 delivers the work
    const l3Ws = server.store.workstreams
      .list({ agent_id: l3Id as never })
      .find((ws) => ws.task_id === task_l2_to_l3)!;
    const l3Run = server.store.runs.list({ workstream_id: l3Ws.id })[0]!;
    const l3Agent = server.store.agents.get(l3Id as never)!;
    const l3Token = server.tokens.mint({
      runId: l3Run.id,
      agentId: l3Agent.id,
      actorId: l3Agent.actor_id,
    });

    await server.app.inject({
      method: "POST",
      url: "/api/org-tools/deliver_task",
      headers: { authorization: `Bearer ${l3Token}` },
      payload: { task_id: task_l2_to_l3, summary_md: "Deployed", artifact_refs: [] },
    });
    await idle();

    // L2 accepts L3's delivery
    const l2AcceptRes = await server.app.inject({
      method: "POST",
      url: "/api/org-tools/accept_task",
      headers: { authorization: `Bearer ${l2Token}` },
      payload: { task_id: task_l2_to_l3 },
    });
    expect(JSON.parse(l2AcceptRes.body)).toMatchObject({ ok: true });
    expect(server.store.tasks.get(task_l2_to_l3)!.state).toBe("done");
    await idle();

    // Now that L2's own sub-delegation is accepted, L2 delivers its own assigned task
    // (task_l1_to_l2) back up to L1 — the delivery cascade doesn't happen automatically
    // just because a child task was accepted; L2 must explicitly deliver_task.
    const l2DeliverRes = await server.app.inject({
      method: "POST",
      url: "/api/org-tools/deliver_task",
      headers: { authorization: `Bearer ${l2Token}` },
      payload: { task_id: task_l1_to_l2, summary_md: "Backend + deployment complete", artifact_refs: [] },
    });
    expect(JSON.parse(l2DeliverRes.body)).toMatchObject({ ok: true });
    expect(server.store.tasks.get(task_l1_to_l2)!.state).toBe("delivered");
    await idle();

    // L1 accepts L2's delivery (via re-triggered run and fresh token)
    const l1ResWs = server.store.workstreams
      .list({ agent_id: l1Id as never })
      .filter((ws) => ws.task_id === rootTask.id && ws.state !== "closed");
    expect(l1ResWs.length).toBeGreaterThan(0);
    const l1ResRun = server.store.runs.list({ workstream_id: l1ResWs[0]!.id })[0];
    expect(l1ResRun).toBeDefined();

    const l1FreshToken = server.tokens.mint({
      runId: l1ResRun!.id,
      agentId: l1Agent.id,
      actorId: l1Agent.actor_id,
    });

    const l1AcceptRes = await server.app.inject({
      method: "POST",
      url: "/api/org-tools/accept_task",
      headers: { authorization: `Bearer ${l1FreshToken}` },
      payload: { task_id: task_l1_to_l2 },
    });
    expect(JSON.parse(l1AcceptRes.body)).toMatchObject({ ok: true });
    expect(server.store.tasks.get(task_l1_to_l2)!.state).toBe("done");
    await idle();

    // L1 delivers the root task back up to the human before it can be accepted.
    const l1DeliverRootRes = await server.app.inject({
      method: "POST",
      url: "/api/org-tools/deliver_task",
      headers: { authorization: `Bearer ${l1FreshToken}` },
      payload: { task_id: rootTask.id, summary_md: "Feature built and deployed end to end", artifact_refs: [] },
    });
    expect(JSON.parse(l1DeliverRootRes.body)).toMatchObject({ ok: true });
    expect(server.store.tasks.get(rootTask.id)!.state).toBe("delivered");

    // Human accepts root task
    const humanAcceptRes = await server.app.inject({
      method: "POST",
      url: "/api/tasks/" + rootTask.id + "/accept",
      payload: {},
    });
    expect(humanAcceptRes.statusCode).toBe(200);
    expect(server.store.tasks.get(rootTask.id)!.state).toBe("done");

    // Verify delegation tree: 3 nodes, single chain, all done
    const tree = server.store.projections.delegationTree(rootTask.id as never);
    expect(tree.root).toBeDefined();

    // Walk the tree to count nodes and verify depths
    const walkTree = (node: any): number => {
      expect(node.task.state).toBe("done");
      if (node.children.length === 0) return 1;
      expect(node.children.length).toBe(1); // Single chain, not a tree
      return 1 + walkTree(node.children[0]);
    };
    const nodeCount = walkTree(tree.root!);
    expect(nodeCount).toBe(3); // Root + 2 delegations

    // Verify depths increment
    expect(tree.root!.task.depth).toBe(0);
    expect(tree.root!.children[0]!.task.depth).toBe(1);
    expect(tree.root!.children[0]!.children[0]!.task.depth).toBe(2);

    // Verify cost rollup includes workstreams created for this scenario
    // (exact spend is 0 per OPEN_ISSUES #39, but workstream structure should reflect 3 task-bound WS)
    const costOrg = server.store.projections.costRollup({ level: "org" });
    expect(costOrg.breakdown.length).toBeGreaterThan(0); // At least the workstreams

    // Team cost rollups
    const costT1 = server.store.projections.costRollup({ level: "team", team_id: t1.id });
    const costT2 = server.store.projections.costRollup({ level: "team", team_id: t2.id });
    const costT3 = server.store.projections.costRollup({ level: "team", team_id: t3.id });

    // Each team should have at least their agent's workstreams visible
    expect(costT1.breakdown.length).toBeGreaterThan(0); // L1's workstreams
    expect(costT2.breakdown.length).toBeGreaterThan(0); // L2's workstreams
    expect(costT3.breakdown.length).toBeGreaterThan(0); // L3's workstreams
  });
});
