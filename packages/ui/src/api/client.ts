/** E7.1 — Typed fetch helpers for the query endpoints (contracts.md). Throw on !ok. */
import type { OrgView, InboxItem } from "./types.js";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`);
  if (!res.ok) throw new Error(`GET /api${path} failed: ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export const apiClient = {
  getOrg: () => get<OrgView>("/org"),
  // E7.3 renders agentPage crudely — no point hand-copying its deep shape yet.
  getAgent: (id: string) => get<unknown>(`/agents/${id}`),
  getInbox: () => get<InboxItem[]>("/inbox"),
};
