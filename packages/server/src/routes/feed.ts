/**
 * E5.5 — SSE event feed with `after` replay (contracts.md):
 * GET /api/events?after=<seq> — every event has a monotonic seq; reconnect replays;
 * zero gap, zero dupe (F13).
 *
 * Gap/dupe-freedom: subscribe FIRST (buffering), then replay, then flip the same
 * subscription to live mode — one subscription for the connection's lifetime, so
 * nothing can slip between replay and live, and the seq guard drops anything the
 * replay already covered. The subscribe→replay→flip sequence has no awaits, so with
 * the store's synchronous in-process bus the buffer is empty in practice — the dance
 * exists so that never has to be true for correctness.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { Event } from "@foundry/core";
import type { RouteContext } from "../server.js";

let heartbeatIntervalMs = 15000; // ponytail: module-level injection for tests, no config framework

export function setHeartbeatIntervalMs(ms: number): void {
  heartbeatIntervalMs = ms;
}

export function registerFeedRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get("/api/events", (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, unknown>;
    const parsed = Number.parseInt(String(query.after ?? "0"), 10);
    const after = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;

    // Take the socket over from Fastify: SSE never "completes" a reply.
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    let lastSeq = after;
    const write = (e: Event) => {
      if (e.seq <= lastSeq) return; // already replayed — zero dupe
      lastSeq = e.seq;
      // ponytail: write() backpressure ignored — a local single-user feed; switch to
      // drain-aware buffering if this ever serves slow remote consumers.
      reply.raw.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
    };

    let mode: "buffer" | "live" = "buffer";
    const buffer: Event[] = [];
    const unsubscribe = ctx.store.events.subscribe((e) => {
      if (mode === "buffer") buffer.push(e);
      else write(e);
    });

    for (const event of ctx.store.events.after(after)) write(event); // replay — zero gap
    for (const event of buffer) write(event); // anything that raced the replay
    buffer.length = 0;
    mode = "live";

    const hbInterval = setInterval(() => {
      reply.raw.write(": hb\n\n");
    }, heartbeatIntervalMs);
    hbInterval.unref();

    request.raw.on("close", () => {
      clearInterval(hbInterval);
      unsubscribe();
      reply.raw.end();
    });
  });
}
