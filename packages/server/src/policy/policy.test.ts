/** E6.3 — policy chain resolution, deterministic routing, delegation checks, F12 cap. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Agent, Policy, PolicyError } from "@foundry/core";
import { DEFAULT_POLICY } from "@foundry/core";
import { createServer, type FoundryServer } from "../server.js";
import { checkDelegation, checkRejection, resolvePolicy, resolveRouting } from "./policy.js";

let server: FoundryServer;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "foundry-policy-"));
  server = createServer({ dataDir: tempDir, dbPath: ":memory:", adapters: {} });
});

afterEach(() => {
  try {
    server.store.close();
  } catch {
    /* closed */
  }
  rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function makeAgent(opts: {
  name: string;
  role?: string;
  teamId?: string | null;
  policy?: Policy;
  state?: "active" | "suspended";
}): Agent {
  const { agentId } = server.store.commands.createAgent({
    name: opts.name,
    role: opts.role ?? "Backend",
    team_id: (opts.teamId ?? null) as never,
    engine_id: "fake",
    engine_config: {},
    memory_ref: "agents/{agent_id}/memory",
    charter_body_md: `# ${opts.name}`,
    policy_overrides: opts.policy,
  });
  server.store.commands.transitionAgentState({ id: agentId, to: "active", actorId: null });
  if (opts.state === "suspended") {
    server.store.commands.transitionAgentState({ id: agentId, to: "suspended", actorId: null });
  }
  return server.store.agents.get(agentId)!;
}

function openWorkstream(agent: Agent): void {
  server.store.commands.createWorkstream({
    agent_id: agent.id,
    title: "W",
    goal_md: "g",
    origin: "human",
    budget: { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 },
  });
}

describe("resolvePolicy — org → team → agent chain", () => {
  it("uses DEFAULT_POLICY when no team and no overrides", () => {
    const agent = makeAgent({ name: "Solo" });
    const p = resolvePolicy(server.store, agent);
    expect(p.max_depth).toBe(3);
    expect(p.max_rejections).toBe(2);
    expect(p.thread_round_cap).toBe(4);
    expect(p.question_expiry_hours).toBe(48);
    expect(p.search_history_scope).toBe("self");
  });

  it("team defaults override org; agent overrides beat team, per-field", () => {
    const team = server.store.commands.createTeam({
      name: "Core",
      description: "",
      default_policy: { max_depth: 2, max_rejections: 1, search_history_scope: "team" },
    });
    const agent = makeAgent({ name: "Layered", teamId: team.id, policy: { max_rejections: 5 } });
    const p = resolvePolicy(server.store, agent);
    expect(p.max_depth).toBe(2); // team wins over org
    expect(p.max_rejections).toBe(5); // agent wins over team
    expect(p.search_history_scope).toBe("team"); // untouched team field survives
    expect(p.thread_round_cap).toBe(4); // untouched org field survives
  });
});

describe("resolveRouting — deterministic team/role → active agent (02)", () => {
  it("matches team + role, prefers fewest open workstreams", () => {
    const team = server.store.commands.createTeam({ name: "T", description: "", default_policy: {} });
    const busy = makeAgent({ name: "Busy", teamId: team.id });
    const idle = makeAgent({ name: "Idle", teamId: team.id });
    openWorkstream(busy);

    const routed = resolveRouting(server.store, { team_id: team.id, role: "Backend" });
    expect((routed as Agent).id).toBe(idle.id);
  });

  it("tie-breaks equal load by lowest agent id", () => {
    const a = makeAgent({ name: "A" });
    const b = makeAgent({ name: "B" });
    const routed = resolveRouting(server.store, { role: "Backend" }) as Agent;
    expect(routed.id).toBe(a.id < b.id ? a.id : b.id);
  });

  it("role-only and team-only specs filter exactly", () => {
    const team = server.store.commands.createTeam({ name: "T", description: "", default_policy: {} });
    makeAgent({ name: "Other", role: "Frontend" });
    const backend = makeAgent({ name: "B", role: "Backend", teamId: team.id });

    expect((resolveRouting(server.store, { role: "Backend" }) as Agent).id).toBe(backend.id);
    expect((resolveRouting(server.store, { team_id: team.id }) as Agent).id).toBe(backend.id);
  });

  it("skips non-active agents and fails when nobody matches", () => {
    makeAgent({ name: "Paused", state: "suspended" });
    const failed = resolveRouting(server.store, { role: "Backend" }) as PolicyError;
    expect(failed.code).toBe("routing_failed");
  });
});

