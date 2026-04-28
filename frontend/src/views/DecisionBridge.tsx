/**
 * DecisionBridge — Task #24 ([W1] "15-second decision" hero dashboard).
 *
 * The bridge is the new index route (`/`). It collapses five live signals
 * into a single non-scrolling pane sized to 1920×1080:
 *
 *   1. FPCON + Mission Clock + installation strap     →  drill BASTION
 *   2. Top-3 alerts (severity desc, then recency)     →  drill BASTION (with building preselected)
 *   3. Top-3 forecasted Class IX/VIII/III shortages   →  drill PULSE Forecast (unit preselected)
 *   4. MC% by unit (low-to-high) with 7-day spark     →  drill PULSE (unit preselected)
 *   5. Audit-chain health (events/min, last anomaly)  →  drill ADMIN
 *
 * Auto-refresh cadences are pinned in the spec (alerts 10s, MC% 60s,
 * audit 5s). The bridge intentionally bypasses ScopeGuard because every
 * role needs the at-a-glance view; per-tile drill-throughs land on the
 * scoped surfaces where the existing scope checks apply. The previous
 * role-default redirect lives at `/home` as a fallback escape hatch.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import {
  api,
  type BastionAlert,
  type BastionCOP,
  type DecisionBridgeAlerts,
  type DecisionBridgeAudit,
  type DecisionBridgeMcByUnit,
  type DecisionBridgeMcUnit,
  type DecisionBridgeMission,
  type DecisionBridgeShortage,
  type DecisionBridgeShortages,
} from "../api";
import { pollWithBackoff, formatApiError } from "../api-retry";
import { ROLE_DEFAULT_VIEW, useSpireStore } from "../state/store";
import { resolveAlertTarget } from "./bastion/resolveAlertTarget";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  Pressable,
} from "../components/ui";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format an ISO timestamp as a Zulu DTG matching the BASTION mission clock
 * (`261700Z APR 26`). Mirrors `BastionView.formatZulu` so a Marine reading
 * the bridge sees the same time format as the underlying surfaces.
 */
function formatDtg(d: Date): string {
  const z = (n: number, w = 2) => String(n).padStart(w, "0");
  const dd = z(d.getUTCDate());
  const hh = z(d.getUTCHours());
  const mm = z(d.getUTCMinutes());
  const ss = z(d.getUTCSeconds());
  const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase();
  const yy = String(d.getUTCFullYear()).slice(2);
  return `${dd}${hh}${mm}:${ss}Z ${month} ${yy}`;
}

