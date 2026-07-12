/**
 * E10.2 — Task tree view: renders delegation trees recursively, one row per task,
 * indented by depth. Highlights rejected/blocked tasks as escalation paths.
 * NOTE: Task IDs shown as plain text since TreeNode lacks workstream_id
 * (would need store projection change or separate lookup for workstream links).
 * Cancel/raise-budget actions deferred (require live workstream context).
 */
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client.js";
import type { TaskDto, TreeNode, TaskState } from "../api/types.js";

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatTokens(value: number): string {
  return value.toLocaleString("en-US");
}

const TASK_STATE_BADGE: Record<TaskState, { classes: string }> = {
  pending: { classes: "bg-gray-100 text-gray-700" },
  in_progress: { classes: "bg-blue-100 text-blue-800" },
  blocked: { classes: "bg-red-100 text-red-800" },
  delivered: { classes: "bg-green-100 text-green-800" },
  done: { classes: "bg-green-100 text-green-800" },
  rejected: { classes: "bg-red-100 text-red-800" },
  cancelled: { classes: "bg-gray-100 text-gray-700" },
};

function TaskBadge({ state }: { state: TaskState }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${TASK_STATE_BADGE[state].classes}`}>
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
  const usdLimitText = limit_usd === null ? "uncapped" : formatUsd(limit_usd);
  const tokensLimitText = limit_tokens === null ? "uncapped" : formatTokens(limit_tokens);

  return (
    <div className="flex gap-4 text-xs text-gray-600">
      <span>{formatUsd(spent_usd)} / {usdLimitText}</span>
      <span>{formatTokens(spent_tokens)} / {tokensLimitText}</span>
    </div>
  );
}

const isEscalationPath = (state: TaskState) => state === "rejected" || state === "blocked";

function TaskRow({ node }: { node: TreeNode }) {
  const { task } = node;
  const indentPx = task.depth * 24;
  const isEscalation = isEscalationPath(task.state);

  return (
    <>
      <div
        className={`border-b border-gray-100 p-4 ${
          isEscalation ? "bg-red-50 border-l-4 border-l-red-400" : ""
        }`}
        style={{ paddingLeft: `${12 + indentPx}px` }}
      >
        <div className="flex items-start gap-3 mb-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <TaskBadge state={task.state} />
              <span className="text-xs font-mono text-gray-500">{task.id}</span>
            </div>
            <div className="text-sm text-gray-700 font-medium truncate">{task.spec_md.split("\n")[0] || "Untitled"}</div>
          </div>
        </div>

        <BudgetMeter
          spent_usd={task.budget.spent_usd}
          limit_usd={task.budget.limit_usd}
          spent_tokens={task.budget.spent_tokens}
          limit_tokens={task.budget.limit_tokens}
        />

        <div className="text-xs text-gray-500 mt-1">
          Delegated by {task.delegator_actor_id} to {task.assignee_agent_id} · created {task.created_at}
          {task.rejection_count > 0 && <span className="ml-2 text-red-600">rejected {task.rejection_count}×</span>}
        </div>
      </div>

      {/* Render children recursively */}
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

  if (isLoading) return <div className="p-6 text-gray-500">Loading task tree…</div>;
  if (error)
    return <div className="p-6 text-red-600">Error: {error instanceof Error ? error.message : String(error)}</div>;
  if (!data || data.root === undefined)
    return <div className="p-6 text-gray-500">Task not found.</div>;

  return (
    <div className="p-6 max-w-4xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Task Tree</h1>
      <p className="text-sm text-gray-600 mb-6">Root: {data.root.task.id}</p>

      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <TaskRow node={data.root} />
      </div>
    </div>
  );
}
