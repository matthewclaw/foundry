/** E7.1/E7.3/E7.4 — Typed fetch helpers for the API (contracts.md). Throw on !ok. */
import type { OrgView, InboxItem, AgentPageDto, Timeline } from "./types.js";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, init);
  if (!res.ok) {
    throw new Error(`${init?.method ?? "GET"} /api${path} failed: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const apiClient = {
  getOrg: () => request<OrgView>("/org"),
  getAgent: (id: string) => request<AgentPageDto>(`/agents/${id}`),
  getInbox: () => request<InboxItem[]>("/inbox"),
  getTimeline: (workstreamId: string) => request<Timeline>(`/workstreams/${workstreamId}/timeline`),
  patchAgent: (id: string, body: { charter_md: string }) =>
    request<unknown>(`/agents/${id}`, json("PATCH", body)),
  postWorkstreamMessage: (workstreamId: string, body: { kind: "redirect"; body_md: string }) =>
    request<{ message_id: string; run_id: string }>(`/workstreams/${workstreamId}/messages`, json("POST", body)),
};
