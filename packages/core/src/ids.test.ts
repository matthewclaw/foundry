import { describe, expect, it } from "vitest";
import {
  ActorIdSchema,
  formatRef,
  isValidRef,
  isValidUlid,
  newActorId,
  newAgentId,
  newUlid,
  parseRef,
  RefSchema,
} from "./ids.js";

describe("ULID", () => {
  it("generates valid, unique ULIDs", () => {
    const a = newUlid();
    const b = newUlid();
    expect(isValidUlid(a)).toBe(true);
    expect(isValidUlid(b)).toBe(true);
    expect(a).not.toBe(b);
  });

  it("rejects malformed strings", () => {
    expect(isValidUlid("not-a-ulid")).toBe(false);
    expect(isValidUlid("")).toBe(false);
    expect(isValidUlid("0".repeat(25))).toBe(false); // too short
  });

  it("is monotonically sortable, including within the same tick", () => {
    const ids = Array.from({ length: 200 }, () => newUlid());
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });
});

describe("branded id schemas", () => {
  it("parses a valid ULID and rejects invalid ones", () => {
    const id = newActorId();
    expect(ActorIdSchema.parse(id)).toBe(id);
    expect(() => ActorIdSchema.parse("nope")).toThrow();
  });

  it("keeps distinct entity id kinds nominally distinct at the type level", () => {
    const actorId = newActorId();
    const agentId = newAgentId();
    // Both are ULID strings at runtime; the type system is what prevents mixing them.
    expect(isValidUlid(actorId)).toBe(true);
    expect(isValidUlid(agentId)).toBe(true);
  });
});

describe("typed refs", () => {
  it("round-trips format/parse for entity refs", () => {
    const id = newActorId();
    const ref = formatRef("actor", id);
    expect(ref).toBe(`actor:${id}`);
    expect(parseRef(ref)).toEqual({ kind: "actor", id });
    expect(isValidRef(ref)).toBe(true);
    expect(RefSchema.parse(ref)).toBe(ref);
  });

  it("round-trips event refs as decimal seq, not ULID", () => {
    const ref = formatRef("event", "482");
    expect(parseRef(ref)).toEqual({ kind: "event", id: "482" });
    expect(isValidRef(ref)).toBe(true);
    expect(isValidRef("event:not-a-number")).toBe(false);
  });

  it("rejects malformed refs", () => {
    expect(isValidRef("bogus")).toBe(false);
    expect(isValidRef("actor:")).toBe(false);
    expect(isValidRef("nonsense:01J000000000000000000000")).toBe(false);
    expect(() => parseRef("bogus")).toThrow();
  });
});
