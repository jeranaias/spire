import { useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import clsx from "clsx";
import { ROLE_DEFAULT_VIEW, ROLE_LABELS, useSpireStore, VIEW_SCOPE, type Density, type Role } from "../state/store";
import { api } from "../api";
import { NodeStatus } from "./NodeStatus";

const tabs = [
  { to: "/sentry",  label: "SENTRY", restrict: null as Role | null },
  { to: "/pulse",   label: "PULSE",   restrict: null as Role | null },
  { to: "/bastion", label: "BASTION", restrict: null as Role | null },
  { to: "/admin",   label: "ADMIN",   restrict: "security_manager" as Role },
];

// Friendly per-tab list of authorized roles for the out-of-scope tooltip.
function authorizedRolesFor(path: string, role: Role): { allowed: boolean; allowedRoles: Role[] } {
  const scope = VIEW_SCOPE[path];
  if (!scope) return { allowed: true, allowedRoles: [] };
  return { allowed: scope.includes(role), allowedRoles: scope };
}

export function TopBar() {
  const { role, setRole, operatingMode, alertCount } = useSpireStore();
  const nav = useNavigate();

  function onRoleChange(r: Role) {
    setRole(r);
    // {replace: true} so back-button doesn't ping-pong between the previous
    // role's view and this one, AND so any stale query string (?unit=,
    // ?equipment=, or — historically — ?role=) is cleared on swap. The
    // Zustand store is the single source of truth for role; URL never is.
    nav(ROLE_DEFAULT_VIEW[r], { replace: true });
  }

  return (
    <header className="relative h-14 shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
      {/* Thin horizon accent below the top bar */}
      <div
        className="pointer-events-none absolute inset-x-0 -bottom-px h-px"
        style={{
          background:
            "linear-gradient(90deg, transparent 0%, color-mix(in oklab, var(--color-primary) 40%, transparent) 12%, color-mix(in oklab, var(--color-primary) 40%, transparent) 88%, transparent 100%)",
        }}
      />
      <div className="flex h-full min-w-0 items-center justify-between gap-3 px-4">
        <div className="flex min-w-0 items-center gap-4">
          <div className="flex shrink-0 items-center gap-2.5">
            <SpireMark />
            <div className="flex flex-col leading-none">
              <span
                className="font-mono text-lg font-semibold tracking-[0.2em] text-[var(--color-text)]"
                style={{ fontFeatureSettings: "'ss01'" }}
              >
                SPIRE
              </span>
              <span
                className="mt-[3px] hidden font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest lg:block"
              >
                Contested Logistics
              </span>
            </div>
          </div>
          <nav className="flex shrink-0 items-center gap-0">
            {tabs
              // ADMIN remains hidden when the role isn't security_manager
              // (it's a privileged surface, not a teaser). Other tabs render
              // even out of scope so operators can see what exists, but they
              // get the disabled treatment + tooltip.
              .filter((t) => t.restrict == null || t.restrict === role)
              .map((tab, idx) => {
                const { allowed, allowedRoles } = authorizedRolesFor(tab.to, role);
                if (!allowed) {
                  // Out-of-scope: render as a non-NavLink span so it can't be
                  // clicked into the InsufficientPrivilege wall.
                  return (
                    <span
                      key={tab.to}
                      aria-disabled="true"
                      title={`Out of scope · authorized: ${allowedRoles.map((r) => ROLE_LABELS[r]).join(", ")}`}
                      className="group relative cursor-not-allowed select-none px-3 py-2 font-mono text-sm font-semibold uppercase tracking-widest text-[var(--color-text-muted)] opacity-50"
                    >
                      <span
                        className="mr-1.5 font-mono text-xs text-[var(--color-text-muted)] tracking-wider"
                      >
                        {String(idx + 1).padStart(2, "0")}
                      </span>
                      {tab.label}
                      <span className="ml-1 text-[10px] text-[var(--color-text-muted)] tracking-widest">
                        ·LOCK
                      </span>
                    </span>
                  );
                }
                return (
                  <NavLink
                    key={tab.to}
                    to={tab.to}
                    className={({ isActive }) =>
                      clsx(
                        "group relative px-3 py-2 font-mono text-sm font-semibold uppercase transition-colors tracking-widest",
                        isActive
                          ? "text-[var(--color-text)]"
                          : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]",
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <span
                          className="mr-1.5 font-mono text-xs text-[var(--color-text-muted)] tracking-wider"
                        >
                          {String(idx + 1).padStart(2, "0")}
                        </span>
                        {tab.label}
                        {isActive && (
                          <>
                            <span
                              className="absolute inset-x-2 -bottom-[1px] h-[2px]"
                              style={{
                                background: "var(--color-primary)",
                                boxShadow: "0 0 8px var(--color-primary)",
                              }}
                            />
                            <span className="absolute left-1 top-1/2 h-1 w-1 -translate-y-1/2 rounded-full bg-[var(--color-primary)]" />
                          </>
                        )}
                      </>
                    )}
                  </NavLink>
                );
              })}
          </nav>
        </div>

        <div className="flex min-w-0 shrink items-center gap-2 overflow-hidden">
          <NodeStatus />
          <AirGapToggle />
          <DensityToggle />
          <RoleSelector role={role} onChange={onRoleChange} />
          <ModeBadge mode={operatingMode} />
          <AlertBadge count={alertCount} />
        </div>
      </div>
    </header>
  );
}