describe("checkDelegation — table of policy error codes", () => {
  it("returns each code for its failing input, first failing check wins", () => {
    const human = server.store.commands.getOrCreateHumanActor();
    const active = makeAgent({ name: "Worker" });
    const suspended = makeAgent({ name: "Paused", state: "suspended" });

    const parentTask = {
      id: "01TASKPARENT0000000000000" as never,
      depth: 0,
      budget: { limit_usd: 10, limit_tokens: null, spent_usd: 0, spent_tokens: 0 },
    };

    const table: Array<{ name: string; args: Parameters<typeof checkDelegation>[0]; code: string | null }> = [
      {
        name: "missing_acceptance_criteria (blank)",
        args: { store: server.store, delegator: human, input: { acceptance_criteria_md: "", assignee_agent_id: active.id } },
        code: "missing_acceptance_criteria",
      },
      {
        name: "missing_acceptance_criteria (whitespace)",
        args: { store: server.store, delegator: human, input: { acceptance_criteria_md: " \n\t ", assignee_agent_id: active.id } },
        code: "missing_acceptance_criteria",
      },
      {
        name: "depth_cap",
        args: {
          store: server.store,
          delegator: human,
          input: { acceptance_criteria_md: "AC", assignee_agent_id: active.id },
          parentTask: { ...parentTask, depth: 3 }, // child depth 4 > default max 3
        },
        code: "depth_cap",
      },
      {
        name: "budget_exceeded",
        args: {
          store: server.store,
          delegator: human,
          input: { acceptance_criteria_md: "AC", assignee_agent_id: active.id, budget: { limit_usd: 11 } },
          parentTask,
        },
        code: "budget_exceeded",
      },
      {
        name: "assignee_not_found",
        args: {
          store: server.store,
          delegator: human,
          input: { acceptance_criteria_md: "AC", assignee_agent_id: "01FAKEAGENT00000000000000" },
        },
        code: "assignee_not_found",
      },
      {
        name: "assignee_not_eligible",
        args: {
          store: server.store,
          delegator: human,
          input: { acceptance_criteria_md: "AC", assignee_agent_id: suspended.id },
        },
        code: "assignee_not_eligible",
      },
      {
        name: "routing_failed",
        args: {
          store: server.store,
          delegator: human,
          input: { acceptance_criteria_md: "AC", routing: { role: "Nonexistent" } },
        },
        code: "routing_failed",
      },
      {
        name: "clean delegation",
        args: {
          store: server.store,
          delegator: human,
          input: { acceptance_criteria_md: "AC", assignee_agent_id: active.id, budget: { limit_usd: 5 } },
          parentTask,
        },
        code: null,
      },
    ];

    for (const row of table) {
      const err = checkDelegation(row.args);
      expect(err?.code ?? null, row.name).toBe(row.code);
    }
  });

  it("budget conservation counts existing non-terminal siblings", () => {
    const human = server.store.commands.getOrCreateHumanActor();
    const worker = makeAgent({ name: "Worker" });

    const parent = server.store.commands.createTask({
      parent_task_id: null,
      delegator_actor_id: human,
      assignee_agent_id: worker.id,
      spec_md: "parent",
      acceptance_criteria_md: "AC",
      budget: { limit_usd: 10, limit_tokens: null, spent_usd: 0, spent_tokens: 0 },
    });
    // Existing open sibling consuming 6 of the parent's 10.
    server.store.commands.createTask({
      parent_task_id: parent.id,
      delegator_actor_id: worker.actor_id,
      assignee_agent_id: worker.id,
      spec_md: "sibling",
      acceptance_criteria_md: "AC",
      budget: { limit_usd: 6, limit_tokens: null, spent_usd: 0, spent_tokens: 0 },
    });

    const base = {
      store: server.store,
      delegator: worker.actor_id,
      parentTask: { id: parent.id, depth: parent.depth, budget: parent.budget },
    };
    // 5 + 6 > 10 → exceeded; 4 + 6 ≤ 10 → fine.
    expect(
      checkDelegation({ ...base, input: { acceptance_criteria_md: "AC", assignee_agent_id: worker.id, budget: { limit_usd: 5 } } })
        ?.code
    ).toBe("budget_exceeded");
    expect(
      checkDelegation({ ...base, input: { acceptance_criteria_md: "AC", assignee_agent_id: worker.id, budget: { limit_usd: 4 } } })
    ).toBeNull();
  });

  it("null budget axes are uncapped — no budget error", () => {
    const human = server.store.commands.getOrCreateHumanActor();
    const worker = makeAgent({ name: "Worker" });
    const err = checkDelegation({
      store: server.store,
      delegator: human,
      input: { acceptance_criteria_md: "AC", assignee_agent_id: worker.id, budget: { limit_usd: 999 } },
      parentTask: {
        id: "01TASKPARENT0000000000000" as never,
        depth: 0,
        budget: { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 },
      },
    });
    expect(err).toBeNull();
  });
});

