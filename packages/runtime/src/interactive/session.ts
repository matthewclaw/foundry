/**
 * E13 — "drop in": a live, multi-turn session attached to a workstream's most recent
 * engine session. Distinct from the batch queue/supervisor path (E4) — the underlying
 * engine process stays alive across many turns instead of exiting after one — but
 * every turn still becomes an ordinary `Run` row folded through the exact same
 * `foldEngineEvent` (supervisor/fold.ts) the batch path uses, so the audit trail
 * (event log, cost, tool calls) is identical either way. Engine-agnostic: this module
 * only ever calls through the adapter registered for the workstream's engine, gated on
 * `capabilities().interactive` — it never assumes which engine that is.
 */
import { formatRef, type Agent, type AgentId, type Run, type Workstream, type WorkstreamId } from "@foundry/core";
import type { Store } from "@foundry/store";
import type { ExecutionAdapter, RunSpec } from "@foundry/adapter-api";
import { foldEngineEvent } from "../supervisor/fold.js";

export interface InteractiveHandle {
  /** Sends one turn's worth of input. `{ok:false, reason:"busy"}` if the previous turn
   * hasn't produced its terminal event yet — no queueing of interactive turns in v1. */
  send(text: string): { ok: true } | { ok: false; reason: string };
  /** Detaches this caller. Multiple browser tabs can share one live session (refcounted)
   * — the underlying engine process only actually closes once every caller has detached. */
  detach(): void;
}

export type AttachResult =
  | { ok: true; handle: InteractiveHandle; engineSessionId: string }
  | { ok: false; reason: string };

interface SessionEntry {
  session: import("@foundry/adapter-api").InteractiveEngineSession;
  refCount: number;
  busy: boolean;
  currentRun: Run | null;
  engineSessionId: string;
  /** Whether THIS attach caused the active→waiting transition — only true if the
   * workstream was "active" (not already "waiting" on something else, e.g. a paused
   * run's own awaiting_input) when we attached. Detach only reverses what we caused:
   * attaching to an already-waiting workstream must leave that unrelated wait intact. */
  causedWaitingTransition: boolean;
}

export interface InteractiveSessionManagerOptions {
  store: Store;
  adapters: Record<string, ExecutionAdapter>;
  queue: { reserveWorkstream(id: WorkstreamId): boolean; releaseWorkstream(id: WorkstreamId): void };
  resolve(workstreamId: WorkstreamId): { workstream: Workstream; agent: Agent };
  /** Same acquisition facade.ts already does for a batch run — reused as-is. */
  acquireWorkspace(workstream: Workstream): { ok: boolean; workspaceDir?: string; refusalReason?: string };
}

/** Any run with a recorded session, including completed ones — matches what headless
 * resume already allows (supervisor.ts's own findResumableSessionId), so "drop in" can
 * pick up a finished conversation and keep going, not just an actively paused one. */
function findResumableSessionId(store: Store, workstreamId: WorkstreamId): string | undefined {
  const runs = store.runs.list({ workstream_id: workstreamId }).filter((r) => r.engine_session_id);
  return runs.at(-1)?.engine_session_id ?? undefined;
}

