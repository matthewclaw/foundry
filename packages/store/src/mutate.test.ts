import { describe, expect, it } from "vitest";
import { newActorId } from "@foundry/core";
import { openDb } from "./db/connection.js";
import { createEventBus } from "./events/bus.js";
import { createMutate } from "./mutate.js";

function actorCount(db: ReturnType<typeof openDb>): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM actors`).get() as { c: number }).c;
}

function eventCount(db: ReturnType<typeof openDb>): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM events`).get() as { c: number }).c;
}

describe("mutate() (E2.2 keystone)", () => {
  it("commits state change and event together", () => {
    const db = openDb(":memory:");
    const bus = createEventBus();
    const mutate = createMutate(db, bus);
    const id = newActorId();

    const result = mutate({
      apply: (tx) => {
        tx.db
          .prepare(`INSERT INTO actors (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)`)
          .run(id, "human", "Ada", new Date().toISOString());
        return { id };
      },
      events: [
        {
          actor_id: id,
          entity_type: "actor",
          entity_id: id,
          type: "actor_created", // not in catalogue — tolerated as an unknown type
          payload: { display_name: "Ada" },
        },
      ],
    });

    expect(result.id).toBe(id);
    expect(actorCount(db)).toBe(1);
    expect(eventCount(db)).toBe(1);
    const row = db.prepare(`SELECT seq FROM events`).get() as { seq: number };
    expect(row.seq).toBe(1);
  });

  it("kill-mid-transaction: a throw inside apply() leaves neither state nor event", () => {
    const db = openDb(":memory:");
    const bus = createEventBus();
    const mutate = createMutate(db, bus);
    const id = newActorId();

    expect(() =>
      mutate({
        apply: (tx) => {
          tx.db
            .prepare(`INSERT INTO actors (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)`)
            .run(id, "human", "Ada", new Date().toISOString());
          throw new Error("simulated crash mid-transaction");
        },
        events: [
          {
            actor_id: id,
            entity_type: "actor",
            entity_id: id,
            type: "actor_created",
            payload: {},
          },
        ],
      })
    ).toThrow("simulated crash mid-transaction");

    expect(actorCount(db)).toBe(0);
    expect(eventCount(db)).toBe(0);
  });

  it("an invalid event payload rolls back the state change too", () => {
    const db = openDb(":memory:");
    const bus = createEventBus();
    const mutate = createMutate(db, bus);
    const id = newActorId();

    expect(() =>
      mutate({
        apply: (tx) => {
          tx.db
            .prepare(`INSERT INTO actors (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)`)
            .run(id, "human", "Ada", new Date().toISOString());
        },
        events: [
          {
            actor_id: id,
            entity_type: "agent",
            entity_id: id,
            type: "agent_activated", // catalogue type expects an empty-object payload
            payload: { unexpected: "field goes nowhere near this schema" },
          },
        ],
      })
    ).toThrow();

    expect(actorCount(db)).toBe(0);
    expect(eventCount(db)).toBe(0);
  });

  it("assigns monotonic seq across separate mutate() calls", () => {
    const db = openDb(":memory:");
    const bus = createEventBus();
    const mutate = createMutate(db, bus);

    for (let i = 0; i < 5; i++) {
      const id = newActorId();
      mutate({
        apply: () => undefined,
        events: [
          { actor_id: id, entity_type: "actor", entity_id: id, type: "actor_created", payload: {} },
        ],
      });
    }
    const rows = db.prepare(`SELECT seq FROM events ORDER BY seq`).all() as { seq: number }[];
    const seqs = rows.map((r) => r.seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(seqs).size).toBe(5);
  });

  it("notifies subscribers only after commit, with the persisted event (seq assigned)", () => {
    const db = openDb(":memory:");
    const bus = createEventBus();
    const mutate = createMutate(db, bus);
    const received: number[] = [];
    bus.subscribe((e) => received.push(e.seq));

    const id = newActorId();
    mutate({
      apply: () => undefined,
      events: [{ actor_id: id, entity_type: "actor", entity_id: id, type: "actor_created", payload: {} }],
    });

    expect(received).toEqual([1]);

    // A rolled-back mutation must never reach subscribers.
    expect(() =>
      mutate({
        apply: () => {
          throw new Error("boom");
        },
        events: [{ actor_id: id, entity_type: "actor", entity_id: id, type: "actor_created", payload: {} }],
      })
    ).toThrow();
    expect(received).toEqual([1]);
  });
});
