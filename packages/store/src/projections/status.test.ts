import { describe, expect, it } from "vitest";
import { deriveAgentStatus, worstStatus, type AgentStatusFacts } from "./status.js";

const BASE: AgentStatusFacts = {
  hasBlockedWorkstreamOrTask: false,
  recentConsecutiveFailures: 0,
  hasRunningOrStartingRun: false,
  hasWaitingWorkstream: false,
  openCommitmentCount: 0,
  overCommittedThreshold: 5,
};

describe("E2.5 deriveAgentStatus — doc-02 precedence table, case by case", () => {
  it("idle: nothing going on", () => {
    expect(deriveAgentStatus(BASE)).toBe("idle");
  });

  it("active: a run is running/starting", () => {
    expect(deriveAgentStatus({ ...BASE, hasRunningOrStartingRun: true })).toBe("active");
  });

  it("waiting: no active run, a workstream is waiting", () => {
    expect(deriveAgentStatus({ ...BASE, hasWaitingWorkstream: true })).toBe("waiting");
  });

  it("over-committed: no run/waiting/blocked/degraded signal, but open commitments exceed threshold", () => {
    expect(deriveAgentStatus({ ...BASE, openCommitmentCount: 6, overCommittedThreshold: 5 })).toBe(
      "over-committed"
    );
    expect(deriveAgentStatus({ ...BASE, openCommitmentCount: 5, overCommittedThreshold: 5 })).toBe("idle");
  });

  it("degraded: 2+ consecutive recent failures", () => {
    expect(deriveAgentStatus({ ...BASE, recentConsecutiveFailures: 2 })).toBe("degraded");
    expect(deriveAgentStatus({ ...BASE, recentConsecutiveFailures: 1 })).toBe("idle");
  });

  it("blocked: beats everything else", () => {
    expect(deriveAgentStatus({ ...BASE, hasBlockedWorkstreamOrTask: true })).toBe("blocked");
  });

  it("precedence: blocked > degraded", () => {
    expect(
      deriveAgentStatus({ ...BASE, hasBlockedWorkstreamOrTask: true, recentConsecutiveFailures: 3 })
    ).toBe("blocked");
  });

  it("precedence: degraded > waiting", () => {
    expect(
      deriveAgentStatus({ ...BASE, recentConsecutiveFailures: 2, hasWaitingWorkstream: true })
    ).toBe("degraded");
  });

  it("precedence: waiting > active (a waiting workstream masks another workstream's active run only if no run is actually running/starting)", () => {
    // Per 02, `active` requires >=1 run running/starting; if that's true, active wins
    // over waiting even with a waiting workstream present (they're not mutually exclusive
    // states across different workstreams) — so this is really precedence: active checked
    // only once waiting's "no active run" condition fails.
    expect(
      deriveAgentStatus({ ...BASE, hasWaitingWorkstream: true, hasRunningOrStartingRun: true })
    ).toBe("active");
  });

  it("precedence: active > over-committed", () => {
    expect(
      deriveAgentStatus({ ...BASE, hasRunningOrStartingRun: true, openCommitmentCount: 99 })
    ).toBe("active");
  });

  it("precedence: over-committed > idle", () => {
    expect(deriveAgentStatus({ ...BASE, openCommitmentCount: 99 })).toBe("over-committed");
  });
});

describe("worstStatus (team roll-up)", () => {
  it("picks the worst (most urgent) status by precedence, not first/last in the list", () => {
    expect(worstStatus(["idle", "active", "blocked", "waiting"])).toBe("blocked");
    expect(worstStatus(["idle", "over-committed"])).toBe("over-committed");
    expect(worstStatus([])).toBe("idle");
  });
});