function SpireMark() {
  // The SPIRE obelisk — the heartbeat of the product.
  // A persistent vertical scan-line sweeps the mark every ~6s,
  // signalling the engine is alive and watching.
  return (
    <div
      className="relative"
      style={{
        width: 30,
        height: 36,
        filter:
          "drop-shadow(0 0 10px color-mix(in oklab, var(--color-primary) 45%, transparent))",
      }}
    >
      <svg
        width="30"
        height="36"
        viewBox="0 0 30 36"
        fill="none"
        style={{ display: "block" }}
      >
        <defs>
          <linearGradient id="spire-obelisk-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="1" />
            <stop offset="100%" stopColor="var(--color-primary-hover)" stopOpacity="0.75" />
          </linearGradient>
          <linearGradient id="spire-obelisk-edge" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.8" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0.1" />
          </linearGradient>
        </defs>
        {/* Main obelisk body */}
        <path d="M15 1L26 34H4L15 1Z" fill="url(#spire-obelisk-fill)" />
        {/* Left highlight edge */}
        <path d="M15 1L4 34" stroke="url(#spire-obelisk-edge)" strokeWidth="0.6" />
        {/* Center meridian line */}
        <path d="M15 1L15 34" stroke="#0a0c13" strokeWidth="0.6" opacity="0.35" />
        {/* Base plinth */}
        <rect x="2" y="34" width="26" height="1.2" fill="var(--color-primary)" opacity="0.8" />
      </svg>
      {/* Persistent vertical scan-line — the heartbeat */}
      <div
        className="obelisk-scan pointer-events-none absolute left-0 right-0"
        style={{
          top: 0,
          height: "2px",
          background:
            "linear-gradient(90deg, transparent 0%, color-mix(in oklab, var(--color-primary) 90%, white) 50%, transparent 100%)",
          boxShadow: "0 0 6px var(--color-primary), 0 0 12px var(--color-primary)",
          mixBlendMode: "screen",
        }}
      />
    </div>
  );
}

function RoleSelector({ role, onChange }: { role: Role; onChange: (r: Role) => void }) {
  return (
    <div className="relative shrink-0">
      <select
        value={role}
        onChange={(e) => onChange(e.target.value as Role)}
        title="Operator role — sets scope and default landing view"
        // Wider min so "MEF Commander" doesn't truncate at 6 chars and
        // "Maintenance Chief (CLB-6)" stops collapsing into ellipsis.
        // Cap with max-w + truncate so the pill stays a single line on
        // narrow viewports without spilling into the alert badge.
        className="h-11 min-w-[11rem] max-w-[15rem] appearance-none truncate rounded-sm border border-[var(--color-primary)] bg-[color-mix(in_oklab,var(--color-primary)_10%,var(--color-surface))] pl-2.5 pr-7 font-mono text-sm font-semibold uppercase text-[var(--color-primary)] transition-colors hover:bg-[color-mix(in_oklab,var(--color-primary)_20%,var(--color-surface))] focus:outline-none tracking-wider"
      >
        {(Object.keys(ROLE_LABELS) as Role[]).map((k) => (
          <option key={k} value={k}>{ROLE_LABELS[k]}</option>
        ))}
      </select>
      <svg
        className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-[var(--color-primary)]"
        viewBox="0 0 12 12"
        fill="currentColor"
      >
        <path d="M2 4l4 4 4-4H2z" />
      </svg>
    </div>
  );
}

