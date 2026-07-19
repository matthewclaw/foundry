/**
 * Task tree view: renders delegation trees recursively, one row per task, indented by
 * depth. Highlights rejected/blocked tasks as escalation paths. Purely observational —
 * no cancel/raise-budget actions and no per-node workstream link yet (TreeNode lacks
 * workstream_id).
 */
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client.js";
import type { TreeNode, TaskState } from "../api/types.js";
import { ErrorState, Icon, IdChip, Loading, PageHeader, Panel } from "../components/ui.js";

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}
function formatTokens(value: number): string {
  return value.toLocaleString("en-US");
}

const TASK_STATE_BADGE: Record<TaskState, string> = {
  pending: "bg-gray-800 text-gray-400",
  in_progress: "bg-blue-900/40 text-blue-300 ring-1 ring-blue-500/30",
  blocked: "bg-red-900/40 text-red-300 ring-1 ring-red-500/30",
  delivered: "bg-green-900/40 text-green-300 ring-1 ring-green-500/30",
  done: "bg-green-900/40 text-green-300 ring-1 ring-green-500/30",
  rejected: "bg-red-900/40 text-red-300 ring-1 ring-red-500/30",
  cancelled: "bg-gray-800 text-gray-500",
};

function TaskBadge({ state }: { state: TaskState }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${TASK_STATE_BADGE[state]}`}>
      {state}
    </span>
  );
}

function BudgetMeter({
  spent_usd,
  limit_usd,
  spent_tokens,
  limit_tokens,
}: {
  spent_usd: number;
  limit_usd: number | null;
  spent_tokens: number;
  limit_tokens: number | null;
}) {
  return (
    <div className="flex gap-4 font-mono text-xs text-gray-400">
      <span>
        {formatUsd(spent_usd)} <span className="text-gray-600">/ {limit_usd === null ? "uncapped" : formatUsd(limit_usd)}</span>
      </span>
      <span>
        {formatTokens(spent_tokens)} <span className="text-gray-600">/ {limit_tokens === null ? "uncapped" : formatTokens(limit_tokens)}</span>
      </span>
    </div>
  );
}

const isEscalationPath = (state: TaskState) => state === "rejected" || state === "blocked";

function TaskRow({ node }: { node: TreeNode }) {
  const { task } = node;
  const indentPx = task.depth * 22;
  const isEscalation = isEscalationPath(task.state);

  return (
    <>
      <div
        className={`border-b border-gray-800/70 p-4 ${isEscalation ? "border-l-2 border-l-red-500 bg-red-900/20" : ""}`}
        style={{ paddingLeft: `${16 + indentPx}px` }}
      >
        <div className="mb-2 flex items-center gap-2">
          {task.depth > 0 && <Icon name="chevron-right" size={12} className="text-gray-600" />}
          <TaskBadge state={task.state} />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-100">
            {task.spec_md.split("\n")[0] || "Untitled"}
          </span>
          <IdChip title={task.id}>{task.id}</IdChip>
        </div>
        <BudgetMeter
          spent_usd={task.budget.spent_usd}
          limit_usd={task.budget.limit_usd}
          spent_tokens={task.budget.spent_tokens}
          limit_tokens={task.budget.limit_tokens}
        />
        <div className="mt-1.5 text-xs text-gray-500">
          {task.delegator_actor_id} → {task.assignee_agent_id} · {new Date(task.created_at).toLocaleString()}
          {task.rejection_count > 0 && <span className="ml-2 text-red-400">rejected {task.rejection_count}×</span>}
        </div>
      </div>
      {node.children.map((child) => (
        <TaskRow key={child.task.id} node={child} />
      ))}
    </>
  );
}

export default function TaskTreeView() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useQuery({
    queryKey: ["taskTree", id],
    queryFn: () => apiClient.getTaskTree(id!),
    enabled: !!id,
  });

  if (isLoading) return <Loading label="Loading task tree…" />;
  if (error) return <ErrorState error={error} />;
  if (!data || data.root === undefined) {
    return (
      <div className="p-6">
        <PageHeader title="Delegation tree" />
        <Panel className="p-6 text-sm text-gray-500">Task not found.</Panel>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <PageHeader title="Delegation tree" subtitle="A root task and everything delegated beneath it." />
      <Panel className="overflow-hidden">
        <TaskRow node={data.root} />
      </Panel>
    </div>
  );
}
