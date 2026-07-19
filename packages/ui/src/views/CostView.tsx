/**
 * E10.3 — Cost view: org-wide spend by default. Shows spent vs limit (USD and tokens)
 * with a breakdown table. ponytail: no "unreported" capability-degraded indicator yet
 * (needs CostBreakdownEntry-level capability flag from future store change).
 */
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client.js";
import type { CostReport } from "../api/types.js";

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatTokens(value: number): string {
  // Explicit locale: toLocaleString() with no argument follows the runtime's default
  // locale, which isn't guaranteed to be a comma-separated one (this environment's
  // Node build renders "5 000 000", not "5,000,000", with no locale pinned).
  return value.toLocaleString("en-US");
}

function StatBlock({
  label,
  spent,
  limit,
  format,
}: {
  label: string;
  spent: number;
  limit: number | null;
  format: (value: number) => string;
}) {
  const limitText = limit === null ? "uncapped" : format(limit);
  const percentage = limit === null ? 0 : Math.min(100, (spent / limit) * 100);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-4">
      <div className="flex justify-between items-baseline mb-2">
        <h2 className="font-semibold text-gray-100">{label}</h2>
        <span className="text-sm text-gray-400">
          {format(spent)} / {limitText}
        </span>
      </div>
      {limit !== null && (
        <div className="w-full bg-gray-800 rounded-full h-2">
          <div
            className={`h-2 rounded-full transition-all ${
              percentage > 80 ? "bg-red-600" : percentage > 50 ? "bg-amber-600" : "bg-green-600"
            }`}
            style={{ width: `${percentage}%` }}
          />
        </div>
      )}
      {limit === null && <div className="text-xs text-gray-500">No limit set</div>}
    </div>
  );
}

function CostBreakdownTable({ breakdown }: { breakdown: CostReport["breakdown"] }) {
  if (breakdown.length === 0) {
    return <p className="text-sm text-gray-500">No spend recorded yet.</p>;
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-800">
            <th className="text-left py-2 px-2 font-semibold text-gray-500">Label</th>
            <th className="text-right py-2 px-2 font-semibold text-gray-500">USD Spent</th>
            <th className="text-right py-2 px-2 font-semibold text-gray-500">Tokens Spent</th>
          </tr>
        </thead>
        <tbody>
          {breakdown.map((row, idx) => (
            <tr key={idx} className="border-b border-gray-800 hover:bg-gray-800/50">
              <td className="py-2 px-2 text-gray-100">{row.label}</td>
              <td className="py-2 px-2 text-right text-gray-200">{formatUsd(row.spent_usd)}</td>
              <td className="py-2 px-2 text-right text-gray-200">{formatTokens(row.spent_tokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function CostView() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["cost"],
    queryFn: () => apiClient.getCost(),
  });

  if (isLoading) return <div className="p-6 text-gray-500">Loading cost…</div>;
  if (error)
    return <div className="p-6 text-red-400">Error: {error instanceof Error ? error.message : String(error)}</div>;
  if (!data) return null;

  return (
    <div className="p-6 max-w-3xl">
      <h1 className="text-2xl font-bold text-gray-100 mb-1">
        <span className="text-green-500">$</span> Cost
      </h1>
      <p className="text-sm text-gray-400 mb-6">
        Org-wide spend and limits
      </p>

      <StatBlock label="USD Spent" spent={data.spent_usd} limit={data.limit_usd} format={formatUsd} />
      <StatBlock label="Tokens Spent" spent={data.spent_tokens} limit={data.limit_tokens} format={formatTokens} />

      <div className="mt-6">
        <h2 className="font-semibold text-gray-100 mb-4">Breakdown</h2>
        <CostBreakdownTable breakdown={data.breakdown} />
      </div>
    </div>
  );
}
