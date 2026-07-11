/** E7.1 — placeholder for E7.3: render the agentPage projection JSON crudely. */
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client.js";

export default function AgentPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useQuery({
    queryKey: ["agent", id],
    queryFn: () => apiClient.getAgent(id!),
    enabled: !!id,
  });

  if (isLoading) return <div className="p-6 text-gray-500">Loading agent…</div>;
  if (error)
    return <div className="p-6 text-red-600">Error: {error instanceof Error ? error.message : String(error)}</div>;

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold text-gray-900 mb-4">Agent {id}</h1>
      <pre className="bg-gray-50 border border-gray-200 rounded p-4 text-xs overflow-x-auto">
        {JSON.stringify(data, null, 2)}
      </pre>
    </div>
  );
}
