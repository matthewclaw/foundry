/**
 * E7.1 — SPA shell: QueryClient + router + left-rail navigation.
 * "Agents are the navigation objects" (doc-06): the left rail is teams → agents
 * from GET /api/org, not a file tree. Routes: "/" org view, "/agents/:id", "/inbox".
 */
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
import type { OrgViewAgent, OrgViewTeam } from "./api/types.js";
import OrgView from "./views/OrgView.js";
import AgentPage from "./views/AgentPage.js";
import WorkstreamView from "./views/WorkstreamView.js";
import Inbox from "./views/Inbox.js";
import CostView from "./views/CostView.js";
import TaskTreeView from "./views/TaskTreeView.js";
import ClaudeSessionsView from "./views/ClaudeSessionsView.js";
import "./index.css";

const queryClient = new QueryClient();

const railLink = ({ isActive }: { isActive: boolean }) =>
  `block px-3 py-1.5 rounded text-sm ${isActive ? "bg-gray-800 text-green-400 font-medium" : "text-gray-400 hover:bg-gray-900 hover:text-gray-200"
  }`;

function AgentLinks({ agents }: { agents: OrgViewAgent[] }) {
  return (
    <div className="space-y-0.5">
      {agents.map((agent) => (
        <NavLink key={agent.id} to={`/agents/${agent.id}`} className={railLink}>
          {agent.name}
        </NavLink>
      ))}
    </div>
  );
}

function LeftRail() {
  const { data: org } = useQuery({ queryKey: ["org"], queryFn: apiClient.getOrg });

  return (
    <nav className="w-64 bg-gray-950 border-r border-gray-800 flex flex-col flex-shrink-0">
      <div className="p-4 border-b border-gray-800">
        <NavLink to="/" className="text-lg font-bold text-green-400">
          <span className="text-gray-500">$</span> Foundry
        </NavLink>
      </div>
      <div className="flex-1 overflow-auto p-3 space-y-5 ">
        <details className="">
          <summary className="py-1 font-semibold text-gray-600 uppercase">System</summary>
          <NavLink to="/inbox" className={railLink}>
            Inbox
          </NavLink>
          <NavLink to="/cost" className={railLink}>
            Cost
          </NavLink>
          <NavLink to="/claude-sessions" className={railLink}>
            Claude Sessions
          </NavLink>
        </details>
        <details>
          <summary className="py-1 font-semibold text-gray-600 uppercase">Organization</summary>
          {org?.teams && org.teams.map((team: OrgViewTeam) => (
            <details key={team.id} className="">
              <summary className="px-2 py-1 text-xs font-semibold text-gray-600 uppercase">{team.name}</summary>
              <div className="space-y-0.5 px-3">
              <AgentLinks agents={team.agents} /></div>
            </details>
          ))}
          {org && org.unassignedAgents.length > 0 && (
            < details className="">
              <summary className="px-2 py-1 text-xs font-semibold text-gray-600 uppercase">Unassigned</summary>
              <div className="space-y-0.5 px-3">
              <AgentLinks agents={org.unassignedAgents} />
              </div>
            </details>
          )}
        </details>
      </div>
    </nav>
  );
}

function Layout() {
  useEventFeed(queryClient);
  return (
    <div className="flex h-screen bg-gray-950 text-gray-300">
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
