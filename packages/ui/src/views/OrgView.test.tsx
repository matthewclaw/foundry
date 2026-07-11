/**
 * E7.2 tests: statusBadge precedence (doc-02) + OrgView rendering a 200-agent
 * fixture with exception-first ordering.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OrgView, OrgViewAgent, OrgViewTeam, AgentStatus } from "../api/types.js";
import OrgViewComponent, { statusBadge } from "./OrgView.js";

vi.mock("../api/client.js", () => ({
  apiClient: { getOrg: vi.fn() },
}));
import { apiClient } from "../api/client.js";

const PRECEDENCE: AgentStatus[] = ["blocked", "degraded", "waiting", "active", "over-committed", "idle"];

describe("statusBadge", () => {
  it("maps all six statuses to the right Tailwind classes", () => {
    expect(statusBadge("blocked").classes).toContain("bg-red-100");
    expect(statusBadge("degraded").classes).toContain("bg-orange-100");
    expect(statusBadge("waiting").classes).toContain("bg-amber-100");
    expect(statusBadge("active").classes).toContain("bg-green-100");
    expect(statusBadge("over-committed").classes).toContain("bg-purple-100");
    expect(statusBadge("idle").classes).toContain("bg-gray-100");
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
      <OrgViewComponent />
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
});
