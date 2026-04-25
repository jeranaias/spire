/**
 * CollapsiblePanel — Track-G2 progressive disclosure wrapper.
 *
 * Wraps a panel header + body with a `▾` toggle. Default-collapsed shows
 * only the header (hero metric + 1-line summary supplied by the caller).
 * Expanded shows the full panel content. State persists per role in
 * localStorage at `spire.panel.{view}.{panel}.collapsed.{role}` so the
 * Maintenance Chief landing fresh on PULSE/Forecast doesn't re-see the
 * Recommended-Actions wall every visit.
 *
 * Roles can specify a different default-collapsed-state via the
 * `defaultCollapsedFor` map: e.g. Maintenance Chief lands with
 * RecommendActions collapsed, Security Manager lands with FusedThreats
 * already expanded, MEF Commander gets FusedThreats collapsed by default.
 *
 * Override is local only. The TopBar density toggle and role-shaped
 * defaults stay separate concerns.
 */
import { useEffect, useState } from "react";
import clsx from "clsx";
import { useSpireStore, type Role } from "../state/store";

export interface CollapsiblePanelProps {
  /** Stable view+panel key — e.g. "pulse.forecast" + "recommend". */
  view: string;
  panel: string;
  /** Default collapsed-state per role. Roles not listed default to false (expanded). */
  defaultCollapsedFor?: Partial<Record<Role, boolean>>;
  /** Header content — visible in both states. Hero metric, panel name, etc. */
  header: React.ReactNode;
  /** Optional one-line summary shown ONLY when collapsed (under the header). */
  collapsedSummary?: React.ReactNode;
  /** Body content — shown only when expanded. */
  children: React.ReactNode;
  /** Optional className for the outer wrapper. */
  className?: string;
}

function lsKey(view: string, panel: string, role: Role): string {
  return `spire.panel.${view}.${panel}.collapsed.${role}`;
}

function loadCollapsed(view: string, panel: string, role: Role, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(lsKey(view, panel, role));
    if (raw === "true") return true;
    if (raw === "false") return false;
  } catch {
    /* tolerate */
  }
  return fallback;
}

function saveCollapsed(view: string, panel: string, role: Role, collapsed: boolean): void {
  try {
    window.localStorage.setItem(lsKey(view, panel, role), collapsed ? "true" : "false");
  } catch {
    /* tolerate */
  }
}

export function CollapsiblePanel({
  view,
  panel,
  defaultCollapsedFor,
  header,
  collapsedSummary,
  children,
  className,
}: CollapsiblePanelProps) {
  const role = useSpireStore((s) => s.role);
  const fallback = defaultCollapsedFor?.[role] ?? false;
  // Read once per mount; updates from elsewhere don't fight the operator.
  const [collapsed, setCollapsed] = useState<boolean>(() =>
    typeof window === "undefined" ? fallback : loadCollapsed(view, panel, role, fallback),
  );

  // Re-hydrate when the role changes — we want the per-role memory to follow.
  useEffect(() => {
    if (typeof window === "undefined") return;
    setCollapsed(loadCollapsed(view, panel, role, fallback));
    // fallback is derived from defaultCollapsedFor[role], so role covers both.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, view, panel]);

  function toggle() {
    setCollapsed((prev) => {
      const next = !prev;
      saveCollapsed(view, panel, role, next);
      return next;
    });
  }

  return (
    <div className={clsx("rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]", className)}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-3 border-b border-[var(--color-border)] px-3 py-2 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
        style={{ minHeight: "var(--tap-min, 0)" }}
      >
        <span className="flex-1 min-w-0">{header}</span>
        <span
          aria-hidden
          className="font-mono text-[var(--color-text-muted)] transition-transform"
          style={{
            fontSize: "var(--text-base)",
            transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)",
            display: "inline-block",
          }}
        >
          ▾
        </span>
      </button>
      {collapsed
        ? (collapsedSummary != null && (
            <div
              className="px-3 py-2 font-mono text-[var(--color-text-secondary)]"
              style={{ fontSize: "var(--text-sm)", letterSpacing: "var(--tracking-wide)" }}
            >
              {collapsedSummary}
            </div>
          ))
        : (
          <div>
            {children}
          </div>
        )}
    </div>
  );
}
