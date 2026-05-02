/**
 * CollapsiblePanel — Track-G2 progressive disclosure wrapper.
 *
 * Wraps a panel header + body with a `▾` toggle. Default-collapsed shows
 * only the header (hero metric + 1-line summary supplied by the caller).
 * Expanded shows the full panel content.
 *
 * Two persistence modes:
 *
 *   1. Legacy (demo build, or any caller that just sets
 *      `defaultCollapsedFor`): per-role boolean stored at
 *      `spire.panel.{view}.{panel}.collapsed.{role}`. Drives the
 *      Track-G2 walk-through defaults that ship today.
 *
 *   2. PULSE per-DODID (operational build): caller passes
 *      `pulsePanel="predictedFailures" | "recommendActions"` and the
 *      panel state is read from / written to
 *      `spire.pulse.panels.{dodidHash}` as part of an object payload
 *      `{ predictedFailures: "expanded", recommendActions: "collapsed" }`.
 *      Role defaults come from `state/pulsePanels.ts` and only fire
 *      when `isOperational()` is true. Demo build falls back to the
 *      legacy `defaultCollapsedFor` path so the show-and-tell posture
 *      doesn't shift.
 *
 * Visual: when collapsed under PULSE/operational, render a compact
 * pill-style header (e.g. `+ Predicted failures (11 flagged)`) supplied
 * by the caller via `collapsedPill`. Click → smooth expand. Other
 * callers keep the original chevron + summary chrome.
 */
import { useEffect, useState } from "react";
import clsx from "clsx";
import { useSpireStore, type Role } from "../state/store";
import { isOperational } from "../state/buildMode";
import {
  resolvePanelCollapsed,
  savePanelState,
  type PanelKey,
} from "../state/pulsePanels";
import { Pressable } from "./ui";

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
  /**
   * Optional pill-style collapsed renderer (operational build, PULSE
   * panels). When provided AND `pulsePanel` is set AND the panel is
   * collapsed, this renders in place of the default chevron header.
   * Click → expand.
   */
  collapsedPill?: React.ReactNode;
  /** Body content — shown only when expanded. */
  children: React.ReactNode;
  /** Optional className for the outer wrapper. */
  className?: string;
  /**
   * PULSE panel key. Activates per-DODID persistence and the
   * operational-build role defaults from `state/pulsePanels.ts`.
   * Demo build still honors `defaultCollapsedFor` for backward compat.
   */
  pulsePanel?: PanelKey;
}

function legacyKey(view: string, panel: string, role: Role): string {
  return `spire.panel.${view}.${panel}.collapsed.${role}`;
}

function loadLegacyCollapsed(
  view: string,
  panel: string,
  role: Role,
  fallback: boolean,
): boolean {
  try {
    const raw = window.localStorage.getItem(legacyKey(view, panel, role));
    if (raw === "true") return true;
    if (raw === "false") return false;
  } catch {
    /* tolerate */
  }
  return fallback;
}

function saveLegacyCollapsed(
  view: string,
  panel: string,
  role: Role,
  collapsed: boolean,
): void {
  try {
    window.localStorage.setItem(
      legacyKey(view, panel, role),
      collapsed ? "true" : "false",
    );
  } catch {
    /* tolerate */
  }
}

/**
 * Resolve the initial collapsed state for a fresh mount or a role-swap
 * re-hydrate. PULSE/operational path branches into the per-DODID
 * payload + role defaults; everything else stays on the legacy
 * per-role boolean path.
 */
function resolveInitialCollapsed(args: {
  view: string;
  panel: string;
  role: Role;
  legacyFallback: boolean;
  pulsePanel: PanelKey | undefined;
  dodid: string | null | undefined;
}): boolean {
  const { view, panel, role, legacyFallback, pulsePanel, dodid } = args;
  if (typeof window === "undefined") return legacyFallback;
  if (pulsePanel && isOperational()) {
    return resolvePanelCollapsed(dodid, role, pulsePanel);
  }
  return loadLegacyCollapsed(view, panel, role, legacyFallback);
}

export function CollapsiblePanel({
  view,
  panel,
  defaultCollapsedFor,
  header,
  collapsedSummary,
  collapsedPill,
  children,
  className,
  pulsePanel,
}: CollapsiblePanelProps) {
  const role = useSpireStore((s) => s.role);
  const dodid = useSpireStore((s) => s.currentUser?.dodid ?? null);
  const legacyFallback = defaultCollapsedFor?.[role] ?? false;
  // Read once per mount; updates from elsewhere don't fight the operator.
  const [collapsed, setCollapsed] = useState<boolean>(() =>
    resolveInitialCollapsed({ view, panel, role, legacyFallback, pulsePanel, dodid }),
  );

  // Re-hydrate on role / DODID swap. Each operator and role keep their
  // own preferences, so a role flip on the topbar should snap the panel
  // back to that role's default unless the new operator has an explicit
  // persisted value.
  useEffect(() => {
    if (typeof window === "undefined") return;
    setCollapsed(
      resolveInitialCollapsed({
        view,
        panel,
        role,
        legacyFallback,
        pulsePanel,
        dodid,
      }),
    );
    // legacyFallback is derived from defaultCollapsedFor[role]; covered
    // by the role dep. pulsePanel is configuration, not user data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, view, panel, dodid, pulsePanel]);

  function toggle() {
    setCollapsed((prev) => {
      const next = !prev;
      if (pulsePanel && isOperational()) {
        savePanelState(dodid, role, pulsePanel, next ? "collapsed" : "expanded");
      } else {
        saveLegacyCollapsed(view, panel, role, next);
      }
      return next;
    });
  }

  const usingPill = !!pulsePanel && isOperational() && !!collapsedPill;

  // Pill-only collapsed render — replaces the chevron header entirely.
  // The pill IS the click-target; expanding swaps to the full panel
  // (header + body) on the next render.
  if (usingPill && collapsed) {
    return (
      <div className={className}>
        <Pressable
          onClick={toggle}
          aria-expanded={false}
          aria-label="Expand panel"
          className={clsx(
            "inline-flex w-full items-center gap-2 rounded-full",
            "border border-[var(--color-border)] bg-[var(--color-surface)]",
            "px-3 py-1.5 text-left transition-colors",
            "hover:border-[var(--color-border-active)] hover:bg-[var(--color-surface-hover)]",
          )}
        >
          <span
            aria-hidden
            className="font-mono text-[var(--color-text-muted)]"
            style={{ fontSize: "var(--text-sm)" }}
          >
            +
          </span>
          <span className="min-w-0 flex-1">{collapsedPill}</span>
        </Pressable>
      </div>
    );
  }

  return (
    <div className={clsx("rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]", className)}>
      <Pressable
        onClick={toggle}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-3 border-b border-[var(--color-border)] px-3 py-2 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
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
      </Pressable>
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
          <div
            style={{
              // Smooth expand on first render after a click. We rely on
              // the conditional render above to unmount the body when
              // collapsed so heavy children (Recharts ResponsiveContainer
              // keeps a ResizeObserver alive) don't sit on the page
              // unused.
              animation: "spire-panel-expand 180ms ease-out",
            }}
          >
            {children}
          </div>
        )}
    </div>
  );
}
