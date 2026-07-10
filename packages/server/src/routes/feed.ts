/**
 * E5.5 — SSE event feed with `after` replay (contracts.md):
 * GET /api/events?after=<seq> — every event has a monotonic seq; reconnect replays;
 * zero gap, zero dupe (F13).
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { Event } from "@foundry/core";
import type { RouteContext } from "../server.js";

let heartbeatIntervalMs = 15000; // ponytail: injectable for testing

export function setHeartbeatIntervalMs(ms: number): void {
  heartbeatIntervalMs = ms;
}

export function registerFeedRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get<{ Querystring: Record<string, unknown> }>("/api/events", { handler: streamEvents });

  async function streamEvents(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = request.query as Record<string, unknown>;
    const after = parseInt(String(query.after ?? "0"), 10);

    // Write SSE headers and begin streaming.
    void reply
      .status(200)
      .header("content-type", "text/event-stream")
      .header("cache-control", "no-cache")
      .header("connection", "keep-alive");

    // Subscribe first, buffering live events into an array.
    const buffer: Event[] = [];
    const unsubscribe = ctx.store.events.subscribe((e) => {
      buffer.push(e);
    });

    // Replay store.events.after(after), write each as SSE frame, remember the last seq.
    let lastReplayedSeq = after;
    const replayed = ctx.store.events.after(after);
    for (const event of replayed) {
      reply.raw.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
      lastReplayedSeq = event.seq;
    }

    // Flush buffer: skip events with seq <= lastReplayedSeq (already replayed or race condition).
    for (const event of buffer) {
      if (event.seq > lastReplayedSeq) {
        reply.raw.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
        lastReplayedSeq = event.seq;
      }
    }

    // From then on, stream each subscribed event directly.
    const directUnsubscribe = ctx.store.events.subscribe((e) => {
      if (e.seq > lastReplayedSeq) {
        reply.raw.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
        lastReplayedSeq = e.seq;
      }
    });

    // Heartbeat: write ": hb\n\n" every heartbeatIntervalMs
    const hbInterval = setInterval(() => {
      reply.raw.write(": hb\n\n");
    }, heartbeatIntervalMs);
    hbInterval.unref();

    // On request close: unsubscribe, clearInterval, end the reply.
    const onClose = () => {
      clearInterval(hbInterval);
      unsubscribe();
      directUnsubscribe();
      reply.raw.end();
    };
    request.raw.on("close", onClose);
  }
}
