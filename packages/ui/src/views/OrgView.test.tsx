/**
 * E7.2 tests: statusBadge precedence (doc-02) + OrgView rendering a 200-agent
 * fixture with exception-first ordering.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OrgView, OrgViewAgent, OrgViewTeam, AgentStatus } from "../api/types.js";
import OrgViewComponent, { statusBadge } from "./OrgView.js";

vi.mock("../api/client.js", () => ({
  apiClient: { getOrg: vi.fn(), createTeam: vi.fn(), createAgent: vi.fn(), patchTeam: vi.fn(), deleteTeam: vi.fn(), deleteAgent: vi.fn() },
}));
import { apiClient } from "../api/client.js";

const PRECEDENCE: AgentStatus[] = ["blocked", "degraded", "waiting", "active", "over-committed", "idle"];

describe("statusBadge", () => {
  it("maps all six statuses to the right Tailwind classes", () => {
    expect(statusBadge("blocked").classes).toContain("bg-red-900/40");
    expect(statusBadge("degraded").classes).toContain("bg-orange-900/40");
    expect(statusBadge("waiting").classes).toContain("bg-amber-900/40");
    expect(statusBadge("active").classes).toContain("bg-green-900/40");
    expect(statusBadge("over-committed").classes).toContain("bg-purple-900/40");
    expect(statusBadge("idle").classes).toContain("bg-gray-800");
  });

  it("ranks follow doc-02 precedence: blocked > degraded > waiting > active > over-committed > idle", () => {
    expect(PRECEDENCE.map((s) => statusBadge(s).rank)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

function fixtureOrg(teamCount: number, agentsPerTeam: number): OrgView {
  const teams: OrgViewTeam[] = Array.from({ length: teamCount }, (_, t) => {
    const agents: OrgViewAgent[] = Array.from({ length: agentsPerTeam }, (_, a) => {
      const status = PRECEDENCE[a % PRECEDENCE.length]!;
      return {
        id: `agent-${t}-${a}` as OrgViewAgent["id"],
        name: `Agent ${t}-${a}`,
        role: "Specialist",
        team_id: `team-${t}` as OrgViewAgent["team_id"],
        state: "active",
        status,
      };
    });
    const worst = agents.reduce(
      (w, ag) => (statusBadge(ag.status).rank < statusBadge(w).rank ? ag.status : w),
      "idle" as AgentStatus
    );
    return { id: `team-${t}` as OrgViewTeam["id"], name: `Team ${t}`, agents, status: worst };
  });
  return { teams, unassignedAgents: [] };
}

function renderOrgView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <OrgViewComponent />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("OrgView", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders a 200-agent fixture with blocked/degraded before idle within a team", async () => {
    const fixture = fixtureOrg(10, 20); // 10 teams × 20 agents = 200
    vi.mocked(apiClient.getOrg).mockResolvedValue(fixture);

    renderOrgView();

    // every team contains a blocked agent, so all sections auto-expand → 200 rows
    const rows = await screen.findAllByTestId("agent-row");
    expect(rows).toHaveLength(200);

    // exception-first ordering inside Team 0: Agent 0-0 is blocked, Agent 0-5 idle
    const texts = rows.map((r) => r.textContent ?? "");
    const blockedIdx = texts.findIndex((t) => t.includes("Agent 0-0"));
    const degradedIdx = texts.findIndex((t) => t.includes("Agent 0-1"));
    const idleIdx = texts.findIndex((t) => t.includes("Agent 0-5"));
    expect(blockedIdx).toBeGreaterThanOrEqual(0);
    expect(blockedIdx).toBeLessThan(idleIdx);
    expect(degradedIdx).toBeLessThan(idleIdx);
  });

  it("collapses teams whose agents are all idle/active", async () => {
    const calm: OrgView = {
      teams: [
        {
          id: "team-calm" as OrgViewTeam["id"],
          name: "Calm Team",
          status: "idle",
          agents: [
            {
              id: "a1" as OrgViewAgent["id"],
              name: "Idle One",
              role: "Agent",
              team_id: "team-calm" as OrgViewAgent["team_id"],
              state: "active",
              status: "idle",
            },
          ],
        },
      ],
      unassignedAgents: [],
    };
    vi.mocked(apiClient.getOrg).mockResolvedValue(calm);

    renderOrgView();

    await screen.findByText("Calm Team");
    // collapsed: header renders, agent rows do not
    expect(screen.queryAllByTestId("agent-row")).toHaveLength(0);
  });

  it("creates a team via the New team form", async () => {
    vi.mocked(apiClient.getOrg).mockResolvedValue({ teams: [], unassignedAgents: [] });
    vi.mocked(apiClient.createTeam).mockResolvedValue({ id: "team-new", name: "Platform" });
    renderOrgView();

    await screen.findByText("Organization");
    fireEvent.click(screen.getByText("+ New team"));
    fireEvent.change(screen.getByLabelText("Team name"), { target: { value: "Platform" } });
    fireEvent.click(screen.getByText("Create team"));

    await waitFor(() => expect(apiClient.createTeam).toHaveBeenCalledWith({ name: "Platform", description: "", default_workspace_ref: null }));
    // form closes on success
    await waitFor(() => expect(screen.queryByLabelText("Team name")).toBeNull());
  });

  it("creates an agent via the New agent form, defaulting to the fake engine", async () => {
    const fixture: OrgView = {
      teams: [{ id: "team-1" as OrgViewTeam["id"], name: "Platform", status: "idle", agents: [] }],
      unassignedAgents: [],
    };
    vi.mocked(apiClient.getOrg).mockResolvedValue(fixture);
    vi.mocked(apiClient.createAgent).mockResolvedValue({ id: "agent-new" });
    renderOrgView();

    await screen.findByText("Organization");
    fireEvent.click(screen.getByText("+ New agent"));
    fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "Orbit" } });
    fireEvent.change(screen.getByLabelText("Agent role"), { target: { value: "Backend Engineer" } });
    fireEvent.change(screen.getByLabelText("Team"), { target: { value: "team-1" } });
    fireEvent.click(screen.getByText("Create agent"));

    await waitFor(() =>
      expect(apiClient.createAgent).toHaveBeenCalledWith({
        name: "Orbit",
        role: "Backend Engineer",
        team_id: "team-1",
        charter_md: "# Orbit",
        engine: { id: "fake" },
        default_workspace_ref: null,
      })
    );
  });

  it("renames a team via the edit control", async () => {
    const fixture: OrgView = {
      teams: [{ id: "team-1" as OrgViewTeam["id"], name: "Platform", status: "idle", agents: [] }],
      unassignedAgents: [],
    };
    vi.mocked(apiClient.getOrg).mockResolvedValue(fixture);
    vi.mocked(apiClient.patchTeam).mockResolvedValue({ id: "team-1", name: "Core Platform", description: "" });
    renderOrgView();

    await screen.findByText("Platform");
    fireEvent.click(screen.getByLabelText("Rename team"));
    fireEvent.change(screen.getByLabelText("Team name"), { target: { value: "Core Platform" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(apiClient.patchTeam).toHaveBeenCalledWith("team-1", { name: "Core Platform" }));
  });

  it("deletes a team after confirming, but not if the confirm is cancelled", async () => {
    const fixture: OrgView = {
      teams: [{ id: "team-1" as OrgViewTeam["id"], name: "Platform", status: "idle", agents: [] }],
      unassignedAgents: [],
    };
    vi.mocked(apiClient.getOrg).mockResolvedValue(fixture);
    vi.mocked(apiClient.deleteTeam).mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderOrgView();

    await screen.findByText("Platform");
    fireEvent.click(screen.getByText("Delete"));
    expect(confirmSpy).toHaveBeenCalled();
    expect(apiClient.deleteTeam).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Delete"));
    await waitFor(() => expect(apiClient.deleteTeam).toHaveBeenCalledWith("team-1"));

    confirmSpy.mockRestore();
  });

  it("hard-deletes an agent row after confirming", async () => {
    const fixture: OrgView = {
      teams: [],
      unassignedAgents: [
        {
          id: "a1" as OrgViewAgent["id"],
          name: "Loner",
          role: "Agent",
          team_id: null,
          state: "active",
          status: "blocked", // non-calm ⇒ the Unassigned bucket auto-expands, rendering the row
        },
      ],
    };
    vi.mocked(apiClient.getOrg).mockResolvedValue(fixture);
    vi.mocked(apiClient.deleteAgent).mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderOrgView();

    await screen.findByText("Loner");
    fireEvent.click(screen.getByLabelText("Delete agent Loner"));
    expect(apiClient.deleteAgent).not.toHaveBeenCalled(); // cancelled

    fireEvent.click(screen.getByLabelText("Delete agent Loner"));
    await waitFor(() => expect(apiClient.deleteAgent).toHaveBeenCalledWith("a1"));

    confirmSpy.mockRestore();
  });

  it("does not show rename/delete controls on the synthetic Unassigned bucket", async () => {
    const fixture: OrgView = {
      teams: [],
      unassignedAgents: [
        {
          id: "a1" as OrgViewAgent["id"],
          name: "Loner",
          role: "Agent",
          team_id: null,
          state: "active",
          status: "idle",
        },
      ],
    };
    vi.mocked(apiClient.getOrg).mockResolvedValue(fixture);
    renderOrgView();

    await screen.findByText("Unassigned");
    expect(screen.queryByText("✎")).toBeNull();
    expect(screen.queryByText("Delete")).toBeNull();
  });
});