/** Render a relative time like `42s ago` / `3m ago` / `1h ago`. */
function relTime(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const delta = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

const FPCON_TONE: Record<string, { fg: string; bg: string; border: string; label: string }> = {
  NORMAL:  { fg: "var(--color-success)", bg: "color-mix(in oklab, var(--color-success-muted) 25%, transparent)",  border: "var(--color-success)",  label: "NORMAL"  },
  ALPHA:   { fg: "var(--color-success)", bg: "color-mix(in oklab, var(--color-success-muted) 25%, transparent)",  border: "var(--color-success)",  label: "ALPHA"   },
  BRAVO:   { fg: "var(--color-warning)", bg: "color-mix(in oklab, var(--color-warning-muted) 25%, transparent)",  border: "var(--color-warning)",  label: "BRAVO"   },
  CHARLIE: { fg: "var(--color-warning)", bg: "color-mix(in oklab, var(--color-warning-muted) 35%, transparent)",  border: "var(--color-warning)",  label: "CHARLIE" },
  DELTA:   { fg: "var(--color-danger)",  bg: "color-mix(in oklab, var(--color-danger-muted)  35%, transparent)",  border: "var(--color-danger)",   label: "DELTA"   },
};

const SEVERITY_ACCENT: Record<string, string> = {
  CRITICAL: "var(--color-danger)",
  HIGH:     "var(--color-danger)",
  MODERATE: "var(--color-warning)",
  LOW:      "var(--color-info)",
  INFO:     "var(--color-text-muted)",
};

const SHORTAGE_BADGE: Record<string, { label: string; tone: string }> = {
  class_ix:   { label: "IX", tone: "var(--color-warning)" },
  class_viii: { label: "VIII", tone: "var(--color-danger)" },
  class_iii:  { label: "III",  tone: "var(--color-info)" },
};

/** Hours-to-stockout → severity tone. < 24h = danger, 24-48h = warning, >48h = muted. */
function stockoutTone(hours: number): string {
  if (hours < 24) return "var(--color-danger)";
  if (hours < 48) return "var(--color-warning)";
  return "var(--color-text-secondary)";
}

/** MC% rate → tone. < 60% = danger, 60-70% = warning, ≥ 70% = success. */
function mcTone(rate: number): string {
  if (rate < 0.60) return "var(--color-danger)";
  if (rate < 0.70) return "var(--color-warning)";
  return "var(--color-success)";
}

// ---------------------------------------------------------------------------
// Sparkline — 7-day MC% inline SVG. Self-contained so the tile stays light.
// ---------------------------------------------------------------------------
function Sparkline({ values, width = 88, height = 24 }: { values: number[]; width?: number; height?: number }) {
  if (!values.length) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = values.length > 1 ? width / (values.length - 1) : width;
  const points = values
    .map((v, i) => {
      const x = i * stepX;
      const y = height - ((v - min) / range) * (height - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const last = values[values.length - 1];
  const lastY = height - ((last - min) / range) * (height - 2) - 1;
  const lastX = (values.length - 1) * stepX;
  const stroke = mcTone(last);
  return (
    <svg width={width} height={height} aria-hidden focusable="false" className="block">
      <polyline points={points} fill="none" stroke={stroke} strokeWidth={1.5} />
      <circle cx={lastX} cy={lastY} r={2} fill={stroke} />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Tile chassis — splits the tile into a header Pressable (generic drill) and
// a body slot whose children manage their own click semantics. This is the
// fix for the F-01 finding: a row inside the body needs to be its own
// <button> so it can drill to the specific item, which is impossible if the
// whole tile is one outer <button> (button-in-button is invalid HTML and
// every click collapses to the outer drill).
//
// The contract for callers:
//   - Header click  → generic onDrill (handled here)
//   - Body content  → caller renders rows as <Pressable> for per-row drill,
//                     OR wraps chrome states (loading/empty) in <TileChromePressable>
//                     so the tile body still drills generically when there
//                     are no rows.
// ---------------------------------------------------------------------------
interface TileProps {
  label: string;
  drillLabel: string;
  onDrill: () => void;
  rightSlot?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}
function Tile({ label, drillLabel, onDrill, rightSlot, className, children }: TileProps) {
  return (
    <div
      className={
        "group flex h-full flex-col overflow-hidden rounded-md border border-[var(--color-border)] " +
        "bg-[var(--color-surface)] hover:border-[var(--color-border-active)] " +
        "focus-within:border-[var(--color-border-active)] " +
        (className ?? "")
      }
    >
      <Pressable
        onClick={onDrill}
        aria-label={`${label} — ${drillLabel}`}
        className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-3 py-2 hover:bg-[color-mix(in_oklab,var(--color-bg)_45%,transparent)]"
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-muted)]">
          {label}
        </span>
        <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-secondary)] group-hover:text-[var(--color-text)]">
          {rightSlot}
          <span aria-hidden>→ {drillLabel}</span>
        </span>
      </Pressable>
      <div className="flex flex-1 min-h-0 flex-col px-3 py-2">{children}</div>
    </div>
  );
}

/**
 * Body wrapper for chrome states (loading / empty / non-row tile bodies)
 * that should still trigger the tile's generic drill. Renders a Pressable
 * that fills the body so a click anywhere on the chrome area drills.
 *
 * Do NOT wrap <ErrorState> in this — ErrorState contains its own Buttons,
 * and nesting <button> inside <button> is invalid HTML.
 */
function TileChromePressable({
  onDrill,
  ariaLabel,
  className,
  children,
}: {
  onDrill: () => void;
  ariaLabel: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      onClick={onDrill}
      aria-label={ariaLabel}
      className={
        "flex flex-1 min-h-0 flex-col rounded-sm hover:bg-[color-mix(in_oklab,var(--color-bg)_30%,transparent)] " +
        (className ?? "")
      }
    >
      {children}
    </Pressable>
  );
}

/**
 * Mouse-only filler that absorbs clicks on the empty body space *below*
 * the rows in a populated row-style tile (alerts/shortages/MC%) and routes
 * them to the tile's generic drill. The header Pressable already provides
 * the keyboard / screen-reader path to the same destination, so this
 * filler is hidden from assistive tech (`aria-hidden`) and removed from
 * tab order (`tabIndex={-1}`) — keyboard users still tab through header +
 * row buttons cleanly, mouse users get the "click any chrome to drill"
 * affordance the bridge promises.
 */
function TileBodyFiller({ onDrill }: { onDrill: () => void }) {
  return (
    <Pressable
      onClick={onDrill}
      aria-hidden
      tabIndex={-1}
      className="mt-1 flex-1 min-h-0 cursor-pointer rounded-sm"
    >
      <span className="sr-only">Open</span>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Tile 1 — FPCON + Mission Clock + installation strap
// ---------------------------------------------------------------------------
function MissionTile({ mission, error }: { mission: DecisionBridgeMission | null; error: string | null }) {
  const nav = useNavigate();
  const fpconStore = useSpireStore((s) => s.fpcon);
  // Live mission-clock seconds tick.
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Prefer the operator's current FPCON in store (a sim may have escalated
  // it past the dataset default); fall back to the backend-supplied default.
  const fpcon = fpconStore || mission?.fpcon_default || "BRAVO";
  const tone = FPCON_TONE[fpcon] ?? FPCON_TONE.BRAVO;
  const dtg = formatDtg(now);

  const drill = () => nav("/bastion");

  return (
    <Tile
      label="FPCON · Mission Clock"
      drillLabel="BASTION"
      onDrill={drill}
    >
      {error && !mission ? (
        <ErrorState title="Mission strap unavailable" description={error} />
      ) : !mission ? (
        <TileChromePressable onDrill={drill} ariaLabel="Mission strap loading — open BASTION">
          <LoadingState label="Loading mission strap" />
        </TileChromePressable>
      ) : (
        <TileChromePressable
          onDrill={drill}
          ariaLabel={`FPCON ${tone.label} · ${mission.installation_name} — open BASTION`}
          className="gap-2"
        >
          <div className="flex items-center gap-3">
            <div
              className="flex h-14 min-w-[64px] items-center justify-center rounded-sm border px-3 font-mono text-2xl font-bold tracking-widest"
              style={{ color: tone.fg, background: tone.bg, borderColor: tone.border }}
              aria-label={`FPCON ${tone.label}`}
            >
              {tone.label}
            </div>
            <div className="flex flex-1 min-w-0 flex-col">
              <div className="font-mono text-lg font-semibold tabular-nums tracking-wider text-[var(--color-text)]">
                {dtg}
              </div>
              <div className="truncate font-mono text-[11px] uppercase tracking-widest text-[var(--color-text-muted)]">
                {mission.installation_name} · {mission.parent_command}
              </div>
            </div>
          </div>
          {mission.mission_essential_task ? (
            <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-secondary)]">
              MET: {mission.mission_essential_task}
            </div>
          ) : null}
          {mission.mission_objective ? (
            <p className="line-clamp-2 text-[12px] leading-snug text-[var(--color-text-secondary)]">
              {mission.mission_objective}
            </p>
          ) : null}
        </TileChromePressable>
      )}
    </Tile>
  );
}

// ---------------------------------------------------------------------------
// Tile 2 — Top alerts (10s)
// ---------------------------------------------------------------------------
function AlertsTile({
  data,
  cop,
  error,
}: {
  data: DecisionBridgeAlerts | null;
  cop: BastionCOP | null;
  error: string | null;
}) {
  const nav = useNavigate();
  const setSelectedBuildingId = useSpireStore((s) => s.setSelectedBuildingId);
  const setSelectedUnitId = useSpireStore((s) => s.setSelectedUnitId);

  const drillToAlert = (a?: BastionAlert) => {
    if (a) {
      const target = resolveAlertTarget(a, cop);
      setSelectedBuildingId(target.buildingId);
      setSelectedUnitId(a.unit ?? null);
    }
    nav("/bastion");
  };

  const totals = data?.severity_counts ?? {};
  const sevSummary = ["CRITICAL", "HIGH", "MODERATE", "LOW", "INFO"]
    .filter((s) => (totals[s] ?? 0) > 0)
    .map((s) => `${s[0]}:${totals[s]}`)
    .join(" · ");

  return (
    <Tile
      label="Top Alerts (10s)"
      drillLabel="BASTION"
      onDrill={() => drillToAlert()}
      rightSlot={
        data ? (
          <span className="font-mono text-[10px] tracking-widest text-[var(--color-text-muted)]">
            {data.total} open{sevSummary ? ` · ${sevSummary}` : ""}
          </span>
        ) : null
      }
    >
      {error && !data ? (
        <ErrorState title="Alerts unavailable" description={error} />
      ) : !data ? (
        <TileChromePressable onDrill={() => drillToAlert()} ariaLabel="Alerts loading — open BASTION">
          <LoadingState label="Loading alerts" />
        </TileChromePressable>
      ) : data.alerts.length === 0 ? (
        <TileChromePressable onDrill={() => drillToAlert()} ariaLabel="No open alerts — open BASTION">
          <EmptyState title="All clear" description="No open alerts in scope." />
        </TileChromePressable>
      ) : (
        <>
        <ul className="flex flex-col gap-1.5">
          {data.alerts.map((a) => {
            const accent = SEVERITY_ACCENT[a.severity] ?? "var(--color-text-muted)";
            return (
              <li key={a.id}>
                <Pressable
                  onClick={() => drillToAlert(a)}
                  aria-label={`${a.severity} · ${a.title}${a.unit ? ` · ${a.unit}` : ""} — open in BASTION`}
                  className="flex items-start gap-2 rounded-sm border-l-2 px-2 py-1 hover:bg-[color-mix(in_oklab,var(--color-text)_8%,transparent)]"
                  style={{
                    borderLeftColor: accent,
                    background: "color-mix(in oklab, var(--color-bg) 60%, transparent)",
                  }}
                >
                  <span
                    className="font-mono text-[10px] font-semibold uppercase tracking-widest"
                    style={{ color: accent }}
                  >
                    {a.severity}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] font-medium text-[var(--color-text)]">
                      {a.title}
                    </div>
                    <div className="truncate font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
                      {a.source}{a.unit ? ` · ${a.unit}` : ""} · {relTime(a.timestamp)}
                    </div>
                  </div>
                </Pressable>
              </li>
            );
          })}
        </ul>
        <TileBodyFiller onDrill={() => drillToAlert()} />
        </>
      )}
    </Tile>
  );
}

// ---------------------------------------------------------------------------
// Tile 3 — Top-3 forecasted shortages
// ---------------------------------------------------------------------------
function ShortagesTile({
  data,
  error,
}: {
  data: DecisionBridgeShortages | null;
  error: string | null;
}) {
  const nav = useNavigate();
  const setSelectedUnitId = useSpireStore((s) => s.setSelectedUnitId);

  const drill = (s?: DecisionBridgeShortage) => {
    if (s?.drill_unit) {
      setSelectedUnitId(s.drill_unit);
      // Pass the unit through router state, not the URL — keeps unit
      // names out of copy-pasted/share-screened URLs (forecast-leak F-15).
      nav("/pulse/forecast", { state: { unit: s.drill_unit } });
    } else {
      nav("/pulse/forecast");
    }
  };

  return (
    <Tile
      label="Forecasted Shortages"
      drillLabel="PULSE"
      onDrill={() => drill()}
    >
      {error && !data ? (
        <ErrorState title="Shortages unavailable" description={error} />
      ) : !data ? (
        <TileChromePressable onDrill={() => drill()} ariaLabel="Shortages loading — open PULSE forecast">
          <LoadingState label="Loading shortages" />
        </TileChromePressable>
      ) : data.shortages.length === 0 ? (
        <TileChromePressable onDrill={() => drill()} ariaLabel="No projected shortages — open PULSE forecast">
          <EmptyState title="No projected shortages" description="Stocks above minimum across watched classes." />
        </TileChromePressable>
      ) : (
        <>
        <ul className="flex flex-col gap-1.5">
          {data.shortages.map((s) => {
            const badge = SHORTAGE_BADGE[s.kind];
            const tone = stockoutTone(s.hours_to_stockout);
            return (
              <li key={`${s.kind}-${s.item}`}>
                <Pressable
                  onClick={() => drill(s)}
                  aria-label={`${s.label} ${s.item}${s.drill_unit ? ` · ${s.drill_unit}` : ""} · H+${s.hours_to_stockout}h — open in PULSE forecast`}
                  className="flex items-center gap-2 rounded-sm border-l-2 px-2 py-1 hover:bg-[color-mix(in_oklab,var(--color-text)_8%,transparent)]"
                  style={{
                    borderLeftColor: tone,
                    background: "color-mix(in oklab, var(--color-bg) 60%, transparent)",
                  }}
                >
                  <span
                    className="rounded-sm px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-widest"
                    style={{ color: badge.tone, border: `1px solid ${badge.tone}` }}
                    aria-hidden
                  >
                    {badge.label}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] font-medium text-[var(--color-text)]">
                      {s.item}
                    </div>
                    <div className="truncate font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
                      {s.drill_unit ?? "—"}
                      {s.open_requisitions ? ` · ${s.open_requisitions} open req` : ""}
                    </div>
                  </div>
                  <div
                    className="font-mono text-[12px] font-semibold tabular-nums tracking-wider"
                    style={{ color: tone }}
                    aria-hidden
                  >
                    H+{s.hours_to_stockout}h
                  </div>
                </Pressable>
              </li>
            );
          })}
        </ul>
        <TileBodyFiller onDrill={() => drill()} />
        </>
      )}
    </Tile>
  );
}

