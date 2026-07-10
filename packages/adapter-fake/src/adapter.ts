/**
 * E3.3 — the fake engine adapter (ADR-010: a first-class product component, same quality
 * bar as production code, not test scaffolding). Declares every optional capability;
 * drives its event stream entirely from a `Scenario`'s step list.
 */
import type { CapabilitySet, EngineEvent, ExecutionAdapter, RunHandle, RunSpec } from "@foundry/adapter-api";
import { FakeEngineConfigSchema, type Scenario } from "./scenario.js";
import { loadScenario } from "./scenarios-registry.js";

const ALL_CAPABILITIES: CapabilitySet = {
  resume: true,
  stream_events: true,
  tool_events: true,
  usage: true,
  reasoning_summaries: true,
  permission_hooks: true,
  mcp: true,
};

/**
 * The fake adapter stashes the scenario resolved at `start()`/`resume()` time on the
 * handle it returns, so `events()` (called separately, per the adapter contract) knows
 * which script to replay without needing extra adapter-side state keyed by run id.
 */
interface FakeRunHandle extends RunHandle {
  readonly scenario: Scenario;
}

function isFakeRunHandle(handle: RunHandle): handle is FakeRunHandle {
  return Array.isArray((handle as FakeRunHandle).scenario?.steps);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FakeExecutionAdapter implements ExecutionAdapter {
  readonly id = "fake";
  private readonly defaultScenario: Scenario;
  private readonly cancelled = new Set<string>();

  constructor(defaultScenario: Scenario) {
    this.defaultScenario = defaultScenario;
  }

  capabilities(): CapabilitySet {
    return ALL_CAPABILITIES;
  }

  private resolveScenario(spec: RunSpec): Scenario {
    const config = FakeEngineConfigSchema.parse(spec.engineConfig);
    if (config?.scenario) return config.scenario;
    if (config?.scenarioName) return loadScenario(config.scenarioName);
    return this.defaultScenario;
  }

  async start(spec: RunSpec): Promise<RunHandle> {
    const scenario = this.resolveScenario(spec);
    const handle: FakeRunHandle = { runId: spec.runId, adapterId: this.id, scenario };
    return handle;
  }

  async resume(spec: RunSpec & { sessionRef: string }): Promise<RunHandle> {
    return this.start(spec);
  }

  async cancel(handle: RunHandle): Promise<void> {
    this.cancelled.add(handle.runId);
  }

  async *events(handle: RunHandle): AsyncIterable<EngineEvent> {
    if (!isFakeRunHandle(handle)) {
      throw new Error("fake adapter: events() called with a handle it didn't issue");
    }
    for (const step of handle.scenario.steps) {
      switch (step.type) {
        case "event":
          yield step.event;
          break;
        case "sleep":
          await sleep(step.ms);
          break;
        case "crash":
          throw new Error(
            step.message ?? `fake adapter: scripted crash (scenario "${handle.scenario.name}")`
          );
        case "hang":
          while (!this.cancelled.has(handle.runId)) {
            await sleep(20);
          }
          break;
        case "malformed_event":
          // ponytail: deliberate contract violation for F15 — see ScenarioMalformedEventStepSchema.
          yield step.payload as EngineEvent;
          break;
      }
    }
  }
}

export function createFakeAdapter(defaultScenario: Scenario): ExecutionAdapter {
  return new FakeExecutionAdapter(defaultScenario);
}
