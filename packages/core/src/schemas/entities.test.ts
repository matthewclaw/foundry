import { zodToJsonSchema } from "zod-to-json-schema";
import { describe, expect, it } from "vitest";
import {
  ActorSchema,
  AgentCharterSchema,
  AgentSchema,
  ApprovalSchema,
  ArtifactSchema,
  EventSchema,
  MessageSchema,
  RunSchema,
  ScheduleSchema,
  TaskSchema,
  TeamSchema,
  ThreadSchema,
  WorkstreamSchema,
} from "./entities.js";
import {
  agentActorFixture,
  agentCharterFixture,
  agentFixture,
  approvalFixture,
  artifactFixture,
  eventFixture,
  humanActorFixture,
  messageFixture,
  runFixture,
  scheduleFixture,
  taskFixture,
  teamFixture,
  threadFixture,
  workstreamFixture,
} from "./fixtures.js";

const cases = [
  ["Actor (human)", ActorSchema, humanActorFixture],
  ["Actor (agent)", ActorSchema, agentActorFixture],
  ["Agent", AgentSchema, agentFixture],
  ["AgentCharter", AgentCharterSchema, agentCharterFixture],
  ["Team", TeamSchema, teamFixture],
  ["Workstream", WorkstreamSchema, workstreamFixture],
  ["Run", RunSchema, runFixture],
  ["Task", TaskSchema, taskFixture],
  ["Message", MessageSchema, messageFixture],
  ["Thread", ThreadSchema, threadFixture],
  ["Approval", ApprovalSchema, approvalFixture],
  ["Artifact", ArtifactSchema, artifactFixture],
  ["Event", EventSchema, eventFixture],
  ["Schedule", ScheduleSchema, scheduleFixture],
] as const;

describe("entity schemas: round-trip parse(serialize(x)) = x", () => {
  for (const [name, schema, fixture] of cases) {
    it(`${name}`, () => {
      const serialized = JSON.stringify(fixture);
      const roundTripped = schema.parse(JSON.parse(serialized));
      expect(roundTripped).toEqual(fixture);
    });
  }
});

describe("entity schemas: JSON Schema generation", () => {
  for (const [name, schema] of cases) {
    it(`${name} converts to a usable JSON Schema`, () => {
      const jsonSchema = zodToJsonSchema(schema, name);
      expect(jsonSchema).toBeTypeOf("object");
      // A meaningful object schema always has a properties (or $ref/definitions for
      // refined/wrapped schemas) — this fails loudly if generation silently degrades to `{}`.
      const hasShape =
        "properties" in jsonSchema || "$ref" in jsonSchema || "definitions" in jsonSchema;
      expect(hasShape).toBe(true);
    });
  }
});

describe("entity schemas: reject invalid data", () => {
  it("Message requires to_actor_id or to_team_id", () => {
    expect(() =>
      MessageSchema.parse({ ...messageFixture, to_actor_id: null, to_team_id: null })
    ).toThrow();
  });

  it("Agent rejects an unknown state", () => {
    expect(() => AgentSchema.parse({ ...agentFixture, state: "zombie" })).toThrow();
  });

  it("Artifact rejects a malformed sha256", () => {
    expect(() => ArtifactSchema.parse({ ...artifactFixture, sha256: "not-a-hash" })).toThrow();
  });

  it("Workstream rejects a malformed origin", () => {
    expect(() =>
      WorkstreamSchema.parse({ ...workstreamFixture, origin: "spaceship" })
    ).toThrow();
  });
});