describe("checkRejection — F12 rejected-work loop", () => {
  it("null under the cap, max_rejections_exceeded at and above it", () => {
    const agent = makeAgent({ name: "Worker" }); // default max_rejections = 2
    const policy = resolvePolicy(server.store, agent);
    expect(checkRejection({ rejection_count: 1 }, policy)).toBeNull();
    expect(checkRejection({ rejection_count: 2 }, policy)?.code).toBe("max_rejections_exceeded");
    expect(checkRejection({ rejection_count: 3 }, policy)?.code).toBe("max_rejections_exceeded");
  });
});

describe("budget conservation + depth cap property test — E8.2", () => {
  it("random delegation trees preserve budget invariant at every node and respect depth cap", () => {
    const human = server.store.commands.getOrCreateHumanActor();
    const workers = Array.from({ length: 3 }, (_, i) => makeAgent({ name: `Worker-${i}` }));

    // Run 30 random trees
    for (let treeIdx = 0; treeIdx < 30; treeIdx++) {
      const createdTasks: Array<{ id: string; depth: number; budget: any; children: any[] }> = [];

      // Generate a tree: start with a root delegated by human, then recursively delegate down
      function generateAndCreateTree(
        delegatorActorId: string,
        depth: number,
        maxDepth: number,
        parentBudget: { limit_usd: number | null; limit_tokens: number | null } | null,
        parentTaskId: string | null
      ): { id: string; depth: number; budget: any; children: any[] } | null {
        // Stop at depth cap or randomly stop branching
        if (depth > maxDepth || Math.random() < 0.4) {
          return null;
        }

        const branchFactor = Math.floor(Math.random() * 4) + 1; // 1-4 children
        const children: any[] = [];
        const allChildBudgets: { usd: number; tokens: number }[] = [];

        // Attempt to create children, respecting budget conservation
        for (let i = 0; i < branchFactor; i++) {
          const workerIdx = Math.floor(Math.random() * workers.length);
          const assignee = workers[workerIdx]!;

          // Random budget: sometimes null (uncapped), sometimes a number
          let childLimitUsd: number | null = null;
          let childLimitTokens: number | null = null;

          if (parentBudget) {
            // Sometimes this child has a budget, sometimes not
            if (parentBudget.limit_usd !== null && Math.random() > 0.3) {
              // Random amount, but not necessarily respecting conservation yet
              childLimitUsd = Math.floor(Math.random() * (parentBudget.limit_usd + 5));
            }
            if (parentBudget.limit_tokens !== null && Math.random() > 0.3) {
              childLimitTokens = Math.floor(Math.random() * (parentBudget.limit_tokens + 1000));
            }
          }

          const childBudget = { limit_usd: childLimitUsd, limit_tokens: childLimitTokens, spent_usd: 0, spent_tokens: 0 };

          // Check policy before creating the task
          const policyErr = checkDelegation({
            store: server.store,
            delegator: delegatorActorId,
            input: {
              acceptance_criteria_md: `Child ${depth}-${i}`,
              budget: childBudget,
              assignee_agent_id: assignee.id,
            },
            parentTask: parentTaskId
              ? { id: parentTaskId as never, depth, budget: parentBudget! }
              : undefined,
          });

          // Only create the task if policy check passes
          if (!policyErr) {
            const task = server.store.commands.createTask({
              parent_task_id: parentTaskId ? (parentTaskId as never) : null,
              delegator_actor_id: delegatorActorId as never,
              assignee_agent_id: assignee.id as never,
              spec_md: `Spec for child ${depth}-${i}`,
              acceptance_criteria_md: `Child ${depth}-${i}`,
              budget: childBudget,
            });

            allChildBudgets.push({
              usd: childLimitUsd ?? 0,
              tokens: childLimitTokens ?? 0,
            });

            // Recurse down
            const grandchild = generateAndCreateTree(
              assignee.actor_id,
              depth + 1,
              maxDepth,
              childBudget,
              task.id
            );
            children.push({ task, grandchild });
            createdTasks.push({
              id: task.id,
              depth: task.depth,
              budget: task.budget,
              children: grandchild ? [grandchild] : [],
            });
          }
        }

        return parentTaskId
          ? { id: parentTaskId, depth, budget: parentBudget, children }
          : null;
      }

      // Start the tree at depth 0 with a root task from human
      const rootBudget = {
        limit_usd: Math.random() > 0.5 ? Math.floor(Math.random() * 1000) + 10 : null,
        limit_tokens: Math.random() > 0.5 ? Math.floor(Math.random() * 100000) + 1000 : null,
        spent_usd: 0,
        spent_tokens: 0,
      };

      const root = server.store.commands.createTask({
        parent_task_id: null,
        delegator_actor_id: human as never,
        assignee_agent_id: workers[0]!.id as never,
        spec_md: "Root spec",
        acceptance_criteria_md: "Root AC",
        budget: rootBudget,
      });

      createdTasks.push({
        id: root.id,
        depth: root.depth,
        budget: root.budget,
        children: [],
      });

      // Recursively build children from the root
      generateAndCreateTree(
        workers[0]!.actor_id,
        1,
        DEFAULT_POLICY.max_depth,
        { limit_usd: rootBudget.limit_usd, limit_tokens: rootBudget.limit_tokens },
        root.id
      );

      // Verify invariants on all created tasks
      for (const taskRecord of createdTasks) {
        const task = server.store.tasks.get(taskRecord.id as never);
        if (!task) continue;

        // 1. Depth never exceeds max_depth
        expect(task.depth).toBeLessThanOrEqual(DEFAULT_POLICY.max_depth);

        // 2. If this task has a parent, check budget conservation
        if (task.parent_task_id) {
          const parent = server.store.tasks.get(task.parent_task_id as never);
          if (!parent) continue;

          // Get all non-terminal siblings (including this task in its current non-terminal state)
          const siblings = server.store.tasks
            .list()
            .filter(
              (t) =>
                t.parent_task_id === parent.id &&
                ["pending", "in_progress", "blocked", "delivered", "rejected"].includes(t.state)
            );

          // Check each budget axis
          for (const axis of ["limit_usd", "limit_tokens"] as const) {
            const parentLimit = parent.budget[axis];
            const childLimit = task.budget[axis];

            // Only check if both parent and child have non-null limits on this axis
            if (parentLimit !== null && childLimit !== null) {
              const siblingSum = siblings
                .filter((s) => s.id !== task.id)
                .reduce((sum, s) => sum + (s.budget[axis] ?? 0), 0);

              const totalChildBudget = childLimit + siblingSum;
              expect(totalChildBudget, `Task ${task.id} axis ${axis}: child ${childLimit} + siblings ${siblingSum} exceeds parent ${parentLimit}`)
                .toBeLessThanOrEqual(parentLimit);
            }
          }
        }
      }
    }
  });
});
