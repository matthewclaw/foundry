/**
 * E7.1 — reconnect resilience: after the stream drops, the next connection must
 * carry ?after=<last seq seen> so the server replays the gap.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { connectFeed } from "./sse.js";
import type { FeedEvent } from "./types.js";

function sseBody(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close(); // stream ends → client must reconnect
    },
  });
}

function neverEndingBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start() {} });
}

describe("connectFeed reconnect resilience", () => {
  let urls: string[];

  beforeEach(() => {
    urls = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reconnects with ?after=<last seq seen> and delivers events", async () => {
    const events: FeedEvent[] = [];
    const bodies = [
      sseBody([
        `id: 41\ndata: ${JSON.stringify({ seq: 41, type: "run_started" })}\n\n`,
        `: hb\n\n`,
        `id: 42\ndata: ${JSON.stringify({ seq: 42, type: "run_ended" })}\n\n`,
      ]),
      neverEndingBody(), // second connection stays open
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        urls.push(String(url));
        return { ok: true, status: 200, statusText: "OK", body: bodies.shift() ?? neverEndingBody() } as Response;
      })
    );

    const conn = connectFeed({
      after: 0,
      reconnectDelayMs: 5,
      onEvent: (e) => events.push(e),
    });

    await vi.waitFor(() => expect(urls.length).toBeGreaterThanOrEqual(2));
    conn.disconnect();

    expect(urls[0]).toBe("/api/events?after=0");
    expect(events.map((e) => e.seq)).toEqual([41, 42]);
    // the reconnect must replay from the last seq seen — the E7.1 contract
    expect(urls[1]).toBe("/api/events?after=42");
  });

  it("honours the `after` option on first connect", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        urls.push(String(url));
        return { ok: true, status: 200, statusText: "OK", body: neverEndingBody() } as Response;
      })
    );

    const conn = connectFeed({ after: 17, reconnectDelayMs: 5, onEvent: () => {} });
    await vi.waitFor(() => expect(urls.length).toBe(1));
    conn.disconnect();

    expect(urls[0]).toBe("/api/events?after=17");
  });

  it("reports HTTP failures via onError and retries", async () => {
    const errors: Error[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        urls.push(String(url));
        return { ok: false, status: 500, statusText: "Internal Server Error", body: null } as Response;
      })
    );

    const conn = connectFeed({
      after: 0,
      reconnectDelayMs: 5,
      onEvent: () => {},
      onError: (e) => errors.push(e),
    });

    await vi.waitFor(() => expect(urls.length).toBeGreaterThanOrEqual(2)); // it retried
    conn.disconnect();

    expect(errors[0]?.message).toContain("500");
  });
});
