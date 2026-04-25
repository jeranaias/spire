import { NavLink, useNavigate } from "react-router-dom";
import clsx from "clsx";
import { ROLE_DEFAULT_VIEW, ROLE_LABELS, useSpireStore, type Role } from "../state/store";
import { api } from "../api";
import { NodeStatus } from "./NodeStatus";

const tabs = [
  { to: "/sentry",  label: "SENTRY", restrict: null as Role | null },
  { to: "/pulse",   label: "PULSE",   restrict: null as Role | null },
  { to: "/bastion", label: "BASTION", restrict: null as Role | null },
  { to: "/admin",   label: "ADMIN",   restrict: "security_manager" as Role },
];

export function TopBar() {
  const { role, setRole, operatingMode, alertCount } = useSpireStore();
  const nav = useNavigate();

  function onRoleChange(r: Role) {
    setRole(r);
    nav(ROLE_DEFAULT_VIEW[r]);
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
      <div className="flex h-full items-center justify-between px-4">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2.5">
            <SpireMark />
            <div className="flex flex-col leading-none">
              <span
                className="font-mono text-[15px] font-semibold tracking-[0.24em] text-[var(--color-text)]"
                style={{ fontFeatureSettings: "'ss01'" }}
              >
                SPIRE
              </span>
              <span
                className="mt-[3px] font-mono text-[8px] uppercase text-[var(--color-text-muted)]"
                style={{ letterSpacing: "0.22em" }}
              >
                Contested Logistics
              </span>
            </div>
          </div>
          <nav className="flex items-center gap-0">
            {tabs.filter((t) => t.restrict == null || t.restrict === role).map((tab, idx) => (
              <NavLink
                key={tab.to}
                to={tab.to}
                className={({ isActive }) =>
                  clsx(
                    "group relative px-4 py-2 font-mono text-[11px] font-semibold uppercase transition-colors",
                    isActive
                      ? "text-[var(--color-text)]"
                      : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]",
                  )
                }
                style={{ letterSpacing: "0.18em" }}
              >
                {({ isActive }) => (
                  <>
                    <span
                      className="mr-1.5 font-mono text-[9px] text-[var(--color-text-muted)]"
                      style={{ letterSpacing: "0.1em" }}
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
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-4">
          <NodeStatus />
          <AirGapToggle />
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

// Role-scope intel — brief scope summary shown next to the role chip.
// Helps the "I know what I'm authorized for" feel rather than "it's a form".
const ROLE_SCOPE_HINT: Record<Role, string> = {
  maintenance_chief: "1 unit · CLB-6",
  g4:                "3 units · 2d MLG",
  mef_commander:     "Full MEF",
  data_custodian:    "SENTRY pipeline",
  security_manager:  "FPCON · ECP · ASP",
};

function RoleSelector({ role, onChange }: { role: Role; onChange: (r: Role) => void }) {
  return (
    <div className="flex items-center gap-2">
      <div
        className="hidden select-none flex-col items-end sm:flex"
      >
        <span
          className="font-mono text-[9px] uppercase text-[var(--color-text-muted)]"
          style={{ letterSpacing: "0.22em" }}
        >
          Operator
        </span>
        <span
          className="font-mono text-[9px] text-[var(--color-primary)]"
          style={{ letterSpacing: "0.14em" }}
        >
          ◆ {ROLE_SCOPE_HINT[role]}
        </span>
      </div>
      <div className="relative">
        <select
          value={role}
          onChange={(e) => onChange(e.target.value as Role)}
          className="appearance-none rounded-sm border border-[var(--color-primary)] bg-[color-mix(in_oklab,var(--color-primary)_10%,var(--color-surface))] py-1 pl-2.5 pr-7 font-mono text-[11px] font-semibold uppercase text-[var(--color-primary)] transition-colors hover:bg-[color-mix(in_oklab,var(--color-primary)_20%,var(--color-surface))] focus:outline-none"
          style={{ letterSpacing: "0.14em" }}
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
    </div>
  );
}

function ModeBadge({ mode }: { mode: "full" | "lite" }) {
  const isFull = mode === "full";
  return (
    <div
      className="flex items-center gap-2 rounded-sm border px-2.5 py-1 font-mono text-[10px] uppercase"
      style={{
        letterSpacing: "0.14em",
        borderColor: isFull
          ? "color-mix(in oklab, var(--color-success) 35%, var(--color-border))"
          : "color-mix(in oklab, var(--color-warning) 35%, var(--color-border))",
        backgroundColor: isFull
          ? "color-mix(in oklab, var(--color-success-muted) 15%, transparent)"
          : "color-mix(in oklab, var(--color-warning-muted) 15%, transparent)",
      }}
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
        {isFull ? "Local · Online" : "Lite Mode"}
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
      className="flex items-center gap-1.5 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 font-mono text-[10px] uppercase"
      style={{ letterSpacing: "0.14em" }}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style={{ color }}>
        <path d="M13 2L3 14h8l-1 8 10-12h-8l1-8z" />
      </svg>
      <span className="tabular-nums" style={{ color }}>
        {String(count).padStart(2, "0")}
      </span>
      <span className="text-[var(--color-text-muted)]">alerts</span>
    </div>
  );
}

// GC-7 Air-gap toggle. When engaged, the StatusFooter pulses red and any
// mutation goes through the local queue endpoint. When released, the queue
// flushes to the master and the toggle returns to green/connected. Restricted
// to security_manager + mef_commander since toggling air-gap is a posture
// decision, not a routine click.
function AirGapToggle() {
  const role = useSpireStore((s) => s.role);
  const airGap = useSpireStore((s) => s.airGapActive);
  const setAirGap = useSpireStore((s) => s.setAirGap);
  const setQueueDepth = useSpireStore((s) => s.setQueueDepth);
  const pushToast = useSpireStore((s) => s.pushToast);

  const allowed = role === "security_manager" || role === "mef_commander";
  if (!allowed) return null;

  async function toggle() {
    try {
      const r = await api.system.setAirGap(!airGap, "operator-initiated");
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
    <button
      onClick={toggle}
      className={clsx(
        "flex items-center gap-2 rounded-sm border px-2.5 py-1 font-mono text-[10px] uppercase transition-colors",
      )}
      style={{
        letterSpacing: "0.16em",
        borderColor: airGap ? "var(--color-danger)" : "var(--color-border)",
        background: airGap
          ? "color-mix(in oklab, var(--color-danger-muted) 25%, transparent)"
          : "transparent",
        color: airGap ? "var(--color-danger)" : "var(--color-text-secondary)",
      }}
      title={airGap ? "Click to release air-gap and replay queued ops" : "Engage air-gap mode"}
    >
      <span className="relative flex h-2 w-2" aria-hidden>
        {airGap && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--color-danger)] opacity-60" />
        )}
        <span
          className="relative inline-flex h-2 w-2 rounded-full"
          style={{ background: airGap ? "var(--color-danger)" : "var(--color-success)" }}
        />
      </span>
      <span>{airGap ? "AIR-GAP ON" : "AIR-GAP"}</span>
    </button>
  );
}
