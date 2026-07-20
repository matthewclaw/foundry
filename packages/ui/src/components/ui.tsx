/**
 * Shared UI primitives — the app's single component vocabulary. Every view composes
 * these instead of hand-rolling `bg-gray-900 border border-gray-800 rounded-lg …`
 * strings, so spacing, colour, focus, and interaction stay consistent by construction.
 * The palette is the existing quiet-terminal one (Tailwind gray + terminal green),
 * just codified in one place.
 */
import type { ReactNode, ButtonHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes, SelectHTMLAttributes } from "react";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/* ------------------------------------------------------------------ status palette */

export type AgentStatus = "blocked" | "degraded" | "waiting" | "active" | "over-committed" | "idle";

/** One definition of what each status looks like: dot, pill classes, prose label, and
 * the doc-02 precedence rank (0 = worst). Badge classes keep the exact colour tokens the
 * status tests assert against. */
export const STATUS_META: Record<AgentStatus, { dot: string; badge: string; label: string; rank: number }> = {
  blocked: { dot: "bg-red-500", badge: "bg-red-900/40 text-red-300 ring-1 ring-red-500/30", label: "blocked", rank: 0 },
  degraded: { dot: "bg-orange-400", badge: "bg-orange-900/40 text-orange-300 ring-1 ring-orange-500/30", label: "degraded", rank: 1 },
  waiting: { dot: "bg-amber-400", badge: "bg-amber-900/40 text-amber-300 ring-1 ring-amber-500/30", label: "waiting", rank: 2 },
  active: { dot: "bg-green-400", badge: "bg-green-900/40 text-green-300 ring-1 ring-green-500/30", label: "active", rank: 3 },
  "over-committed": { dot: "bg-purple-400", badge: "bg-purple-900/40 text-purple-300 ring-1 ring-purple-500/30", label: "over-committed", rank: 4 },
  idle: { dot: "bg-gray-600", badge: "bg-gray-800 text-gray-400 ring-1 ring-gray-700/50", label: "idle", rank: 5 },
};

/** Small status dot — the at-a-glance signal used in the rail and dense lists. A subtle
 * pulse on `active` reads as "something is happening here right now". */
export function StatusDot({ status, className }: { status: AgentStatus; className?: string }) {
  const m = STATUS_META[status];
  return (
    <span className={cx("relative inline-flex h-2 w-2 flex-shrink-0", className)} title={m.label}>
      {status === "active" && (
        <span className={cx("absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping", m.dot)} />
      )}
      <span className={cx("relative inline-flex h-2 w-2 rounded-full", m.dot)} />
    </span>
  );
}

export function StatusBadge({ status }: { status: AgentStatus }) {
  const m = STATUS_META[status];
  return (
    <span className={cx("inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium", m.badge)}>
      <span className={cx("h-1.5 w-1.5 rounded-full", m.dot)} />
      {m.label}
    </span>
  );
}

/* ------------------------------------------------------------------------- buttons */

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
type ButtonSize = "sm" | "md";

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed select-none";
const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-green-600 text-white hover:bg-green-500 shadow-sm shadow-green-900/40",
  secondary: "border border-gray-700 text-gray-200 hover:bg-gray-800 hover:border-gray-600",
  danger: "border border-gray-700 text-gray-400 hover:text-red-300 hover:border-red-500/60 hover:bg-red-950/40",
  ghost: "text-gray-400 hover:text-gray-100 hover:bg-gray-800/70",
};
const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: "text-xs px-2.5 py-1",
  md: "text-sm px-3.5 py-1.5",
};

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button className={cx(BUTTON_BASE, BUTTON_VARIANT[variant], BUTTON_SIZE[size], className)} {...props} />;
}

/* ------------------------------------------------------------------------ surfaces */

export function Panel({
  className,
  children,
  testId,
}: {
  className?: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div data-testid={testId} className={cx("bg-gray-900/70 border border-gray-800 rounded-lg", className)}>
      {children}
    </div>
  );
}