// ---------------------------------------------------------------------------
// Tile 4 — MC% by unit with sparklines + 7d delta
// ---------------------------------------------------------------------------
function McTile({
  data,
  error,
}: {
  data: DecisionBridgeMcByUnit | null;
  error: string | null;
}) {
  const nav = useNavigate();
  const setSelectedUnitId = useSpireStore((s) => s.setSelectedUnitId);

  const drill = (u?: DecisionBridgeMcUnit) => {
    if (u) setSelectedUnitId(u.unit);
    nav("/pulse");
  };

  return (
    <Tile
      label="MC% by Unit (60s)"
      drillLabel="PULSE"
      onDrill={() => drill()}
    >
      {error && !data ? (
        <ErrorState title="MC% unavailable" description={error} />
      ) : !data ? (
        <TileChromePressable onDrill={() => drill()} ariaLabel="MC% loading — open PULSE">
          <LoadingState label="Loading readiness" />
        </TileChromePressable>
      ) : data.units.length === 0 ? (
        <TileChromePressable onDrill={() => drill()} ariaLabel="No units in scope — open PULSE">
          <EmptyState title="No units in scope" />
        </TileChromePressable>
      ) : (
        <>
        <ul className="flex flex-col gap-1.5">
          {data.units.map((u) => {
            const tone = mcTone(u.current_mc_rate);
            const deltaPct = u.delta_7d * 100;
            const deltaTone = deltaPct > 0
              ? "var(--color-success)"
              : deltaPct < 0
                ? "var(--color-danger)"
                : "var(--color-text-muted)";
            const ratePct = (u.current_mc_rate * 100).toFixed(1);
            const deltaSign = deltaPct >= 0 ? "+" : "";
            return (
              <li key={u.unit}>
                <Pressable
                  onClick={() => drill(u)}
                  aria-label={`${u.unit} · ${ratePct}% MC · 7-day delta ${deltaSign}${deltaPct.toFixed(1)} pp — open in PULSE`}
                  className="flex items-center gap-3 rounded-sm border-l-2 px-2 py-1.5 hover:bg-[color-mix(in_oklab,var(--color-text)_8%,transparent)]"
                  style={{
                    borderLeftColor: tone,
                    background: "color-mix(in oklab, var(--color-bg) 60%, transparent)",
                  }}
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <div className="truncate text-[13px] font-medium text-[var(--color-text)]">
                      {u.unit}
                    </div>
                    <div className="truncate font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
                      {u.mc_count}/{u.asset_total} MC
                    </div>
                  </div>
                  <Sparkline values={u.sparkline_7d} />
                  <div
                    className="w-12 text-right font-mono text-[14px] font-semibold tabular-nums"
                    style={{ color: tone }}
                    aria-hidden
                  >
                    {ratePct}%
                  </div>
                  <div
                    className="w-14 text-right font-mono text-[11px] tabular-nums"
                    style={{ color: deltaTone }}
                    aria-hidden
                  >
                    {deltaSign}{deltaPct.toFixed(1)} pp
                  </div>
                </Pressable>
              </li>
            );
          })}
        </ul>
        <TileBodyFiller onDrill={() => drill()} />
        </>
      )}
    </Tile>
  );
}