function ModeBadge({ mode }: { mode: "full" | "lite" }) {
  const isFull = mode === "full";
  return (
    <div
      className="hidden shrink-0 items-center gap-1.5 rounded-sm border px-2 py-1 font-mono text-xs uppercase tracking-wider md:flex"
      style={{
        borderColor: isFull
          ? "color-mix(in oklab, var(--color-success) 35%, var(--color-border))"
          : "color-mix(in oklab, var(--color-warning) 35%, var(--color-border))",
        backgroundColor: isFull
          ? "color-mix(in oklab, var(--color-success-muted) 15%, transparent)"
          : "color-mix(in oklab, var(--color-warning-muted) 15%, transparent)",
      }}
      title={isFull ? "Local backend online" : "Reduced-feature lite mode"}
    >
      <span
        className="relative flex h-2 w-2"
        aria-hidden
      >
        <span
          className={clsx(
            "absolute inline-flex h-full w-full animate-ping rounded-full opacity-60",
            isFull ? "bg-[var(--color-success)]" : "bg-[var(--color-warning)]",
          )}
        />
        <span
          className={clsx(
            "relative inline-flex h-2 w-2 rounded-full",
            isFull ? "bg-[var(--color-success)]" : "bg-[var(--color-warning)]",
          )}
        />
      </span>
      <span
        style={{
          color: isFull ? "var(--color-success)" : "var(--color-warning)",
        }}
      >
        {isFull ? "LOCAL" : "LITE"}
      </span>
    </div>
  );
}

function AlertBadge({ count }: { count: number }) {
  const tone =
    count === 0 ? "muted" :
    count < 3   ? "warning" :
                  "danger";
  const color =
    tone === "muted"   ? "var(--color-text-muted)" :
    tone === "warning" ? "var(--color-warning)" :
                         "var(--color-danger)";
  return (
    <div
      className="flex shrink-0 items-center gap-1 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 font-mono text-xs uppercase tracking-wider"
      title={`${count} active alert${count === 1 ? "" : "s"}`}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style={{ color }}>
        <path d="M13 2L3 14h8l-1 8 10-12h-8l1-8z" />
      </svg>
      <span className="tabular-nums" style={{ color }}>
        {String(count).padStart(2, "0")}
      </span>
    </div>
  );
}

