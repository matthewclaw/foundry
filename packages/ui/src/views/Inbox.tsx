/** E7.1 — placeholder inbox: list items crudely (full inbox is E10). */
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client.js";
import type { InboxItem } from "../api/types.js";

export default function Inbox() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["inbox"],
    queryFn: apiClient.getInbox,
  });

  if (isLoading) return <div className="p-6 text-gray-500">Loading inbox…</div>;
  if (error)
    return <div className="p-6 text-red-600">Error: {error instanceof Error ? error.message : String(error)}</div>;
  if (!data || data.length === 0)
    return <div className="p-6 text-gray-500">Inbox is empty — nothing needs you.</div>;

  return (
    <div className="p-6 max-w-2xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-4">Inbox</h1>
      <div className="space-y-2">
        {data.map((item: InboxItem) => (
          <div key={item.ref} className="bg-white border border-gray-200 rounded-lg p-4">
            <div className="text-sm text-gray-900">{item.summary}</div>
            <div className="text-xs text-gray-500 mt-1">
              {item.kind} · {item.ref} · {item.created_at}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
