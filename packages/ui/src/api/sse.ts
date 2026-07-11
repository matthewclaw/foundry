/**
 * E7.1 — SSE feed client with replay-from-last-seq reconnect (contracts.md, doc-06):
 * subscribe from last-seen seq; on connection loss reconnect with ?after=<lastSeq>,
 * so the server's replay guarantees zero gap / zero dupe.
 *
 * fetch-stream instead of EventSource: the server takes ?after=<seq>, not the
 * Last-Event-ID header EventSource would send, so we control the reconnect URL.
 */
import { useEffect } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { FeedEvent } from "./types.js";

export interface FeedOptions {
  after?: number;
  onEvent: (event: FeedEvent) => void;
  onError?: (error: Error) => void;
  /** ponytail: fixed reconnect delay, no exponential backoff — local single-user server. */
  reconnectDelayMs?: number;
}

export interface FeedConnection {
  disconnect: () => void;
}

export function connectFeed(options: FeedOptions): FeedConnection {
  let lastSeq = options.after ?? 0;
  let aborted = false;
  const delay = options.reconnectDelayMs ?? 1000;

  async function loop(): Promise<void> {
    while (!aborted) {
      try {
        const res = await fetch(`/api/events?after=${lastSeq}`);
        if (!res.ok) throw new Error(`feed connect failed: ${res.status} ${res.statusText}`);
        if (!res.body) throw new Error("feed response has no body");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done || aborted) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (line.startsWith("id: ")) {
              const seq = Number.parseInt(line.slice(4), 10);
              if (Number.isFinite(seq)) lastSeq = seq;
            } else if (line.startsWith("data: ")) {
              try {
                options.onEvent(JSON.parse(line.slice(6)) as FeedEvent);
              } catch (e) {
                options.onError?.(new Error(`unparseable feed event: ${String(e)}`));
              }
            }
            // ": hb" heartbeat comments and blank separators are ignored.
          }
        }
      } catch (e) {
        options.onError?.(e instanceof Error ? e : new Error(String(e)));
      }
      if (!aborted) await new Promise((r) => setTimeout(r, delay));
    }
  }

  void loop();
  return {
    disconnect() {
      aborted = true;
    },
  };
}

/**
 * E7.1 — invalidate the "org" query whenever feed events arrive, throttled to ~1/s.
 * ponytail: invalidate-on-any-event; per-event-type targeting when refetch cost bites.
 */
export function useEventFeed(queryClient: QueryClient): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const connection = connectFeed({
      onEvent: () => {
        if (timer) return; // trailing throttle: at most one invalidation per second
        timer = setTimeout(() => {
          timer = null;
          void queryClient.invalidateQueries({ queryKey: ["org"] });
        }, 1000);
      },
      onError: (error) => console.error("event feed:", error.message),
    });
    return () => {
      if (timer) clearTimeout(timer);
      connection.disconnect();
    };
  }, [queryClient]);
}
