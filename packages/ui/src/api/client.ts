/** E7.1/E7.3/E7.4 — Typed fetch helpers for the API (contracts.md). Throw on !ok. */
import type { OrgView, InboxItem, AgentPageDto, Timeline, CostReport, TreeView } from "./types.js";

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

export interface CreateAgentBody {
  name: string;
  role: string;
  team_id?: string | null;
  charter_md: string;
  engine: { id: string; config?: unknown };
}

export interface CreateTeamBody {
  name: string;
  description?: string;
}

export type WorkspaceRefBody =
  | { kind: "plain_dir"; path: string }
  | { kind: "git_worktree"; repo_path: string; worktree_path: string; branch: string };

export interface CreateWorkstreamBody {
  agent_id: string;
  title: string;
  goal_md: string;
  workspace_ref?: WorkspaceRefBody;
}

export const apiClient = {
  getOrg: () => request<OrgView>("/org"),
  getAgent: (id: string) => request<AgentPageDto>(`/agents/${id}`),
  getInbox: () => request<InboxItem[]>("/inbox"),
  getTimeline: (workstreamId: string) => request<Timeline>(`/workstreams/${workstreamId}/timeline`),
  getCost: (scope?: string) => request<CostReport>(`/cost${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`),
  getTaskTree: (taskId: string) => request<TreeView>(`/tasks/${taskId}/tree`),
  patchAgent: (id: string, body: { charter_md: string }) =>
    request<unknown>(`/agents/${id}`, json("PATCH", body)),
  postWorkstreamMessage: (
    workstreamId: string,
    body: { kind: "message" | "redirect"; body_md: string; resume?: boolean }
  ) => request<{ message_id: string; run_id: string }>(`/workstreams/${workstreamId}/messages`, json("POST", body)),
  setRunTitle: (runId: string, title: string) =>
    request<unknown>(`/runs/${runId}/title`, json("PATCH", { title })),
  grantApproval: (id: string, note_md?: string) =>
    request<unknown>(`/approvals/${id}/grant`, json("POST", { note_md })),
  denyApproval: (id: string, reason?: string) =>
    request<unknown>(`/approvals/${id}/deny`, json("POST", { reason })),
  createAgent: (body: CreateAgentBody) => request<{ id: string }>("/agents", json("POST", body)),
  createTeam: (body: CreateTeamBody) => request<{ id: string; name: string }>("/teams", json("POST", body)),
  createWorkstream: (body: CreateWorkstreamBody) =>
    request<{ id: string }>("/workstreams", json("POST", { ...body, budget: {} })),
};
