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
import Inbox from "./views/Inbox.js";
import "./index.css";

const queryClient = new QueryClient();

const railLink = ({ isActive }: { isActive: boolean }) =>
  `block px-3 py-1.5 rounded text-sm ${
    isActive ? "bg-blue-100 text-blue-900 font-medium" : "text-gray-700 hover:bg-gray-200"
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
    <nav className="w-64 bg-gray-100 border-r border-gray-200 flex flex-col flex-shrink-0">
      <div className="p-4 border-b border-gray-200">
        <NavLink to="/" className="text-lg font-bold text-gray-900">
          Foundry
        </NavLink>
      </div>
      <div className="flex-1 overflow-auto p-3 space-y-5">
        <NavLink to="/inbox" className={railLink}>
          Inbox
        </NavLink>
        {org?.teams.map((team: OrgViewTeam) => (
          <div key={team.id}>
            <h2 className="px-3 py-1 text-xs font-semibold text-gray-500 uppercase">{team.name}</h2>
            <AgentLinks agents={team.agents} />
          </div>
        ))}
        {org && org.unassignedAgents.length > 0 && (
          <div>
            <h2 className="px-3 py-1 text-xs font-semibold text-gray-500 uppercase">Unassigned</h2>
            <AgentLinks agents={org.unassignedAgents} />
          </div>
        )}
      </div>
    </nav>
  );
}

function Layout() {
  useEventFeed(queryClient);
  return (
    <div className="flex h-screen">
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
            <Route path="/inbox" element={<Inbox />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
