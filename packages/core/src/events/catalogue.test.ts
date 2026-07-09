import { describe, expect, it } from "vitest";
import {
  AGENT_TRANSITIONS,
  RUN_TRANSITIONS,
  TASK_TRANSITIONS,
  WORKSTREAM_TRANSITIONS,
} from "../state-machines/transitions.js";
import {
  EVENT_CATALOGUE,
  EVENT_CATALOGUE_VERSION,
  generateCatalogueMarkdown,
  getEventEntityType,
  getEventPayloadSchema,
  isKnownEventType,
  parseEventPayload,
  parseEventTolerant,
} from "./catalogue.js";

describe("catalogue completeness: every doc-02/04 state transition has an event type", () => {
  const allTransitionEvents = new Set([
    ...AGENT_TRANSITIONS.map((t) => t.event),
    ...WORKSTREAM_TRANSITIONS.map((t) => t.event),
    ...RUN_TRANSITIONS.map((t) => t.event),
    ...TASK_TRANSITIONS.map((t) => t.event),
  ]);

  it("every emitting event named by a transition table exists in the catalogue", () => {
    for (const type of allTransitionEvents) {
      expect(isKnownEventType(type), `missing catalogue entry for "${type}"`).toBe(true);
    }
  });
});

describe("catalogue lookups", () => {
  it("recognises every declared type and rejects unknown ones", () => {
    expect(isKnownEventType("task_created")).toBe(true);
    expect(isKnownEventType("task_teleported")).toBe(false);
  });

  it("resolves the entity_type and payload schema for a known type", () => {
    expect(getEventEntityType("run_completed")).toBe("run");
    expect(getEventPayloadSchema("run_completed")).toBeDefined();
  });

  it("validates a good payload and rejects a bad one for a known type", () => {
    expect(() => parseEventPayload("agent_activated", {})).not.toThrow();
    expect(() => parseEventPayload("task_blocked", {})).toThrow(); // missing required `reason`
  });

  it("every catalogue entry carries the current catalogue version or earlier (additive-only)", () => {
    for (const [, e] of Object.entries(EVENT_CATALOGUE)) {
      expect(e.since).toBeGreaterThan(0);
      expect(e.since).toBeLessThanOrEqual(EVENT_CATALOGUE_VERSION);
    }
  });
});

describe("unknown-type tolerance", () => {
  it("known types get validated payloads", () => {
    const result = parseEventTolerant("agent_activated", {});
    expect(result.known).toBe(true);
    if (result.known) {
      expect(result.type).toBe("agent_activated");
    }
  });

  it("unknown types (from a future catalogue version) pass through instead of throwing", () => {
    const result = parseEventTolerant("agent_teleported_v7", { anything: "goes" });
    expect(result.known).toBe(false);
    expect(result.payload).toEqual({ anything: "goes" });
  });
});

describe("catalogue markdown generation", () => {
  it("emits one row per catalogue entry, sorted, with the version header", () => {
    const md = generateCatalogueMarkdown();
    expect(md).toContain(`v${EVENT_CATALOGUE_VERSION}`);
    for (const type of Object.keys(EVENT_CATALOGUE)) {
      expect(md).toContain(`\`${type}\``);
    }
    const rowCount = md.split("\n").filter((l) => l.startsWith("| `")).length;
    expect(rowCount).toBe(Object.keys(EVENT_CATALOGUE).length);
  });
});