/** A titled panel — the default building block for a page section. */
export function Section({
  title,
  actions,
  meta,
  bodyClassName,
  className,
  children,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
  bodyClassName?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Panel className={cx("mb-4", className)}>
      {(title || actions) && (
        <div className="flex items-center gap-3 px-4 py-2.5 border-b border-gray-800">
          {title && <h2 className="text-sm font-semibold text-gray-200">{title}</h2>}
          {meta}
          {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={cx("p-4", bodyClassName)}>{children}</div>
    </Panel>
  );
}

/** The top-of-view header: a restrained terminal prompt mark, the title, an optional
 * subtitle/breadcrumb slot, and right-aligned actions. Used by every page for a
 * consistent masthead. */
export function PageHeader({
  title,
  subtitle,
  breadcrumb,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  breadcrumb?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-5">
      {breadcrumb && <div className="mb-1.5 text-xs text-gray-500">{breadcrumb}</div>}
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-xl font-semibold text-gray-100">
            <span className="font-mono text-green-500 select-none" aria-hidden>
              ›
            </span>
            <span className="min-w-0 truncate">{title}</span>
          </h1>
          {subtitle && <div className="mt-1 text-sm text-gray-400">{subtitle}</div>}
        </div>
        {actions && <div className="flex flex-shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

/* --------------------------------------------------------------------------- chips */

/** A mono id chip — de-emphasised, click-to-nothing by default; pass `title` for the
 * full value on hover. Keeps ULIDs legible without letting them dominate. */
export function IdChip({ children, title, className }: { children: ReactNode; title?: string; className?: string }) {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex items-center font-mono text-[11px] leading-none px-1.5 py-1 rounded bg-gray-800/80 text-gray-400",
        className
      )}
    >
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------------- fields */

const FIELD_CLASS =
  "w-full rounded-md border border-gray-700 bg-gray-950/60 text-gray-100 placeholder-gray-600 px-3 py-2 text-sm transition-colors focus:outline-none focus:border-green-600 focus:bg-gray-950";

export function TextInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(FIELD_CLASS, className)} {...props} />;
}

export function TextArea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx(FIELD_CLASS, "resize-y", className)} {...props} />;
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cx(FIELD_CLASS, "appearance-none cursor-pointer", className)} {...props} />;
}

export function Label({ children }: { children: ReactNode }) {
  return <label className="block text-xs font-medium text-gray-400 mb-1">{children}</label>;
}

/* ---------------------------------------------------------------- state indicators */

/** Spinner glyph — an inline, currentColor-tinted ring. */
export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cx("animate-spin", className)} width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** Full-page-ish loading state used by every top-level view while its query resolves. */
export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 p-6 text-sm text-gray-500">
      <Spinner /> {label}
    </div>
  );
}

export function ErrorState({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="p-6">
      <Panel className="border-red-900/60 bg-red-950/30 p-4">
        <div className="text-sm font-medium text-red-300">Something went wrong</div>
        <div className="mt-1 font-mono text-xs text-red-400/90">{message}</div>
      </Panel>
    </div>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return <span className="text-xs text-red-400">{error instanceof Error ? error.message : String(error)}</span>;
}

/** A calm, centred empty state — an icon glyph, a headline, and an optional hint or CTA.
 * Replaces the scattered "None." / "Inbox is empty" one-liners. */
export function EmptyState({
  icon,
  title,
  hint,
  action,
  compact,
}: {
  icon?: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={cx("flex flex-col items-center justify-center text-center", compact ? "py-6" : "py-12")}>
      {icon && <div className="mb-3 text-gray-600" aria-hidden>{icon}</div>}
      <div className="text-sm font-medium text-gray-300">{title}</div>
      {hint && <div className="mt-1 max-w-sm text-xs text-gray-500">{hint}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/* --------------------------------------------------------------------------- icons */

/** A tiny inline-SVG icon set — enough for the app's chrome without pulling in a
 * dependency. All inherit `currentColor` and default to 16px. */
export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      {ICON_PATHS[name]}
    </svg>
  );
}

export type IconName =
  | "chevron-right"
  | "chevron-down"
  | "plus"
  | "arrow-left"
  | "inbox"
  | "coins"
  | "terminal"
  | "message"
  | "alert"
  | "check"
  | "sitemap"
  | "users"
  | "pencil"
  | "folder"
  | "sparkle";

const ICON_PATHS: Record<IconName, ReactNode> = {
  "chevron-right": <path d="m9 18 6-6-6-6" />,
  "chevron-down": <path d="m6 9 6 6 6-6" />,
  plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
  "arrow-left": <><path d="m12 19-7-7 7-7" /><path d="M19 12H5" /></>,
  inbox: <><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></>,
  coins: <><circle cx="8" cy="8" r="6" /><path d="M18.09 10.37A6 6 0 1 1 10.34 18" /><path d="M7 6h1v4" /><path d="m16.71 13.88.7.71-2.82 2.82" /></>,
  terminal: <><path d="m4 17 6-6-6-6" /><path d="M12 19h8" /></>,
  message: <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z" />,
  alert: <><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z" /><path d="M12 9v4" /><path d="M12 17h.01" /></>,
  check: <path d="M20 6 9 17l-5-5" />,
  sitemap: <><rect x="9" y="2" width="6" height="6" rx="1" /><rect x="2" y="16" width="6" height="6" rx="1" /><rect x="16" y="16" width="6" height="6" rx="1" /><path d="M12 8v4M5 16v-2a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v2" /></>,
  users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>,
  pencil: <><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></>,
  folder: <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />,
  sparkle: <path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4" />,
};
