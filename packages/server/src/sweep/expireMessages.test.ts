/** E8.3 — Question expiry sweep tests. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeAdapter, loadScenario } from "@foundry/adapter-fake";
import { createServer, type FoundryServer } from "../server.js";
import { sweepExpiredQuestions } from "./expireMessages.js";

let server: FoundryServer;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "foundry-sweep-"));
  server = createServer({
    dataDir: tempDir,
    dbPath: ":memory:",
    adapters: { fake: createFakeAdapter(loadScenario("happy-path")) },
    questionExpiryIntervalMs: 100, // Short interval for tests
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

describe("sweepExpiredQuestions", () => {
  it("expires an open question older than question_expiry_hours", async () => {
    const asker = bootstrapAgent("Asker");
    const thread = server.store.commands.getOrCreateThread("workstream", "test-ws");

    // Send a question 50 hours ago (expiry is default 48 hours)
    const oldDate = new Date(Date.now() - 50 * 60 * 60 * 1000).toISOString();
    const question = server.store.commands.sendMessage({
      thread_id: thread.id,
      from_actor_id: asker.actor_id,
      to_actor_id: null,
      type: "question",
      body_md: "Is this expired?",
      refs: [],
      visibility: "normal",
    });

    // Manually backdate the message to 50 hours ago
    server.store.db.prepare(`UPDATE messages SET created_at = ? WHERE id = ?`).run(oldDate, question.id);

    // Run sweep with current time
    const now = new Date();
    sweepExpiredQuestions({ store: server.store, now });

    // Question should be expired
    const expired = server.store.messages.get(question.id)!;
    expect(expired.disposition).toBe("expired");
  });

  it("does not expire a question less than question_expiry_hours old", async () => {
    const asker = bootstrapAgent("Asker2");
    const thread = server.store.commands.getOrCreateThread("workstream", "test-ws2");

    // Send a question 47 hours ago (expiry is default 48 hours)
    const recentDate = new Date(Date.now() - 47 * 60 * 60 * 1000).toISOString();
    const question = server.store.commands.sendMessage({
      thread_id: thread.id,
      from_actor_id: asker.actor_id,
      to_actor_id: null,
      type: "question",
      body_md: "Is this still open?",
      refs: [],
      visibility: "normal",
    });

    // Manually backdate
    server.store.db.prepare(`UPDATE messages SET created_at = ? WHERE id = ?`).run(recentDate, question.id);

    // Run sweep
    const now = new Date();
    sweepExpiredQuestions({ store: server.store, now });

    // Question should still be open
    const msg = server.store.messages.get(question.id)!;
    expect(msg.disposition).toBe("open");
  });

  it("does not expire an already-answered question", async () => {
    const asker = bootstrapAgent("Asker3");
    const thread = server.store.commands.getOrCreateThread("workstream", "test-ws3");

    // Send a question 50 hours ago
    const oldDate = new Date(Date.now() - 50 * 60 * 60 * 1000).toISOString();
    const question = server.store.commands.sendMessage({
      thread_id: thread.id,
      from_actor_id: asker.actor_id,
      to_actor_id: null,
      type: "question",
      body_md: "Already answered?",
      refs: [],
      visibility: "normal",
    });

    // Backdate
    server.store.db.prepare(`UPDATE messages SET created_at = ? WHERE id = ?`).run(oldDate, question.id);

    // Answer the question
    server.store.commands.resolveMessageDisposition({
      id: question.id,
      messageType: "question",
      to: "answered",
      actorId: asker.actor_id,
    });

    // Run sweep
    const now = new Date();
    sweepExpiredQuestions({ store: server.store, now });

    // Question should remain answered (not become expired)
    const msg = server.store.messages.get(question.id)!;
    expect(msg.disposition).toBe("answered");
  });

  it("skips questions asked by the human (no expiry policy)", async () => {
    const human = server.store.commands.getOrCreateHumanActor();
    const thread = server.store.commands.getOrCreateThread("workstream", "human-ws");

    // Send a question from human 50 hours ago
    const oldDate = new Date(Date.now() - 50 * 60 * 60 * 1000).toISOString();
    const question = server.store.commands.sendMessage({
      thread_id: thread.id,
      from_actor_id: human,
      to_actor_id: null,
      type: "question",
      body_md: "Human question, no expiry",
      refs: [],
      visibility: "normal",
    });

    // Backdate
    server.store.db.prepare(`UPDATE messages SET created_at = ? WHERE id = ?`).run(oldDate, question.id);

    // Run sweep
    const now = new Date();
    sweepExpiredQuestions({ store: server.store, now });

    // Question should still be open (human questions don't expire)
    const msg = server.store.messages.get(question.id)!;
    expect(msg.disposition).toBe("open");
  });

  it("produces a surfaced escalation message when questions expire", async () => {
    const asker = bootstrapAgent("Asker4");
    const thread = server.store.commands.getOrCreateThread("workstream", "expiry-test");

    const oldDate = new Date(Date.now() - 50 * 60 * 60 * 1000).toISOString();
    const question = server.store.commands.sendMessage({
      thread_id: thread.id,
      from_actor_id: asker.actor_id,
      to_actor_id: null,
      type: "question",
      body_md: "Question to be expired",
      refs: [],
      visibility: "normal",
    });

    server.store.db.prepare(`UPDATE messages SET created_at = ? WHERE id = ?`).run(oldDate, question.id);

    const human = server.store.commands.getOrCreateHumanActor();
    const messagesBefore = server.store.messages.listOpenForActor(human);

    sweepExpiredQuestions({ store: server.store, now: new Date() });

    const messagesAfter = server.store.messages.listOpenForActor(human);
    const newMessages = messagesAfter.filter(
      (m) => !messagesBefore.find((before) => before.id === m.id)
    );

    expect(newMessages.length).toBeGreaterThan(0);
    const escalation = newMessages.find((m) => m.type === "escalation");
    expect(escalation).toBeDefined();
    expect(escalation!.visibility).toBe("surfaced");
  });
});
