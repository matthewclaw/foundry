/**
 * ADR-010: "the fake adapter passes its own conformance suite in CI — that is the proof
 * the suite and the reference implementation agree." Each `ConformanceBehavior` is
 * translated into an ad-hoc scenario here rather than one of the canned files in
 * `scenarios/` — those are a separate fixture library for other lanes (runtime, server,
 * e2e), not this suite's driver (OPEN_ISSUES.md #13).
 */
import type { ConformanceBehavior } from "@foundry/adapter-api";
import { describeAdapterContract } from "@foundry/adapter-api";
import { createFakeAdapter } from "./adapter.js";
import type { Scenario, ScenarioStep } from "./scenario.js";

function scenarioForBehavior(behavior: ConformanceBehavior): Scenario {
  const sessionRef = `sess-conformance-${Math.random().toString(36).slice(2, 10)}`;
  const steps: ScenarioStep[] = [{ type: "event", event: { t: "run_started", sessionRef } }];

  if (behavior.exerciseDeclaredCapabilities) {
    steps.push(
      { type: "event", event: { t: "reasoning_summary", text: "considering the request" } },
      { type: "event", event: { t: "tool_call", phase: "start", name: "delegate_task" } },
      { type: "event", event: { t: "tool_call", phase: "end", name: "delegate_task" } },
      { type: "event", event: { t: "usage_delta", tokensIn: 120, tokensOut: 48, costUsd: 0.004 } },
      {
        type: "event",
        event: { t: "permission_request", requestId: "perm-1", description: "allow demo action?" },
      }
    );
  }

  if (behavior.neverEnds) {
    steps.push(
      { type: "hang" },
      { type: "event", event: { t: "run_ended", outcome: "cancelled", sessionRef } }
    );
  } else {
    steps.push(
      { type: "event", event: { t: "output_delta", text: "fake adapter output" } },
      { type: "event", event: { t: "run_ended", outcome: behavior.outcome, finalText: "done", sessionRef } }
    );
  }

  return {
    name: `conformance:${behavior.outcome}:${behavior.neverEnds ? "hang" : "run"}`,
    description: "conformance-suite-driven scenario, not part of the shipped scenario library",
    steps,
  };
}

describeAdapterContract((behavior) => createFakeAdapter(scenarioForBehavior(behavior)));
