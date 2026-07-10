import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newActorId } from "@foundry/core";
import { createStore } from "./store.js";

const ZERO_BUDGET = { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 };

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("createStore() — assembled Store surface (contracts.md)", () => {
  it("supports a full small-org scenario end to end", async () => {
    dir = mkdtempSync(join(tmpdir(), "foundry-store-e2e-"));
    const store = createStore({ dataDir: dir, dbPath: ":memory:" });
    const human = newActorId();

    const team = store.commands.createTeam({ name: "Platform", description: "infra", default_policy: {} });
    const { agentId, actorId } = store.commands.createAgent({
      name: "Orbit",
      role: "Backend Engineer",
      team_id: team.id,
      engine_id: "claude-code",
      memory_ref: "agents/orbit/memory",
      charter_body_md: "# Orbit",
    });
    store.commands.transitionAgentState({ id: agentId, to: "active", actorId: human });

    const ws = store.commands.createWorkstream({
      agent_id: agentId,
      title: "Bug #482",
      goal_md: "fix it",
      origin: "human",
      budget: ZERO_BUDGET,
    });
    store.commands.transitionWorkstreamState({ id: ws.id, to: "active", actorId: human });

    const run = store.commands.createRun({
      workstream_id: ws.id,
      trigger: "human_message",
      input_context_ref: "runs/1/context.md",
      engine_id: "claude-code",
    });
    store.commands.transitionRunState({ id: run.id, workstreamId: ws.id, to: "starting", actorId: null });
    store.commands.transitionRunState({ id: run.id, workstreamId: ws.id, to: "running", actorId: null });
    store.commands.emitRunDetailEvent({
      entity_id: run.id,
      type: "run_output_delta",
      payload: { text: "working on it..." },
      run_id: run.id,
      workstream_id: ws.id,
      actor_id: null,
    });
    store.commands.transitionRunState({
      id: run.id,
      workstreamId: ws.id,
      to: "completed",
      actorId: null,
      result: { outcome: "completed", final_text: "fixed", artifact_refs: [] },
    });

    const task = store.commands.createTask({
      parent_task_id: null,
      delegator_actor_id: human,
      assignee_agent_id: agentId,
      spec_md: "Fix bug #482",
      acceptance_criteria_md: "Repro no longer occurs",
      budget: ZERO_BUDGET,
    });
    store.commands.transitionTaskState({ id: task.id, to: "in_progress", actorId });
    const artifact = store.commands.putArtifact({ run_id: run.id, kind: "diff", content: "diff --git a b" });
    store.commands.transitionTaskState({
      id: task.id,
      to: "delivered",
      actorId,
      deliverableRef: { message_id: newActorId() as never, artifact_refs: [`artifact:${artifact.id}`] },
    });
    store.commands.transitionTaskState({ id: task.id, to: "done", actorId: human, acceptedBy: human });

    const thread = store.commands.getOrCreateThread("workstream", ws.id);
    const question = store.commands.sendMessage({
      thread_id: thread.id,
      from_actor_id: human,
      to_actor_id: actorId,
      type: "question",
      body_md: "What's the fix?",
    });
    store.commands.resolveMessageDisposition({
      id: question.id,
      messageType: "question",
      to: "answered",
      actorId,
    });

    const approval = store.commands.requestApproval({ requested_by_actor: actorId, kind: "budget_increase" });
    store.commands.decideApproval({ id: approval.id, decision: "granted", decided_by_actor: human });

    // Queries
    expect(store.agents.get(agentId)?.name).toBe("Orbit");
    expect(store.workstreams.get(ws.id)?.state).toBe("active");
    expect(store.tasks.tree(task.id)).toHaveLength(1);
    expect(store.runs.list({ workstream_id: ws.id })).toHaveLength(1);

    // Event feed replay
    const allEvents = store.events.after(0);
    expect(allEvents.length).toBeGreaterThan(5);
    expect(new Set(allEvents.map((e) => e.seq)).size).toBe(allEvents.length); // no dupes

    // Projections
    const org = store.projections.orgView();
    expect(org.teams[0]!.agents[0]!.id).toBe(agentId);
    const page = store.projections.agentPage(agentId);
    expect(page!.openTasks).toHaveLength(0); // task is done, not open
    const timeline = store.projections.workstreamTimeline(ws.id);
    expect(timeline.runs[0]!.transcriptText).toBe("working on it...");
    const inboxItems = store.projections.inbox();
    expect(inboxItems).toEqual([]); // approval decided, no surfaced messages
    const cost = store.projections.costRollup({ level: "org" });
    expect(cost.breakdown).toHaveLength(1);

    // Artifact read-back
    const { content } = store.readArtifact(artifact.id);
    expect(content.toString("utf-8")).toBe("diff --git a b");

    // Backup round-trip smoke test
    const destDir = join(dir, "backup-out");
    const result = await store.backup(destDir);
    expect(result.sizeBytes).toBeGreaterThan(0);

    store.close();
  });
});
