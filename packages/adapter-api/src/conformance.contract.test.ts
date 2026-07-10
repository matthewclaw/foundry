/**
 * Runs the actual `describeAdapterContract` suite against a minimal, hand-written
 * reference adapter (mandatory core + all optional capabilities). This proves the suite
 * is runnable end-to-end against *some* conformant adapter directly within this package,
 * independent of the fake adapter's own conformance run in `@foundry/adapter-fake`.
 */
import type { CapabilitySet, EngineEvent, ExecutionAdapter, RunHandle, RunSpec } from "./index.js";
import type { ConformanceBehavior } from "./conformance.js";
import { describeAdapterContract } from "./conformance.js";

class ReferenceAdapter implements ExecutionAdapter {
  readonly id = "conformance-reference";
  private readonly behavior: ConformanceBehavior;
  private readonly cancelled = new Set<string>();

  constructor(behavior: ConformanceBehavior) {
    this.behavior = behavior;
  }

  capabilities(): CapabilitySet {
    return {
      resume: true,
      stream_events: true,
      tool_events: true,
      usage: true,
      reasoning_summaries: true,
      permission_hooks: true,
      mcp: true,
    };
  }

  async start(spec: RunSpec): Promise<RunHandle> {
    return { runId: spec.runId, adapterId: this.id };
  }

  async resume(spec: RunSpec & { sessionRef: string }): Promise<RunHandle> {
    return { runId: spec.runId, adapterId: this.id };
  }

  async cancel(handle: RunHandle): Promise<void> {
    this.cancelled.add(handle.runId);
  }

  async *events(handle: RunHandle): AsyncIterable<EngineEvent> {
    const sessionRef = `sess-${handle.runId}`;
    yield { t: "run_started", sessionRef };

    if (this.behavior.exerciseDeclaredCapabilities) {
      yield { t: "reasoning_summary", text: "planning the run" };
      yield { t: "tool_call", phase: "start", name: "demo_tool" };
      yield { t: "tool_call", phase: "end", name: "demo_tool" };
      yield { t: "usage_delta", tokensIn: 12, tokensOut: 8, costUsd: 0.002 };
      yield { t: "permission_request", requestId: "perm-1", description: "allow demo action?" };
    }

    if (this.behavior.neverEnds) {
      while (!this.cancelled.has(handle.runId)) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      yield { t: "run_ended", outcome: "cancelled", sessionRef };
      return;
    }

    yield { t: "output_delta", text: "reference adapter output" };
    yield { t: "run_ended", outcome: this.behavior.outcome, finalText: "done", sessionRef };
  }
}

describeAdapterContract((behavior) => new ReferenceAdapter(behavior));
