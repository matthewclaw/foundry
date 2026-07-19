/**
 * SPA shell: QueryClient + router + left-rail navigation.
 * "Agents are the navigation objects" (doc-06): the rail is teams → agents from
 * GET /api/org, each carrying a live status dot, so organizational health is legible
 * without opening anything. System views (Inbox/Cost/Sessions) sit above the org tree.
 */
import { useState } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  NavLink,
  Outlet,
} from "react-router-dom";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { apiClient } from "./api/client.js";
import { useEventFeed } from "./api/sse.js";
import type { InboxItem, OrgViewAgent, OrgViewTeam } from "./api/types.js";
import { Icon, StatusDot, cx, type AgentStatus } from "./components/ui.js";
import OrgView from "./views/OrgView.js";
import AgentPage from "./views/AgentPage.js";
import WorkstreamView from "./views/WorkstreamView.js";
import Inbox from "./views/Inbox.js";
import CostView from "./views/CostView.js";
import TaskTreeView from "./views/TaskTreeView.js";
import ClaudeSessionsView from "./views/ClaudeSessionsView.js";
import "./index.css";

const queryClient = new QueryClient();

const WORST_FIRST: Record<AgentStatus, number> = {
  blocked: 0, degraded: 1, waiting: 2, active: 3, "over-committed": 4, idle: 5,
};
const worst = (agents: OrgViewAgent[]): AgentStatus =>
  agents.reduce<AgentStatus>((w, a) => (WORST_FIRST[a.status] < WORST_FIRST[w] ? a.status : w), "idle");

function NavItem({ to, icon, label, badge }: { to: string; icon: React.ReactNode; label: string; badge?: number }) {
  return (
    <NavLink
      to={to}
      end
      className={({ isActive }) =>
        cx(
          "flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm transition-colors",
          isActive ? "bg-gray-800 text-gray-100" : "text-gray-400 hover:bg-gray-800/60 hover:text-gray-200"
        )
      }
    >
      {({ isActive }) => (
        <>
          <span className={isActive ? "text-green-400" : "text-gray-500"}>{icon}</span>
          <span className="flex-1">{label}</span>
          {badge !== undefined && badge > 0 && (
            <span className="min-w-5 rounded-full bg-amber-500/20 px-1.5 py-0.5 text-center text-[11px] font-semibold text-amber-300 ring-1 ring-amber-500/30">
              {badge}
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}

function AgentLink({ agent }: { agent: OrgViewAgent }) {
  return (
    <NavLink
      to={`/agents/${agent.id}`}
      className={({ isActive }) =>
        cx(
          "flex items-center gap-2.5 px-2.5 py-1 rounded-md text-sm transition-colors",
          isActive ? "bg-gray-800 text-green-300" : "text-gray-400 hover:bg-gray-800/60 hover:text-gray-200"
        )
      }
    >
      <StatusDot status={agent.status} />
      <span className="truncate">{agent.name}</span>
    </NavLink>
  );
}

function TeamGroup({ name, agents }: { name: string; agents: OrgViewAgent[] }) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-1.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-300"
      >
        <Icon name={open ? "chevron-down" : "chevron-right"} size={12} className="text-gray-600" />
        <StatusDot status={worst(agents)} />
        <span className="truncate">{name}</span>
        <span className="ml-auto font-normal normal-case text-gray-600">{agents.length}</span>
      </button>
      {open && (
        <div className="mt-0.5 space-y-0.5 pl-3">
          {agents.length === 0 ? (
            <div className="px-2.5 py-1 text-xs text-gray-600">no agents</div>
          ) : (
            agents.map((a) => <AgentLink key={a.id} agent={a} />)
          )}
        </div>
      )}
    </div>
  );
}

function LeftRail() {
  const { data: org } = useQuery({ queryKey: ["org"], queryFn: apiClient.getOrg });
  const { data: inbox } = useQuery({ queryKey: ["inbox"], queryFn: apiClient.getInbox });
  const attention = (inbox ?? []).filter((i: InboxItem) => i.kind === "approval_pending").length;

  return (
    <nav className="flex w-64 flex-shrink-0 flex-col border-r border-gray-800 bg-gray-950">
      <div className="flex items-center gap-2 border-b border-gray-800 px-4 py-3.5">
        <NavLink to="/" className="flex items-center gap-2 text-base font-semibold tracking-tight text-gray-100">
          <span className="font-mono text-green-500">›_</span> Foundry
        </NavLink>
      </div>

      <div className="flex-1 space-y-6 overflow-auto px-3 py-4">
        <div className="space-y-0.5">
          <NavItem to="/" icon={<Icon name="sitemap" size={16} />} label="Organization" />
          <NavItem to="/inbox" icon={<Icon name="inbox" size={16} />} label="Inbox" badge={attention} />
          <NavItem to="/cost" icon={<Icon name="coins" size={16} />} label="Cost" />
          <NavItem to="/claude-sessions" icon={<Icon name="terminal" size={16} />} label="Claude Sessions" />
        </div>

        <div className="space-y-1.5">
          <div className="px-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-600">Teams</div>
          {org?.teams?.map((team: OrgViewTeam) => (
            <TeamGroup key={team.id} name={team.name} agents={team.agents} />
          ))}
          {org && org.unassignedAgents.length > 0 && (
            <TeamGroup name="Unassigned" agents={org.unassignedAgents} />
          )}
          {org && org.teams.length === 0 && org.unassignedAgents.length === 0 && (
            <div className="px-2.5 py-1 text-xs text-gray-600">No agents yet.</div>
          )}
        </div>
      </div>
    </nav>
  );
}

function Layout() {
  useEventFeed(queryClient);
  return (
    <div className="flex h-screen bg-[var(--bg)] text-gray-300">
      <LeftRail />
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<OrgView />} />
            <Route path="/agents/:id" element={<AgentPage />} />
            <Route path="/workstreams/:id" element={<WorkstreamView />} />
            <Route path="/tasks/:id/tree" element={<TaskTreeView />} />
            <Route path="/inbox" element={<Inbox />} />
            <Route path="/cost" element={<CostView />} />
            <Route path="/claude-sessions" element={<ClaudeSessionsView />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