export function createInteractiveSessionManager(opts: InteractiveSessionManagerOptions) {
  const sessions = new Map<WorkstreamId, SessionEntry>();

  function makeHandle(workstreamId: WorkstreamId, agentId: AgentId, entry: SessionEntry): InteractiveHandle {
    return {
      send(text) {
        if (entry.busy) return { ok: false, reason: "busy" };
        const run = opts.store.commands.createRun({
          workstream_id: workstreamId,
          trigger: "interactive_message",
          input_context_ref: "(interactive)",
          engine_id: opts.resolve(workstreamId).agent.engine.id,
          // Carry the user's text on the run_queued event so the timeline can show what
          // was actually said — same field the headless path sets, so an interactive turn
          // renders its own message bubble instead of appearing to come from nowhere.
          trigger_message_md: text,
        });
        opts.store.commands.transitionRunState({ id: run.id, workstreamId, to: "starting", actorId: null });
        entry.currentRun = run;
        entry.busy = true;
        entry.session.send(text);
        return { ok: true };
      },
      detach() {
        entry.refCount--;
        if (entry.refCount > 0) return;
        sessions.delete(workstreamId);
        entry.session.close();
        opts.queue.releaseWorkstream(workstreamId);
        // Only reverse the transition if THIS attach is what caused it — attaching to
        // a workstream that was already "waiting" for an unrelated reason (e.g. a
        // run's own awaiting_input pause) must leave that wait exactly as it was.
        if (entry.causedWaitingTransition && opts.store.workstreams.get(workstreamId)?.state === "waiting") {
          opts.store.commands.transitionWorkstreamState({ id: workstreamId, to: "active", actorId: null });
        }
      },
    };
  }

  function startReaderLoop(workstreamId: WorkstreamId, agentId: AgentId, entry: SessionEntry): void {
    (async () => {
      try {
        for await (const event of entry.session.events()) {
          if (!entry.currentRun) continue; // stray event before the first send() — ignore
          foldEngineEvent(opts.store, { workstreamId, agentId }, entry.currentRun, event);
          if (event.t === "run_ended") entry.busy = false;
        }
      } catch (err) {
        // The engine process died mid-turn, or a genuinely malformed event broke the
        // fold — either way, don't leave the in-flight turn stuck `busy` forever with
        // no resolution. Fold it to a terminal state the same way the batch
        // supervisor's own abnormal-termination path does (starting → failed;
        // running/awaiting_* → interrupted), then let this reader die — a fresh
        // attach() spawns a new session next time.
        if (entry.currentRun) {
          const current = opts.store.runs.get(entry.currentRun.id);
          try {
            if (current?.state === "starting") {
              opts.store.commands.transitionRunState({
                id: entry.currentRun.id,
                workstreamId,
                to: "failed",
                actorId: null,
                error: err instanceof Error ? err.message : String(err),
              });
            } else if (
              current?.state === "running" ||
              current?.state === "awaiting_input" ||
              current?.state === "awaiting_approval"
            ) {
              opts.store.commands.transitionRunState({
                id: entry.currentRun.id,
                workstreamId,
                to: "interrupted",
                actorId: null,
                reason: err instanceof Error ? err.message : String(err),
              });
            }
          } catch {
            // Already folded by something else, or the store is closed — nothing
            // safer to do from this background loop.
          }
        }
        entry.busy = false;
      }
    })();
  }

  return {
    async attach(workstreamId: WorkstreamId): Promise<AttachResult> {
      const existing = sessions.get(workstreamId);
      if (existing) {
        existing.refCount++;
        const { agent } = opts.resolve(workstreamId);
        return {
          ok: true,
          engineSessionId: existing.engineSessionId,
          handle: makeHandle(workstreamId, agent.id, existing),
        };
      }

      const { workstream, agent } = opts.resolve(workstreamId);
      const adapter = opts.adapters[agent.engine.id];
      if (!adapter) return { ok: false, reason: `no adapter registered for engine "${agent.engine.id}"` };
      if (!adapter.capabilities().interactive || !adapter.attachInteractive) {
        return { ok: false, reason: `engine "${agent.engine.id}" does not support interactive attach` };
      }

      const sessionRef = findResumableSessionId(opts.store, workstreamId);
      if (!sessionRef) return { ok: false, reason: "no prior session on this workstream to attach to" };

      // "waiting" is attachable as-is (the exact motivating case — a run paused on
      // awaiting_input) since the state machine only defines `active -> waiting`, not
      // `waiting -> waiting`; only "active" needs the transition below. Anything else
      // (open/blocked/review/closed/archived) must reject cleanly here, not throw an
      // InvalidTransitionError out of attach().
      if (workstream.state !== "active" && workstream.state !== "waiting") {
        return { ok: false, reason: `workstream is "${workstream.state}", not attachable` };
      }

      const acquired = opts.acquireWorkspace(workstream);
      if (!acquired.ok) {
        return { ok: false, reason: `workspace unavailable: ${acquired.refusalReason ?? "unknown reason"}` };
      }

      if (!opts.queue.reserveWorkstream(workstreamId)) {
        return { ok: false, reason: "a headless run is already active on this workstream" };
      }

      const causedWaitingTransition = workstream.state === "active";
      if (causedWaitingTransition) {
        opts.store.commands.transitionWorkstreamState({
          id: workstreamId,
          to: "waiting",
          actorId: null,
          waitingOnRef: formatRef("workstream", workstreamId),
        });
      }

      const spec: RunSpec & { sessionRef?: string } = {
        runId: "" as Run["id"], // unused by attachInteractive — each turn mints its own Run
        agentName: agent.name,
        contextFile: "(interactive)",
        workspaceDir: acquired.workspaceDir ?? "",
        orgTools: {},
        engineConfig: agent.engine.config,
        limits: { wallClockMs: 0 },
        sessionRef,
      };
      const session = await adapter.attachInteractive(spec);
      const entry: SessionEntry = {
        session,
        refCount: 1,
        busy: false,
        currentRun: null,
        engineSessionId: sessionRef,
        causedWaitingTransition,
      };
      sessions.set(workstreamId, entry);
      startReaderLoop(workstreamId, agent.id, entry);
      return { ok: true, engineSessionId: sessionRef, handle: makeHandle(workstreamId, agent.id, entry) };
    },
  };
}

export type InteractiveSessionManager = ReturnType<typeof createInteractiveSessionManager>;
