/**
 * Real inbox: approval_pending items (higher severity) first, then message_surfaced,
 * sorted by severity then age (oldest first). Approvals carry inline Grant/Deny; surfaced
 * messages are read-only notices (the projection doesn't yet carry enough to act on them).
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { parseRef } from "@foundry/core";
import { apiClient } from "../api/client.js";
import type { InboxItem } from "../api/types.js";
import { Button, EmptyState, ErrorState, ErrorText, Icon, Loading, PageHeader, Panel } from "../components/ui.js";

/** Sort items: approval_pending first (higher severity), then by age (oldest first). */
export function sortInboxItems(items: InboxItem[]): InboxItem[] {
  return [...items].sort((a, b) => {
    const severityOrder = { approval_pending: 0, message_surfaced: 1 };
    const severityDiff = severityOrder[a.kind] - severityOrder[b.kind];
    if (severityDiff !== 0) return severityDiff;
    return a.created_at.localeCompare(b.created_at); // same severity: oldest first
  });
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function ApprovalItem({ item }: { item: InboxItem }) {
  const queryClient = useQueryClient();
  const grant = useMutation({
    mutationFn: () => apiClient.grantApproval(parseRef(item.ref).id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["inbox"] }),
  });
  const deny = useMutation({
    mutationFn: (reason?: string) => apiClient.denyApproval(parseRef(item.ref).id, reason),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["inbox"] }),
  });

  const handleDeny = () => {
    const reason = window.prompt("Deny approval. Reason (optional):", "");
    if (reason !== null) deny.mutate(reason || undefined);
  };

  const pending = grant.isPending || deny.isPending;

  return (
    <Panel className="mb-2 border-l-2 border-l-amber-500/70 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2">
            <span className="rounded bg-amber-900/40 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300 ring-1 ring-amber-500/30">
              Approval
            </span>
            <span className="text-xs text-gray-500" title={item.created_at}>{timeAgo(item.created_at)}</span>
          </div>
          <div className="text-sm font-medium text-gray-100">{item.summary}</div>
        </div>
        <div className="flex flex-shrink-0 gap-2">
          <Button variant="primary" size="sm" disabled={pending} onClick={() => grant.mutate()}>
            {grant.isPending ? "…" : <><Icon name="check" size={13} /> Grant</>}
          </Button>
          <Button variant="danger" size="sm" disabled={pending} onClick={handleDeny}>
            {deny.isPending ? "…" : "Deny"}
          </Button>
        </div>
      </div>
      {(grant.error || deny.error) && (
        <div className="mt-2">
          <ErrorText error={grant.error ?? deny.error} />
        </div>
      )}
    </Panel>
  );
}

function MessageItem({ item }: { item: InboxItem }) {
  return (
    <Panel className="mb-2 p-4">
      <div className="mb-1 flex items-center gap-2">
        <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
          Notice
        </span>
        <span className="text-xs text-gray-500" title={item.created_at}>{timeAgo(item.created_at)}</span>
      </div>
      <div className="text-sm text-gray-200">{item.summary}</div>
      {/* ponytail: answer/accept/reject/reassign actions need richer message-disposition
          data than this InboxItem projection carries yet; defer until message_surfaced
          items include thread/type/disposition info. */}
    </Panel>
  );
}

export default function Inbox() {
  const { data, isLoading, error } = useQuery({ queryKey: ["inbox"], queryFn: apiClient.getInbox });

  if (isLoading) return <Loading label="Loading inbox…" />;
  if (error) return <ErrorState error={error} />;

  const sorted = sortInboxItems(data ?? []);
  const approvals = sorted.filter((i) => i.kind === "approval_pending").length;

  return (
    <div className="mx-auto max-w-2xl p-6">
      <PageHeader
        title="Inbox"
        subtitle={
          approvals > 0
            ? `${approvals} approval${approvals === 1 ? "" : "s"} awaiting your decision`
            : "Everything that needs a human, most urgent first."
        }
      />
      {sorted.length === 0 ? (
        <Panel>
          <EmptyState
            icon={<Icon name="check" size={28} />}
            title="You're all caught up."
            hint="Approvals and surfaced messages that need your attention will land here."
          />
        </Panel>
      ) : (
        sorted.map((item) =>
          item.kind === "approval_pending" ? (
            <ApprovalItem key={item.ref} item={item} />
          ) : (
            <MessageItem key={item.ref} item={item} />
          )
        )
      )}
    </div>
  );
}
