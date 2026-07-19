/**
 * Cost view: org-wide spend by default. Shows spent vs limit (USD and tokens) with a
 * breakdown table.
 *
 * Honesty note: today these figures reflect budgets as set at creation time, not live
 * token usage — the runtime doesn't yet fold real usage back into persisted spend
 * (OPEN_ISSUES #39). That gap is surfaced to the user rather than hidden, since cost
 * legibility is the whole point of the system.
 */
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client.js";
import type { CostReport } from "../api/types.js";
import { ErrorState, Icon, Loading, PageHeader, Panel, Section } from "../components/ui.js";

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatTokens(value: number): string {
  // Explicit locale: toLocaleString() with no argument follows the runtime default, which
  // isn't guaranteed to be comma-separated (this Node build renders "5 000 000").
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
  const percentage = limit === null ? 0 : Math.min(100, (spent / limit) * 100);
  const barColor = percentage > 80 ? "bg-red-500" : percentage > 50 ? "bg-amber-500" : "bg-green-500";

  return (
    <Panel className="flex-1 p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="font-mono text-2xl font-semibold text-gray-100">{format(spent)}</span>
        <span className="text-sm text-gray-500">/ {limit === null ? "uncapped" : format(limit)}</span>
      </div>
      {limit !== null ? (
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-gray-800">
          <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${percentage}%` }} />
        </div>
      ) : (
        <div className="mt-3 text-xs text-gray-600">No limit set</div>
      )}
    </Panel>
  );
}

function CostBreakdownTable({ breakdown }: { breakdown: CostReport["breakdown"] }) {
  if (breakdown.length === 0) {
    return <p className="text-sm text-gray-500">No spend recorded yet.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-800 text-xs uppercase tracking-wide text-gray-500">
            <th className="px-2 py-2 text-left font-medium">Label</th>
            <th className="px-2 py-2 text-right font-medium">USD spent</th>
            <th className="px-2 py-2 text-right font-medium">Tokens spent</th>
          </tr>
        </thead>
        <tbody>
          {breakdown.map((row, idx) => (
            <tr key={idx} className="border-b border-gray-800/60 hover:bg-gray-800/40">
              <td className="px-2 py-2 text-gray-100">{row.label}</td>
              <td className="px-2 py-2 text-right font-mono text-gray-200">{formatUsd(row.spent_usd)}</td>
              <td className="px-2 py-2 text-right font-mono text-gray-200">{formatTokens(row.spent_tokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function CostView() {
  const { data, isLoading, error } = useQuery({ queryKey: ["cost"], queryFn: () => apiClient.getCost() });

  if (isLoading) return <Loading label="Loading cost…" />;
  if (error) return <ErrorState error={error} />;
  if (!data) return null;

  return (
    <div className="mx-auto max-w-3xl p-6">
      <PageHeader title="Cost" subtitle="Org-wide spend and budget usage." />

      <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-800/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-300/90">
        <Icon name="alert" size={14} className="mt-0.5 flex-shrink-0" />
        <span>
          These figures reflect budgets as configured, not yet live token usage — the runtime doesn't fold real spend
          back in yet (tracked as OPEN_ISSUES&nbsp;#39).
        </span>
      </div>

      <div className="mb-4 flex flex-col gap-4 sm:flex-row">
        <StatBlock label="USD Spent" spent={data.spent_usd} limit={data.limit_usd} format={formatUsd} />
        <StatBlock label="Tokens Spent" spent={data.spent_tokens} limit={data.limit_tokens} format={formatTokens} />
      </div>

      <Section title="Breakdown">
        <CostBreakdownTable breakdown={data.breakdown} />
      </Section>
    </div>
  );
}
