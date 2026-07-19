/**
 * E10.1 — Real inbox: approval_pending items (higher severity) first,
 * then message_surfaced. Sorted by severity, then age (oldest first).
 * Inline Grant/Deny actions for approvals; messages (future capability).
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { parseRef } from "@foundry/core";
import { apiClient } from "../api/client.js";
import type { InboxItem } from "../api/types.js";

/** Sort items: approval_pending first (higher severity), then by age (oldest first). */
export function sortInboxItems(items: InboxItem[]): InboxItem[] {
  return [...items].sort((a, b) => {
    const severityOrder = { approval_pending: 0, message_surfaced: 1 };
    const severityDiff = severityOrder[a.kind] - severityOrder[b.kind];
    if (severityDiff !== 0) return severityDiff;
    // Same severity: oldest first (ascending date)
    return a.created_at.localeCompare(b.created_at);
  });
}

function ApprovalItem({ item }: { item: InboxItem }) {
  const queryClient = useQueryClient();
  const [denyPrompt, setDenyPrompt] = useState(false);

  const grant = useMutation({
    mutationFn: () => {
      const { id } = parseRef(item.ref);
      return apiClient.grantApproval(id);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["inbox"] });
    },
  });

  const deny = useMutation({
    mutationFn: (reason?: string) => {
      const { id } = parseRef(item.ref);
      return apiClient.denyApproval(id, reason);
    },
    onSuccess: () => {
      setDenyPrompt(false);
      void queryClient.invalidateQueries({ queryKey: ["inbox"] });
    },
  });

  const handleDenyClick = () => {
    const reason = window.prompt("Deny approval. Reason (optional):", "");
    if (reason !== null) {
      deny.mutate(reason || undefined);
    }
  };

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-2">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="text-sm text-gray-100 font-semibold">{item.summary}</div>
          <div className="text-xs text-gray-500 mt-1">
            {item.created_at}
          </div>
        </div>
        <div className="flex gap-2 flex-shrink-0">
          <button
            className="px-3 py-1 rounded bg-green-700 hover:bg-green-600 text-white text-sm disabled:opacity-50"
            disabled={grant.isPending || deny.isPending}
            onClick={() => grant.mutate()}
          >
            {grant.isPending ? "…" : "Grant"}
          </button>
          <button
            className="px-3 py-1 rounded bg-red-600 text-white text-sm disabled:opacity-50"
            disabled={grant.isPending || deny.isPending}
            onClick={handleDenyClick}
          >
            {deny.isPending ? "…" : "Deny"}
          </button>
        </div>
      </div>
      {(grant.error || deny.error) && (
        <div className="text-sm text-red-400 mt-2">
          {grant.error instanceof Error ? grant.error.message : ""}
          {deny.error instanceof Error ? deny.error.message : ""}
        </div>
      )}
    </div>
  );
}

function MessageItem({ item }: { item: InboxItem }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-2">
      <div className="text-sm text-gray-100">{item.summary}</div>
      <div className="text-xs text-gray-500 mt-1">
        {item.created_at}
      </div>
      {/* ponytail: answer/accept/reject/reassign actions need richer message-disposition
          data than this InboxItem projection carries yet; defer until message_surfaced
          items include thread/type/disposition info. */}
    </div>
  );
}

export default function Inbox() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["inbox"],
    queryFn: apiClient.getInbox,
  });

  if (isLoading) return <div className="p-6 text-gray-500">Loading inbox…</div>;
  if (error)
    return <div className="p-6 text-red-400">Error: {error instanceof Error ? error.message : String(error)}</div>;
  if (!data || data.length === 0)
    return <div className="p-6 text-gray-500">Inbox is empty — nothing needs you.</div>;

  const sorted = sortInboxItems(data);

  return (
    <div className="p-6 max-w-2xl">
      <h1 className="text-2xl font-bold text-gray-100 mb-4"><span className="text-green-500">$</span> Inbox</h1>
      <div>
        {sorted.map((item: InboxItem) =>
          item.kind === "approval_pending" ? (
            <ApprovalItem key={item.ref} item={item} />
          ) : (
            <MessageItem key={item.ref} item={item} />
          )
        )}
      </div>
    </div>
  );
}
