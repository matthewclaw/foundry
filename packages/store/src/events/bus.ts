/**
 * In-process pub/sub shared between `mutate()` (publisher, after commit) and
 * `events.subscribe()` (consumer) — contracts.md keeps these on the same `Store`, so a
 * single bus instance per store wires them together without a queue or transport.
 */
import type { Event } from "@foundry/core";

export type Unsubscribe = () => void;

export interface EventBus {
  publish(events: readonly Event[]): void;
  subscribe(cb: (e: Event) => void): Unsubscribe;
}

export function createEventBus(): EventBus {
  const subscribers = new Set<(e: Event) => void>();
  return {
    publish(events) {
      for (const event of events) {
        for (const cb of subscribers) cb(event);
      }
    },
    subscribe(cb) {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
  };
}
