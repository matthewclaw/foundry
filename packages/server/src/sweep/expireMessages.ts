/**
 * E8.3 — Periodic sweep for expired questions and production of escalation notifications.
 * Pure store sweep + server-side orchestration (policy resolution, messaging).
 */
import { sweepExpiredQuestions as sweepExpiredQuestionsPure } from "@foundry/store";
import type { Store } from "@foundry/store";
import type { ActorId } from "@foundry/core";
import { resolvePolicy } from "../policy/policy.js";

export interface SweepExpiredQuestionsArgs {
  store: Store;
  now: Date;
}

/** Sweep expired questions and send escalation notifications. */
export function sweepExpiredQuestions(args: SweepExpiredQuestionsArgs): void {
  const { store, now } = args;

  // Policy resolver: given an actor id, resolve their question expiry policy.
  // If the actor is an agent, resolve their policy; if human, use org default.
  const resolvePolicyForActor = (actorId: ActorId) => {
    const agent = store.agents.list().find((a) => a.actor_id === actorId);
    if (agent) {
      const policy = resolvePolicy(store, agent);
      return { question_expiry_hours: policy.question_expiry_hours };
    }
    // Human asker: no expiry policy (skip human-asked questions).
    return null;
  };

  // Run the pure sweep — this marks messages as expired and produces events.
  const expired = sweepExpiredQuestionsPure({
    db: store.db,
    mutate: store.mutate,
    now,
    resolvePolicyForActor,
  });

  // For each expired question, send a surfaced escalation notification on the SAME
  // thread the question was asked on (not a new thread — getOrCreateThread("task", id)
  // with the message's own id would create a fresh, disconnected thread every time,
  // since no other thread is ever anchored by a message id).
  if (expired.length > 0) {
    const human = store.commands.getOrCreateHumanActor();
    for (const expiredMsg of expired) {
      store.commands.sendMessage({
        thread_id: expiredMsg.thread_id as never,
        from_actor_id: human, // System notification
        to_actor_id: human,
        type: "escalation",
        body_md: `Question expired unanswered after ${resolvePolicyForActor(expiredMsg.from_actor_id as ActorId)?.question_expiry_hours ?? "N/A"} hours.`,
        refs: [],
        visibility: "surfaced",
      });
    }
  }
}