// ---------------------------------------------------------------------------
// Tile 5 — Audit-chain health (5s)
// ---------------------------------------------------------------------------
function AuditTile({
  data,
  error,
}: {
  data: DecisionBridgeAudit | null;
  error: string | null;
}) {
  const nav = useNavigate();
  const tone = data?.chain_ok ? "var(--color-success)" : "var(--color-danger)";
  const statusLabel = data?.chain_ok ? "INTACT" : "BROKEN";
  const drill = () => nav("/admin");

  return (
    <Tile
      label="Audit Health (5s)"
      drillLabel="ADMIN"
      onDrill={drill}
      rightSlot={
        data ? (
          <span
            className="rounded-sm border px-1.5 py-[1px] font-mono text-[10px] font-semibold tracking-widest"
            style={{ color: tone, borderColor: tone }}
          >
            {statusLabel}
          </span>
        ) : null
      }
    >
      {error && !data ? (
        <ErrorState title="Audit health unavailable" description={error} />
      ) : !data ? (
        <TileChromePressable onDrill={drill} ariaLabel="Audit health loading — open ADMIN">
          <LoadingState label="Loading audit" />
        </TileChromePressable>
      ) : (
        <TileChromePressable
          onDrill={drill}
          ariaLabel={`Audit chain ${statusLabel} · ${data.events_per_minute.toFixed(1)} events/min — open ADMIN`}
          className="gap-3"
        >
          <div className="grid grid-cols-3 gap-3">
            <div className="flex flex-col">
              <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
                Events / min
              </span>
              <span className="font-mono text-2xl font-semibold tabular-nums text-[var(--color-text)]">
                {data.events_per_minute.toFixed(1)}
              </span>
              <span className="font-mono text-[10px] tracking-widest text-[var(--color-text-muted)]">
                {data.events_in_window} in last {data.window_minutes}m
              </span>
            </div>
            <div className="flex flex-col">
              <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
                Total entries
              </span>
              <span className="font-mono text-2xl font-semibold tabular-nums text-[var(--color-text)]">
                {data.total_entries.toLocaleString()}
              </span>
              <span className="truncate font-mono text-[10px] tracking-widest text-[var(--color-text-muted)]">
                last: {relTime(data.last_entry_at)}
              </span>
            </div>
            <div className="flex flex-col">
              <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
                Last anomaly
              </span>
              {data.last_anomaly ? (
                <>
                  <span className="font-mono text-2xl font-semibold tabular-nums text-[var(--color-danger)]">
                    #{data.last_anomaly.broken_at_id}
                  </span>
                  <span className="font-mono text-[10px] tracking-widest text-[var(--color-danger)]">
                    chain broken
                  </span>
                </>
              ) : (
                <>
                  <span className="font-mono text-2xl font-semibold tabular-nums text-[var(--color-success)]">
                    NONE
                  </span>
                  <span className="font-mono text-[10px] tracking-widest text-[var(--color-text-muted)]">
                    chain verified
                  </span>
                </>
              )}
            </div>
          </div>
          {data.head_hash ? (
            <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
              head: <span className="text-[var(--color-text-secondary)]">{data.head_hash.slice(0, 16)}…</span>
              {data.last_entry_kind ? <> · last: <span className="text-[var(--color-text-secondary)]">{data.last_entry_kind}</span></> : null}
            </div>
          ) : null}
        </TileChromePressable>
      )}
    </Tile>
  );
}

