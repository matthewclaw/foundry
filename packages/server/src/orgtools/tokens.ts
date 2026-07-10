/**
 * E6.1 ⚠ KEYSTONE — per-run scoped org-tools credentials (07 "Identity-bound"):
 * minted when a run starts, dead when it ends. A token maps to exactly one
 * (agent, run) pair, so every org-tool call attributes precisely and a run can never
 * act as someone else — and an engine that leaks its token leaks something that stops
 * working the moment its run ends.
 *
 * In-memory by design: a control-plane restart interrupts every live run (E4.5), which
 * makes their credentials correctly dead for free. No persistence, no clock-based
 * expiry — run end IS the expiry.
 */
import { randomBytes } from "node:crypto";
import type { ActorId, AgentId, RunId } from "@foundry/core";

export interface RunCredential {
  runId: RunId;
  agentId: AgentId;
  /** The agent's actor id — what org-tool-caused events attribute to. */
  actorId: ActorId;
}

export interface TokenRegistry {
  mint(credential: RunCredential): string;
  resolve(token: string): RunCredential | undefined;
  /** Expire every token for a run (called when its stream ends, however it ends). */
  revokeRun(runId: RunId): void;
  liveCount(): number;
}

export function createTokenRegistry(): TokenRegistry {
  const byToken = new Map<string, RunCredential>();
  return {
    mint(credential) {
      const token = randomBytes(32).toString("hex");
      byToken.set(token, credential);
      return token;
    },
    resolve(token) {
      return byToken.get(token);
    },
    revokeRun(runId) {
      for (const [token, cred] of byToken) {
        if (cred.runId === runId) byToken.delete(token);
      }
    },
    liveCount: () => byToken.size,
  };
}
