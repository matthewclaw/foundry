import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newActorId } from "@foundry/core";
import { openDb } from "../db/connection.js";
import { createEventBus } from "./bus.js";
import { createMutate } from "../mutate.js";
import { createAgent } from "../mutations/agents.js";
import { createWorkstream } from "../mutations/workstreams.js";
import { createRun, emitRunDetailEvent } from "../mutations/runs.js";
import { createEventFeed, transcriptPath } from "./feed.js";

const ZERO_BUDGET = { limit_usd: null, limit_tokens: null, spent_usd: 0, spent_tokens: 0 };

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function harness() {
  dir = mkdtempSync(join(tmpdir(), "foundry-feed-"));
  const db = openDb(":memory:");
  const bus = createEventBus();
  const mutate = createMutate(db, bus);
  const feed = createEventFeed(db, bus, mutate, dir);
  return { db, mutate, feed, dataDir: dir };
}

describe("E2.4 event feed", () => {
  it("after(seq) replays only events after the given seq, in order", () => {
    const { mutate, feed } = harness();
    const actor = newActorId();
    for (let i = 0; i < 5; i++) {
      mutate({
        apply: () => undefined,
        events: [{ actor_id: actor, entity_type: "actor", entity_id: actor, type: "actor_created", payload: {} }],
      });
    }
    const all = feed.after(0);
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(feed.after(3).map((e) => e.seq)).toEqual([4, 5]);
    expect(feed.after(5)).toEqual([]);
  });

  it("filters by workstream_id", () => {
    const { mutate, feed } = harness();
    const { agentId } = createAgent(mutate, {
      name: "A",
      role: "R",
      team_id: null,
      engine_id: "claude-code",
      memory_ref: "m",
      charter_body_md: "#",
    });
    const ws1 = createWorkstream(mutate, { agent_id: agentId, title: "T1", goal_md: "g", origin: "human", budget: ZERO_BUDGET });
    const ws2 = createWorkstream(mutate, { agent_id: agentId, title: "T2", goal_md: "g", origin: "human", budget: ZERO_BUDGET });

    const events = feed.after(0, { workstream_id: ws1.id, entity_type: "workstream" });
    expect(events).toHaveLength(1);
    expect(events[0]!.entity_id).toBe(ws1.id);
    void ws2;
  });

  it("replay-after-reconnect: subscribe, disconnect, more events happen, after(seq) replay has no gaps and no dupes", () => {
    const { mutate, feed } = harness();
    const actor = newActorId();
    const received: number[] = [];
    const unsubscribe = feed.subscribe((e) => received.push(e.seq));

    for (let i = 0; i < 3; i++) {
      mutate({
        apply: () => undefined,
        events: [{ actor_id: actor, entity_type: "actor", entity_id: actor, type: "actor_created", payload: {} }],
      });
    }
    expect(received).toEqual([1, 2, 3]);

    unsubscribe(); // simulate disconnect
    for (let i = 0; i < 3; i++) {
      mutate({
        apply: () => undefined,
        events: [{ actor_id: actor, entity_type: "actor", entity_id: actor, type: "actor_created", payload: {} }],
      });
    }
    expect(received).toEqual([1, 2, 3]); // nothing arrived while disconnected

    const lastSeenSeq = received.at(-1)!;
    const replayed = feed.after(lastSeenSeq).map((e) => e.seq);
    const reconstructed = [...received, ...replayed];
    expect(reconstructed).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(reconstructed).size).toBe(6); // no dupes
  });

  it("compactRunDeltas folds output deltas into the transcript file and prunes the rows", () => {
    const { db, mutate, feed, dataDir } = harness();
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

    emitRunDetailEvent(mutate, { entity_id: run.id, type: "run_output_delta", payload: { text: "Hello, " }, run_id: run.id, workstream_id: ws.id, actor_id: null });
    emitRunDetailEvent(mutate, { entity_id: run.id, type: "run_output_delta", payload: { text: "world." }, run_id: run.id, workstream_id: ws.id, actor_id: null });

    const beforeCount = (db.prepare(`SELECT COUNT(*) AS c FROM events WHERE type = 'run_output_delta'`).get() as { c: number }).c;
    expect(beforeCount).toBe(2);

    feed.compactRunDeltas(run.id);

    const afterCount = (db.prepare(`SELECT COUNT(*) AS c FROM events WHERE type = 'run_output_delta'`).get() as { c: number }).c;
    expect(afterCount).toBe(0);

    const path = transcriptPath(dataDir, run.id);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe("Hello, world.");
  });

  it("compactRunDeltas is a no-op when there are no deltas to compact", () => {
    const { mutate, feed } = harness();
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
    expect(() => feed.compactRunDeltas(run.id)).not.toThrow();
  });
});
