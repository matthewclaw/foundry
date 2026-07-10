import { describe, expect, it } from "vitest";
import { parseScenario, ScenarioSchema } from "./scenario.js";

describe("ScenarioSchema", () => {
  it("accepts a minimal valid scenario", () => {
    const scenario = {
      name: "minimal",
      description: "a minimal scenario",
      steps: [{ type: "event", event: { t: "run_started" } }],
    };
    expect(() => parseScenario(scenario)).not.toThrow();
  });

  it("accepts every step kind", () => {
    const scenario = {
      name: "all-step-kinds",
      description: "exercises every step type",
      steps: [
        { type: "event", event: { t: "run_started" } },
        { type: "sleep", ms: 10 },
        { type: "hang" },
        { type: "malformed_event", payload: { anything: "goes" } },
        { type: "crash", message: "boom" },
      ],
    };
    expect(() => parseScenario(scenario)).not.toThrow();
  });

  it("rejects a scenario with no steps", () => {
    expect(() => parseScenario({ name: "empty", description: "x", steps: [] })).toThrow();
  });

  it("rejects an unknown step type", () => {
    const scenario = {
      name: "bad-step",
      description: "x",
      steps: [{ type: "teleport" }],
    };
    expect(() => parseScenario(scenario)).toThrow();
  });

  it("rejects an event step whose event doesn't conform to EngineEventSchema", () => {
    const scenario = {
      name: "bad-event",
      description: "x",
      steps: [{ type: "event", event: { t: "output_delta" } }], // missing required text
    };
    expect(() => parseScenario(scenario)).toThrow();
  });

  it("ScenarioSchema.parse and parseScenario agree", () => {
    const scenario = { name: "n", description: "d", steps: [{ type: "hang" }] };
    expect(parseScenario(scenario)).toEqual(ScenarioSchema.parse(scenario));
  });
});