// ---------------------------------------------------------------------------
// View root
// ---------------------------------------------------------------------------
export function DecisionBridgeView() {
  const role = useSpireStore((s) => s.role);
  const nav = useNavigate();

  const [mission, setMission] = useState<DecisionBridgeMission | null>(null);
  const [missionErr, setMissionErr] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<DecisionBridgeAlerts | null>(null);
  const [alertsErr, setAlertsErr] = useState<string | null>(null);
  const [shortages, setShortages] = useState<DecisionBridgeShortages | null>(null);
  const [shortagesErr, setShortagesErr] = useState<string | null>(null);
  const [mc, setMc] = useState<DecisionBridgeMcByUnit | null>(null);
  const [mcErr, setMcErr] = useState<string | null>(null);
  const [audit, setAudit] = useState<DecisionBridgeAudit | null>(null);
  const [auditErr, setAuditErr] = useState<string | null>(null);

  // The COP is needed to resolve an alert into a building for drill-through.
  const [cop, setCop] = useState<BastionCOP | null>(null);

  // Mission strap — pulled once + every 5 minutes (FPCON default doesn't
  // change inside a session, but a redeploy could swap installation copy).
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const v = await api.decisionBridge.mission();
        if (!cancelled) {
          setMission(v);
          setMissionErr(null);
        }
      } catch (err) {
        if (!cancelled) setMissionErr(formatApiError(err));
      }
    };
    load();
    const id = window.setInterval(load, 5 * 60 * 1000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  // BASTION COP — drives alert→building resolution. Cheap to keep cached.
  useEffect(() => {
    let cancelled = false;
    api.bastion.cop()
      .then((v) => { if (!cancelled) setCop(v); })
      .catch(() => { /* drill-through tolerantly falls back to /bastion sans focus */ });
    return () => { cancelled = true; };
  }, []);

  // Alerts — 10s cadence (multiplier=1 disables the steady-state back-off).
  useEffect(() => {
    const ctl = pollWithBackoff(() => api.decisionBridge.alerts(3), {
      baseMs: 10_000,
      maxMs: 10_000,
      multiplier: 1,
      onResult: (v) => { setAlerts(v); setAlertsErr(null); },
      onError: (err) => setAlertsErr(formatApiError(err)),
    });
    return () => ctl.stop();
  }, [role]);

  // Shortages — 60s cadence (logistics signal evolves slowly).
  useEffect(() => {
    const ctl = pollWithBackoff(() => api.decisionBridge.shortages(3), {
      baseMs: 60_000,
      maxMs: 60_000,
      multiplier: 1,
      onResult: (v) => { setShortages(v); setShortagesErr(null); },
      onError: (err) => setShortagesErr(formatApiError(err)),
    });
    return () => ctl.stop();
  }, [role]);

  // MC% by unit — 60s cadence.
  useEffect(() => {
    const ctl = pollWithBackoff(() => api.decisionBridge.mcByUnit(3), {
      baseMs: 60_000,
      maxMs: 60_000,
      multiplier: 1,
      onResult: (v) => { setMc(v); setMcErr(null); },
      onError: (err) => setMcErr(formatApiError(err)),
    });
    return () => ctl.stop();
  }, [role]);

  // Audit health — 5s cadence (highest cadence for the security tile).
  useEffect(() => {
    const ctl = pollWithBackoff(() => api.decisionBridge.audit(5), {
      baseMs: 5_000,
      maxMs: 5_000,
      multiplier: 1,
      onResult: (v) => { setAudit(v); setAuditErr(null); },
      onError: (err) => setAuditErr(formatApiError(err)),
    });
    return () => ctl.stop();
  }, []);

  const fallbackPath = useMemo(() => ROLE_DEFAULT_VIEW[role] ?? "/bastion", [role]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden bg-[var(--color-bg)] p-3">
      {/* Header strap — view title + escape hatch to the role-default surface. */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-mono text-sm font-semibold uppercase tracking-[0.22em] text-[var(--color-text)]">
            Decision Bridge
          </h1>
          <p className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
            15-second decision · five live signals · click any tile to drill in
          </p>
        </div>
        <Pressable
          onClick={() => nav(fallbackPath)}
          aria-label={`Skip to my default view (${fallbackPath})`}
          block={false}
          className="rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-secondary)] hover:border-[var(--color-border-active)] hover:text-[var(--color-text)]"
        >
          Skip to {fallbackPath.replace(/^\//, "").toUpperCase()} →
        </Pressable>
      </div>

      {/* 6-col × 2-row hero grid. Sized so the whole thing fits a 1920×1080
       * canvas without scrolling — tile bodies use min-h-0 + overflow so an
       * occasional long entry truncates inside the tile rather than pushing
       * the row off-screen. */}
      <div className="grid min-h-0 flex-1 grid-cols-6 grid-rows-2 gap-3">
        <div className="col-span-2 row-span-1 min-h-0">
          <MissionTile mission={mission} error={missionErr} />
        </div>
        <div className="col-span-2 row-span-1 min-h-0">
          <AlertsTile data={alerts} cop={cop} error={alertsErr} />
        </div>
        <div className="col-span-2 row-span-1 min-h-0">
          <ShortagesTile data={shortages} error={shortagesErr} />
        </div>
        <div className="col-span-3 row-span-1 min-h-0">
          <McTile data={mc} error={mcErr} />
        </div>
        <div className="col-span-3 row-span-1 min-h-0">
          <AuditTile data={audit} error={auditErr} />
        </div>
      </div>
    </div>
  );
}