// Air-gap posture toggle. When engaged, the StatusFooter pulses red and any
// mutation goes through the local queue endpoint. When released, the queue
// flushes to the master and the toggle returns to green/connected. Restricted
// to security_manager + mef_commander since toggling air-gap is a posture
// decision, not a routine click. Walkthrough caught a one-click toggle as
// risky — added a confirmation modal so the operator confirms intent.
function AirGapToggle() {
  const role = useSpireStore((s) => s.role);
  const airGap = useSpireStore((s) => s.airGapActive);
  const setAirGap = useSpireStore((s) => s.setAirGap);
  const setQueueDepth = useSpireStore((s) => s.setQueueDepth);
  const pushToast = useSpireStore((s) => s.pushToast);
  const queueDepth = useSpireStore((s) => s.queueDepth);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const allowed = role === "security_manager" || role === "mef_commander";
  if (!allowed) return null;

  async function commit() {
    setConfirmOpen(false);
    try {
      const r = await api.system.setAirGap(!airGap, "operator-confirmed");
      setAirGap(r.air_gap_active);
      if (r.air_gap_active) {
        pushToast({ tone: "warn", text: "Air-gap engaged — local writes will be queued", ttlMs: 4000 });
      } else if (r.replayed != null) {
        pushToast({
          tone: "ok",
          text: `Air-gap released — ${r.replayed} queued op${r.replayed === 1 ? "" : "s"} replayed`,
          ttlMs: 5000,
        });
        setQueueDepth(0);
      }
    } catch (e) {
      pushToast({ tone: "error", text: `Air-gap toggle failed: ${e}` });
    }
  }

  return (
    <>
      <button
        onClick={() => setConfirmOpen(true)}
        className="inline-flex h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-sm border px-2.5 font-mono text-xs uppercase transition-colors tracking-wider"
        style={{
          borderColor: airGap ? "var(--color-danger)" : "var(--color-border)",
          background: airGap
            ? "color-mix(in oklab, var(--color-danger-muted) 25%, transparent)"
            : "transparent",
          color: airGap ? "var(--color-danger)" : "var(--color-text-secondary)",
        }}
        title={airGap ? "Air-gap engaged — click to release and replay queued ops" : "Click to engage air-gap mode (confirm required)"}
      >
        <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
          {airGap && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--color-danger)] opacity-60" />
          )}
          <span
            className="relative inline-flex h-2 w-2 rounded-full"
            style={{ background: airGap ? "var(--color-danger)" : "var(--color-success)" }}
          />
        </span>
        <span className="whitespace-nowrap">AIR-GAP{airGap ? " ON" : ""}</span>
      </button>
      {confirmOpen && (
        <div
          className="fixed inset-0 z-[8800] flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setConfirmOpen(false)}
          role="presentation"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="m-4 max-w-md rounded-md border border-[var(--color-warning)] bg-[var(--color-surface)] p-5 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="airgap-confirm-title"
          >
            <div id="airgap-confirm-title" className="font-mono text-xs uppercase text-[var(--color-warning)] tracking-widest">
              {airGap ? "Release air-gap" : "Engage air-gap"}
            </div>
            <h2 className="mt-1 font-sans text-lg font-semibold text-[var(--color-text)]">
              {airGap ? "Replay queued ops and reconnect?" : "Cut outbound writes and queue locally?"}
            </h2>
            <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
              {airGap
                ? `Releasing will replay ${queueDepth} queued operation${queueDepth === 1 ? "" : "s"} to the upstream node and resume normal sync. Conflicts surface in Node Status as vector-clock pairs.`
                : "Engaging will route every mutation to the local queue. SPIRE keeps operating, but partner nodes won't see your writes until release. Use during simulated SATCOM loss or real comms-degraded posture."}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setConfirmOpen(false)}
                className="rounded-sm border border-[var(--color-border-active)] px-4 py-2 font-mono text-xs uppercase text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] tracking-widest"
              >
                Cancel
              </button>
              <button
                onClick={commit}
                className="rounded-sm border border-[var(--color-warning)] bg-[var(--color-warning)] px-4 py-2 font-mono text-xs font-semibold uppercase text-black hover:opacity-90 tracking-widest"
              >
                {airGap ? "Release" : "Engage"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// Track-G3 density toggle. Two modes:
//   • Dense  — current staff layout, more columns, tighter padding.
//   • Sparse — field/iPad layout, larger tap targets, bigger type, fewer
//     columns. Persisted per role in localStorage via the Zustand slice.
//
// Rendered as a compact pill dropdown to match the existing chrome rhythm.
function DensityToggle() {
  const density = useSpireStore((s) => s.density);
  const setDensity = useSpireStore((s) => s.setDensity);
  const next: Density = density === "dense" ? "sparse" : "dense";
  // Label = CURRENT state, not the next one. Reviewer caught the prior
  // build appearing to show the destination state ("DENSE" while currently
  // sparse, click to swap). Visible text always reflects the live store
  // value; the click action is described in the tooltip.
  const currentLabel = density === "dense" ? "DENSE" : "SPARSE";
  const nextLabel = next === "dense" ? "DENSE" : "SPARSE";
  return (
    <button
      type="button"
      onClick={() => setDensity(next)}
      aria-label={`Information density: currently ${currentLabel}. Click to switch to ${nextLabel}.`}
      title={`Currently ${currentLabel}. Click to switch to ${nextLabel}.`}
      className="flex items-center gap-2 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1 font-mono uppercase text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border-active)] hover:text-[var(--color-text)]"
      style={{
        fontSize: "var(--text-xs)",
        letterSpacing: "var(--tracking-wider)",
      }}
    >
      <span aria-hidden className="text-[var(--color-text-muted)]">
        {density === "dense" ? "▦" : "▤"}
      </span>
      <span>{currentLabel}</span>
    </button>
  );
}
