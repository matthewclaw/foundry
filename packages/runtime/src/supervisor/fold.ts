/**
 * E4.2 / E13 — the "EngineEvent → store state" fold, extracted out of the batch
 * supervisor so the interactive ("drop in") driver can reuse the exact same audit
 * trail: every turn, however it was triggered, becomes ordinary `run_*` events and
 * `Run`/`Workstream` state transitions through this one function. Closes only over
 * the store — no scheduling/process concerns here, those stay in supervisor.ts (batch)
 * and interactive/session.ts (live attach).
 */
import { formatRef, type AgentId, type Run, type WorkstreamId } from "@foundry/core";
import type { Store } from "@foundry/store";
import type { EngineEvent } from "@foundry/adapter-api";

export interface FoldContext {
  workstreamId: WorkstreamId;
  agentId?: AgentId;
}

export type FoldStore = Pick<Store, "commands" | "agents" | "workstreams">;

export function foldEngineEvent(store: FoldStore, ctx: FoldContext, run: Run, event: EngineEvent): void {
  switch (event.t) {
    case "run_started":
      store.commands.transitionRunState({
        id: run.id,
        workstreamId: ctx.workstreamId,
        to: "running",
        actorId: null,
        engineSessionId: event.sessionRef ?? null,
      });
      return;
    case "output_delta":
      store.commands.emitRunDetailEvent({
        entity_id: run.id,
        type: "run_output_delta",
        payload: { text: event.text },
        run_id: run.id,
        workstream_id: ctx.workstreamId,
        actor_id: null,
      });
      return;
    case "tool_call":
      store.commands.emitRunDetailEvent({
        entity_id: run.id,
        type: "run_tool_call",
        payload: { phase: event.phase, name: event.name, detail: event.detail },
        run_id: run.id,
        workstream_id: ctx.workstreamId,
        actor_id: null,
      });
      return;
    case "usage_delta":
      store.commands.emitRunDetailEvent({
        entity_id: run.id,
        type: "run_usage_updated",
        payload: {
          tokens_in: event.tokensIn,
          tokens_out: event.tokensOut,
          cost_usd: event.costUsd,
        },
        run_id: run.id,
        workstream_id: ctx.workstreamId,
        actor_id: null,
      });
      return;
    case "awaiting_input":
      store.commands.transitionRunState({
        id: run.id,
        workstreamId: ctx.workstreamId,
        to: "awaiting_input",
        actorId: null,
        prompt: event.prompt,
      });
      store.commands.transitionWorkstreamState({
        id: ctx.workstreamId,
        to: "waiting",
        actorId: null,
        // ponytail: no message exists yet to point this at — server/E8.3 wires a real
        // waitingOnRef once the question is a Message.
        waitingOnRef: null,
      });
      return;
    case "reasoning_summary":
      // ponytail: no catalogue slot yet (E1.3 is additive-only, not extended here) —
      // silently unreported, OPEN_ISSUES #23.
      return;
    case "permission_request": {
      // E6.4: engine permission prompt → Foundry approval item. The RUN state is
      // deliberately untouched: an engine may keep streaming past the request (its
      // hook resolves in-process, see the fake's permission-request-granted scenario),
      // and the async grant path schedules a *fresh* run via the approvals route.
      const agent = ctx.agentId ? store.agents.get(ctx.agentId) : undefined;
      if (!agent) return; // no agent to attribute the request to (bare-supervisor callers)
      const approval = store.commands.requestApproval({
        requested_by_actor: agent.actor_id,
        kind: "engine_permission",
        payload: {
          request_id: event.requestId,
          description: event.description,
          run_id: run.id,
          workstream_id: ctx.workstreamId,
        },
      });
      // Make the wait visible on the workstream with a real waiting_on_ref (#25's
      // approval case): only from `active` — if it's already waiting, keep that ref.
      if (store.workstreams.get(ctx.workstreamId)?.state === "active") {
        store.commands.transitionWorkstreamState({
          id: ctx.workstreamId,
          to: "waiting",
          actorId: null,
          waitingOnRef: formatRef("approval", approval.id),
        });
      }
      return;
    }
    case "run_ended":
      foldRunEnded(store, ctx, run, event);
      return;
  }
}

function foldRunEnded(
  store: FoldStore,
  ctx: FoldContext,
  run: Run,
  event: Extract<EngineEvent, { t: "run_ended" }>
): void {
  switch (event.outcome) {
    case "completed":
      store.commands.transitionRunState({
        id: run.id,
        workstreamId: ctx.workstreamId,
        to: "completed",
        actorId: null,
        result: { outcome: "completed", final_text: event.finalText ?? null, artifact_refs: [] },
      });
      return;
    case "needs_input":
      // Already folded into run/workstream state by the preceding `awaiting_input`
      // event (per adapter-fake's own scenario contract: the two always pair up).
      return;
    case "failed":
      store.commands.transitionRunState({
        id: run.id,
        workstreamId: ctx.workstreamId,
        to: "failed",
        actorId: null,
        error: event.error ?? "unknown error",
      });
      return;
    case "cancelled":
      store.commands.transitionRunState({
        id: run.id,
        workstreamId: ctx.workstreamId,
        to: "cancelled",
        actorId: null,
        reason: event.error ?? "adapter reported cancelled",
      });
      return;
  }
}
