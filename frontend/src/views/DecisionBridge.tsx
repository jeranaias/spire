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
  type RecommendActionsResponse,
  type RecommendedAction,
  isEmptyEnvelope,
} from "../api";
import { pollWithBackoff, formatApiError } from "../api-retry";
import { ROLE_DEFAULT_VIEW, useSpireStore, type DdilMode } from "../state/store";
import { DemoOnly } from "../state/buildMode";
import { resolveAlertTarget } from "./bastion/resolveAlertTarget";
import { StageIngestHero } from "../components/StageIngestHero";
import { useDatasetStatus } from "../hooks/useDatasetStatus";
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
// Freshness helpers — Task #47.
//
// Frozen-snapshot honesty: when a tile renders rows derived from `dataset_day`
// (e.g. mission posture, MC% by unit) we owe the operator an explicit "AS OF"
// pill instead of letting the live DTG ticker imply the readout is real-time.
// Tone scales with how stale the dataset is relative to wall-clock now:
//   < 24h        → muted    (fresh enough to read at face value)
//   24h ≤ Δ < 72h → warning (stale; trust but verify)
//   ≥ 72h        → danger  (do not act on this without a sync)
// ---------------------------------------------------------------------------

/** Parse `YYYY-MM-DD` to UTC midnight; null if unparseable. */
function parseDatasetDay(s: string | null | undefined): Date | null {
  if (!s) return null;
  // ISO yyyy-mm-dd; parse as UTC midnight so tone math doesn't drift across TZs.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Render `2026-04-26` as `26APR26` matching the BASTION DTG style. */
function formatDatasetDay(s: string | null | undefined): string | null {
  const d = parseDatasetDay(s);
  if (!d) return null;
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase();
  const yy = String(d.getUTCFullYear()).slice(2);
  return `${dd}${month}${yy}`;
}

/** Tone for the AS-OF badge given the dataset day. */
function datasetBadgeTone(s: string | null | undefined): { fg: string; border: string } {
  const d = parseDatasetDay(s);
  if (!d) return { fg: "var(--color-text-muted)", border: "var(--color-border)" };
  const ageHours = (Date.now() - d.getTime()) / 3_600_000;
  if (ageHours >= 72) {
    return { fg: "var(--color-danger)", border: "var(--color-danger)" };
  }
  if (ageHours >= 24) {
    return { fg: "var(--color-warning)", border: "var(--color-warning)" };
  }
  return { fg: "var(--color-text-muted)", border: "var(--color-border)" };
}

/**
 * Inline pill for tile headers: "AS OF 26APR26", colored by staleness. Renders
 * nothing if the source has no dataset_day (tolerant: better to omit than to
 * lie about how fresh the data is).
 */
function DatasetBadge({ day }: { day: string | null | undefined }) {
  const label = formatDatasetDay(day);
  if (!label) return null;
  const tone = datasetBadgeTone(day);
  return (
    <span
      className="rounded-sm border px-1.5 py-[1px] font-mono text-[9px] font-semibold tracking-widest"
      style={{ color: tone.fg, borderColor: tone.border }}
      title={`Snapshot date: ${day} — tile rows are computed from this dataset, not live telemetry`}
    >
      AS OF {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// DDIL-aware polling cadence.
//
// Task #47 wants the bridge to honor the operator-driven comms posture: when
// the link is degraded the tile pollers should slow down (4–8x) instead of
// hammering against a lossy/queued lane. Returns the multiplier applied to
// both `baseMs` and `maxMs`.
// ---------------------------------------------------------------------------
function commsCadenceMultiplier(mode: DdilMode): number {
  switch (mode) {
    case "LIMITED":      return 4;
    case "INTERMITTENT": return 6;
    case "DISCONNECTED": return 8;
    case "CONNECTED":
    default:             return 1;
  }
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
        aria-label={`${label} — open ${drillLabel}`}
        className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-3 py-2 hover:bg-[color-mix(in_oklab,var(--color-bg)_45%,transparent)]"
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-muted)]">
          {label}
        </span>
        <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-muted)] group-hover:text-[var(--color-text)]">
          {rightSlot}
          <span aria-hidden className="opacity-0 transition-opacity group-hover:opacity-100">→</span>
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
      rightSlot={<DatasetBadge day={mission?.dataset_day} />}
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
                {/* Parent command (e.g. "2d MLG") is demo flavor —
                 * pilot operators already know who they belong to. */}
                {mission.installation_name}
                <DemoOnly>
                  {mission.parent_command ? ` · ${mission.parent_command}` : ""}
                </DemoOnly>
              </div>
            </div>
          </div>
          {/* MET + objective are demo-only — operators already have
           * these from their orders / OPORD. The tile becomes a
           * tight FPCON · DTG · installation card in operational. */}
          <DemoOnly>
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
          </DemoOnly>
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
      // Drill straight to the alert's unit on the map. The live
      // OkinawaMapCanvas keys its deep-link off the `?unit=` query
      // param (the same contract PULSE's "On Map" button uses), so a
      // unit-scoped alert flies the camera to that marker. Writing the
      // store-selection fields too keeps state coherent for any
      // consumer that reads them.
      const target = resolveAlertTarget(a, cop);
      setSelectedBuildingId(target.buildingId);
      setSelectedUnitId(a.unit ?? null);
      if (a.unit) {
        nav(`/bastion?unit=${encodeURIComponent(a.unit)}`);
        return;
      }
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
      label="Top Alerts"
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
    if (u) {
      // Land on the unit's Risk Board (the per-unit readiness deep-dive),
      // which keys off `?unit=` — a bare nav('/pulse') drops the operator
      // on an unfocused fleet view that never reads the selection.
      setSelectedUnitId(u.unit);
      nav(`/pulse/risk?unit=${encodeURIComponent(u.unit)}`);
      return;
    }
    nav("/pulse");
  };

  return (
    <Tile
      label="MC% by Unit"
      drillLabel="PULSE"
      onDrill={() => drill()}
      rightSlot={<DatasetBadge day={data?.dataset_day} />}
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
      label="Audit Health"
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
          className="gap-2"
        >
          {/* Lead with the cumulative entry count — a real, growing number
           * that reads as "the chain is alive and recording." The prior
           * hero was events/min, which sits at 0.0 in steady state and
           * read like a flatline. Rate/last/head fold into the caption. */}
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-3xl font-semibold tabular-nums text-[var(--color-text)]">
              {data.total_entries.toLocaleString()}
            </span>
            <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
              audit entries
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
            <span>
              {data.events_per_minute.toFixed(1)} / min
            </span>
            <span aria-hidden>·</span>
            <span>last {relTime(data.last_entry_at)}</span>
            {data.last_anomaly ? (
              <>
                <span aria-hidden>·</span>
                <span className="text-[var(--color-danger)]">
                  anomaly #{data.last_anomaly.broken_at_id}
                </span>
              </>
            ) : null}
            {data.head_hash ? (
              <>
                <span aria-hidden>·</span>
                <span className="truncate text-[var(--color-text-secondary)]">
                  head {data.head_hash.slice(0, 12)}…
                </span>
              </>
            ) : null}
          </div>
        </TileChromePressable>
      )}
    </Tile>
  );
}

// ---------------------------------------------------------------------------
// Link-status strip — Task #47.
//
// Sits between the bridge header and the tile grid. Tells the operator at a
// glance whether what they're looking at is fresh or cached:
//
//   CONNECTED    → "LINK · CONNECTED · LAST SYNC 12s AGO"
//   LIMITED      → "LINK · LIMITED · LAST SYNC 18s AGO — slow lane"
//   INTERMITTENT → "LINK · INTERMITTENT · LAST FRESH 1m48s AGO — showing cached"
//   DISCONNECTED → "LINK · DISCONNECTED · LAST FRESH 4m12s AGO — showing cached
//                                                  · 2 writes queued"
//
// Driven entirely off store fields (ddilMode + ddilLastCacheHit + ddilQueue)
// plus a `lastSuccessAt` value lifted from the bridge view's pollers.
// ---------------------------------------------------------------------------
function relMs(deltaMs: number): string {
  const sec = Math.max(0, Math.floor(deltaMs / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remS = sec % 60;
  if (min < 60) return remS ? `${min}m${remS}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  return `${hr}h${min % 60 ? ` ${min % 60}m` : ""}`;
}

const LINK_TONE: Record<DdilMode, string> = {
  CONNECTED:    "var(--color-success)",
  LIMITED:      "var(--color-warning)",
  INTERMITTENT: "var(--color-warning)",
  DISCONNECTED: "var(--color-danger)",
};

function LinkStatusStrip({ lastSuccessAt }: { lastSuccessAt: number | null }) {
  const ddilMode = useSpireStore((s) => s.ddilMode);
  const ddilLastCacheHit = useSpireStore((s) => s.ddilLastCacheHit);
  const ddilLastSyncAt = useSpireStore((s) => s.ddilLastSyncAt);
  const ddilSyncing = useSpireStore((s) => s.ddilSyncing);
  const queueDepth = useSpireStore((s) => s.ddilQueue.length);

  // Happy-path silence: when the link is CONNECTED, queue is empty, and
  // nothing's syncing, the strip is just visual noise. The footer's
  // CommsIndicator already shows posture; suppress this row entirely on
  // the operational happy path. Surfaces only when there's something to
  // say (degraded lane, queued writes, or an active sync).
  const tone = LINK_TONE[ddilMode] ?? LINK_TONE.CONNECTED;
  const isDegraded = ddilMode !== "CONNECTED";
  const shouldRender = isDegraded || queueDepth > 0 || ddilSyncing;

  // Tick once a second so the "12s ago" clock advances live. Hooks must
  // stay above the early return so render order is stable across the
  // visible/hidden flip.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!shouldRender) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [shouldRender]);

  if (!shouldRender) return null;

  // Pick the most honest "last fresh" timestamp we can produce.
  //   CONNECTED   → the most recent of `lastSuccessAt` (per-tile poll
  //                  success) and `ddilLastSyncAt` (set by CommsControl
  //                  after a queue replay completes). The poll value is
  //                  usually fresher; the sync value covers the case
  //                  where we just came out of DISCONNECTED but no poll
  //                  has fired yet.
  //   DEGRADED    → prefer the cache-hit's `cachedAt` (the moment the
  //                  upstream payload we're serving was actually fresh)
  //                  and fall back through `ddilLastSyncAt` and finally
  //                  `lastSuccessAt`. If none are known, render `—`.
  const cacheCachedAt = ddilLastCacheHit?.cachedAt ?? null;
  const candidates = isDegraded
    ? [cacheCachedAt, ddilLastSyncAt, lastSuccessAt]
    : [lastSuccessAt, ddilLastSyncAt];
  const freshAt = candidates.reduce<number | null>(
    (acc, v) => (v == null ? acc : acc == null ? v : Math.max(acc, v)),
    null,
  );
  const freshLabel = freshAt != null ? `${relMs(now - freshAt)} ago` : "—";
  const freshKind = isDegraded ? "LAST FRESH" : "LAST SYNC";

  // Mode-specific tail text.
  const tail = (() => {
    if (ddilSyncing) return "syncing queued writes";
    if (ddilMode === "CONNECTED") return null;
    if (ddilMode === "LIMITED") return "slow lane";
    return "showing cached";
  })();

  return (
    <div
      className="flex items-center gap-2 rounded-sm border px-2 py-1 font-mono text-[10px] uppercase tracking-widest"
      role="status"
      aria-live="polite"
      aria-label={`Link status ${ddilMode}, ${freshKind.toLowerCase()} ${freshLabel}`}
      style={{
        color: tone,
        borderColor: tone,
        background: `color-mix(in oklab, ${tone} 10%, var(--color-surface))`,
      }}
    >
      <span className="relative flex h-2 w-2" aria-hidden>
        {isDegraded && (
          <span
            className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
            style={{ background: tone }}
          />
        )}
        <span
          className="relative inline-flex h-2 w-2 rounded-full"
          style={{ background: tone }}
        />
      </span>
      <span className="text-[var(--color-text-muted)]">LINK ·</span>
      <span className="font-semibold">{ddilMode}</span>
      <span className="text-[var(--color-text-muted)]">·</span>
      <span className="text-[var(--color-text-muted)]">{freshKind}</span>
      <span className="tabular-nums text-[var(--color-text-secondary)]">{freshLabel}</span>
      {tail && (
        <>
          <span className="text-[var(--color-text-muted)]">—</span>
          <span className="text-[var(--color-text-secondary)]">{tail}</span>
        </>
      )}
      {queueDepth > 0 && (
        <>
          <span className="text-[var(--color-text-muted)]">·</span>
          <span style={{ color: "var(--color-warning)" }}>
            {queueDepth} write{queueDepth === 1 ? "" : "s"} queued
          </span>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MDM 2026 stage-pivot — four hero use-case tiles. Replaces the 5-tile
// operator grid when the store is in `stageMode`. Each tile is a cold-
// open into one of the four use-case surfaces; the deeper signal
// (alerts / shortages / MC% / audit) is reachable from inside that
// surface, but the bridge itself is intentionally choice-first on stage.
//
// The tile chrome is deliberately heavier than the operator grid so the
// audience can read it from the back of the room. We give each tile a
// large title, a one-line "what" subtitle, and a one-line "why this
// matters" caption pulled from the stage script.
// ---------------------------------------------------------------------------
type StageTileKey = "sentry" | "pulse" | "bastion";

interface StageTileSpec {
  key: StageTileKey;
  number: string;     // "01" — read-aloud sequence cue for the host
  title: string;      // SENTRY
  subtitle: string;   // "Classification & release"
  blurb: string;      // body copy (1–2 lines)
  accent: string;     // CSS var for the tile rail / number colour
  to: string;         // route navigated on click
}

// Order locked by the WP-2 spec: SENTRY (UC 14) → PULSE (UC 13) →
// BASTION (UC 15). The badge is the hackathon use-case number (NOT a
// re-numbered "01/02/03" sequence) so the audience can match each tile
// back to the published call.
const STAGE_TILES: StageTileSpec[] = [
  {
    key: "sentry",
    number: "14",
    title: "SENTRY",
    subtitle: "CUI AUTO-TAGGING — DoDM 5200.01",
    blurb:
      "Auto-tag, classify, and release intel with a hash-chained reason — every export ships its own audit ticket.",
    accent: "var(--color-info)",
    to: "/sentry",
  },
  {
    key: "pulse",
    number: "13",
    title: "PULSE",
    subtitle: "PARTS DEMAND FORECASTING — CONTESTED LOG",
    blurb:
      "Forecast Class IX failures before they ground the fleet. MC% by unit, with the maintenance moves the model would make.",
    accent: "var(--color-warning)",
    to: "/pulse",
  },
  {
    key: "bastion",
    number: "15",
    title: "BASTION",
    subtitle: "INSTALLATION COP AGGREGATOR",
    blurb:
      "Gates, utilities, emergency, weather, sensors — fused on one COP. Detection to FPCON CHARLIE in seconds, not minutes.",
    accent: "var(--color-danger)",
    to: "/bastion",
  },
];

function StageTile({ spec }: { spec: StageTileSpec }) {
  const nav = useNavigate();
  return (
    <Pressable
      onClick={() => nav(spec.to)}
      aria-label={`${spec.title} — ${spec.subtitle}`}
      block
      className="group relative flex h-full flex-col justify-between overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-5 transition-colors hover:border-[var(--color-border-active)]"
    >
      {/* Left rail accent — colour-codes the tile to its use case */}
      <div
        className="pointer-events-none absolute inset-y-0 left-0 w-1"
        style={{ background: spec.accent }}
        aria-hidden
      />
      <div className="flex items-baseline gap-3">
        <span
          className="font-mono text-3xl font-semibold tabular-nums"
          style={{ color: spec.accent }}
          aria-hidden
        >
          {spec.number}
        </span>
        <div className="flex flex-col">
          <span className="font-mono text-2xl font-semibold uppercase tracking-[0.18em] text-[var(--color-text)]">
            {spec.title}
          </span>
          <span className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-text-muted)]">
            USE CASE {spec.number} · {spec.subtitle}
          </span>
        </div>
      </div>
      <p className="mt-3 text-[15px] leading-relaxed text-[var(--color-text-secondary)]">
        {spec.blurb}
      </p>
      <div className="mt-4 flex items-center justify-between">
        <span
          className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)] group-hover:text-[var(--color-text-secondary)]"
        >
          Open surface
        </span>
        <span
          className="font-mono text-lg leading-none text-[var(--color-text-muted)] group-hover:text-[var(--color-text)]"
          aria-hidden
        >
          →
        </span>
      </div>
    </Pressable>
  );
}

function StageGrid() {
  return (
    <div className="flex h-full min-h-0 flex-col gap-5 overflow-hidden bg-[var(--color-bg)] p-6">
      {/* WP-2 thesis strap — exact copy from the work order. Lives ABOVE
       * the four tiles so the audience reads the claim before picking a
       * use case to walk. */}
      <div>
        <h1 className="font-sans text-2xl font-semibold leading-tight tracking-tight text-[var(--color-text)]">
          One OS · One dataset · One audit chain · Four use cases solved.
        </h1>
        <p className="mt-2 font-mono text-[11px] uppercase tracking-widest text-[var(--color-text-muted)]">
          SPIRE · Decision Surface · pick a use-case tile to drive the live surface
        </p>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 md:grid-cols-2">
        {STAGE_TILES.map((s) => (
          <StageTile key={s.key} spec={s} />
        ))}
      </div>
      {/* Built-by strap — placeholder name kept inside braces per spec
       * so the host can grep & swap it before stage. Do NOT inline a
       * concrete team identifier here without an explicit go from the
       * presenter. */}
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-3">
        <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
          Presented by
        </div>
        <div className="mt-1 font-sans text-sm text-[var(--color-text-secondary)]">
          Built by {`{TEAM_NAME_PLACEHOLDERS}`} · MDM 2026
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tile 6 — Recommended actions (GC-1). Closes the decision loop the other
// tiles open: alerts/shortages name the problem, this names the fix.
// ---------------------------------------------------------------------------
const ACTION_BADGE: Record<RecommendedAction["kind"], { label: string; tone: string }> = {
  cannibalize: { label: "CANNIB", tone: "var(--color-warning)" },
  expedite: { label: "EXPEDITE", tone: "var(--color-info)" },
  cross_level: { label: "X-LEVEL", tone: "var(--color-primary)" },
  redistribute: { label: "REDIST", tone: "var(--color-primary)" },
};

type RankedAction = RecommendedAction & { asset_id: string; unit_name: string };

function RecommendTile({
  data,
  error,
}: {
  data: RecommendActionsResponse | null;
  error: string | null;
}) {
  const nav = useNavigate();
  const drill = () => nav("/pulse/forecast");

  // One best action per asset, ranked across the fleet, top 3.
  const top: RankedAction[] = (data?.assets ?? [])
    .map((a) => {
      const best = [...a.actions].sort((x, y) => y.score - x.score)[0];
      return best ? { ...best, asset_id: a.asset_id, unit_name: a.unit_name } : null;
    })
    .filter((x): x is RankedAction => x !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  return (
    <Tile label="Recommended Actions" drillLabel="PULSE" onDrill={drill}>
      {error && !data ? (
        <ErrorState title="Recommendations unavailable" description={error} />
      ) : !data ? (
        <TileChromePressable onDrill={drill} ariaLabel="Recommendations loading — open PULSE forecast">
          <LoadingState label="Computing actions" />
        </TileChromePressable>
      ) : top.length === 0 ? (
        <TileChromePressable onDrill={drill} ariaLabel="No recommended actions — open PULSE forecast">
          <EmptyState title="No actions recommended" description="No in-scope asset is forecast past its readiness threshold." />
        </TileChromePressable>
      ) : (
        <>
          <ul className="flex flex-col gap-1.5">
            {top.map((a) => {
              // Tolerate any kind the backend emits beyond the known set —
              // an unmapped kind must degrade, not crash the whole view.
              const badge = ACTION_BADGE[a.kind] ?? {
                label: (a.kind ?? "action").replace(/_/g, " ").toUpperCase(),
                tone: "var(--color-primary)",
              };
              const deltaPts = Math.round((a.mc_delta_pct ?? 0) * 100);
              return (
                <li key={`${a.asset_id}-${a.kind}`}>
                  <Pressable
                    onClick={drill}
                    aria-label={`${badge.label}: ${a.title} · ${a.unit_name} · +${deltaPts}pp MC in ~${a.time_to_effect_hours}h — open in PULSE`}
                    className="flex items-center gap-2 rounded-sm border-l-2 px-2 py-1 hover:bg-[color-mix(in_oklab,var(--color-text)_8%,transparent)]"
                    style={{
                      borderLeftColor: badge.tone,
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
                        {a.title}
                      </div>
                      <div className="truncate font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
                        {a.unit_name} · ~{a.time_to_effect_hours}h
                      </div>
                    </div>
                    {deltaPts > 0 && (
                      <div
                        className="font-mono text-[12px] font-semibold tabular-nums tracking-wider text-[var(--color-success)]"
                        aria-hidden
                      >
                        +{deltaPts}pp
                      </div>
                    )}
                  </Pressable>
                </li>
              );
            })}
          </ul>
          <TileBodyFiller onDrill={drill} />
        </>
      )}
    </Tile>
  );
}

// ---------------------------------------------------------------------------
// View root
// ---------------------------------------------------------------------------
export function DecisionBridgeView() {
  const role = useSpireStore((s) => s.role);
  // Polling cadences are extended when the operator drives the comms
  // control out of CONNECTED — a degraded lane shouldn't get hammered. The
  // pollers re-mount on mode change so the new cadence takes effect at the
  // next tick, not whenever the existing back-off would have fired.
  const ddilMode = useSpireStore((s) => s.ddilMode);
  const cadenceMult = commsCadenceMultiplier(ddilMode);
  const stageMode = useSpireStore((s) => s.stageMode);
  const nav = useNavigate();
  // Stage-mode short-circuit. The four-up grid is rendered in place of
  // the operator's 5-tile signal grid; no live polling fires below
  // because the stage tiles are story tiles, not signal tiles. Operator
  // sessions (the default) keep the original behaviour byte-for-byte.
  if (stageMode) {
    return <StageGrid />;
  }

  // Task #183 — empty/populated branch driver. The hero card and the
  // tile-level placeholders both read from this hook. ``refresh()`` is
  // called from ``StageIngestHero.onIngested`` so the next render flips
  // every tile from "awaiting GCSS-MC ingest" to live data.
  const { status: datasetStatus, refresh: refreshDatasetStatus } = useDatasetStatus();
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
  const [recs, setRecs] = useState<RecommendActionsResponse | null>(null);
  const [recsErr, setRecsErr] = useState<string | null>(null);
  // Wall-clock of the most recent successful tile fetch — feeds the link
  // strip's "LAST SYNC Ns AGO" line. Updated by every poller below.
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null);
  const noteSuccess = () => setLastSuccessAt(Date.now());

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
          noteSuccess();
        }
      } catch (err) {
        if (!cancelled) setMissionErr(formatApiError(err));
      }
    };
    load();
    const id = window.setInterval(load, 5 * 60 * 1000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  // BASTION COP — drives alert→building resolution. Skip while empty
  // so cop never holds the {empty:true,...} envelope (which has no
  // .units and would throw inside resolveAlertTarget). Re-runs once
  // when the dataset hydrates.
  useEffect(() => {
    if (datasetStatus?.empty) {
      setCop(null);
      return;
    }
    let cancelled = false;
    api.bastion.cop()
      .then((v) => {
        if (cancelled || isEmptyEnvelope(v)) return;
        setCop(v);
      })
      .catch(() => { /* drill-through tolerantly falls back to /bastion sans focus */ });
    return () => { cancelled = true; };
  }, [datasetStatus?.empty]);

  // Alerts — 10s cadence (multiplier=1 disables the steady-state back-off
  // because alert mix is the operator's primary scan signal). The cadence
  // stretches by `cadenceMult` when the lane is degraded (LIM 4x / INT 6x
  // / DISC 8x) — Task #47.
  useEffect(() => {
    const interval = 10_000 * cadenceMult;
    const ctl = pollWithBackoff(() => api.decisionBridge.alerts(3), {
      baseMs: interval,
      maxMs: interval,
      multiplier: 1,
      onResult: (v) => { setAlerts(v); setAlertsErr(null); noteSuccess(); },
      onError: (err) => setAlertsErr(formatApiError(err)),
    });
    return () => ctl.stop();
  }, [role, cadenceMult]);

  // Shortages — 60s cadence (logistics signal evolves slowly).
  useEffect(() => {
    const interval = 60_000 * cadenceMult;
    const ctl = pollWithBackoff(() => api.decisionBridge.shortages(3), {
      baseMs: interval,
      maxMs: interval,
      multiplier: 1,
      onResult: (v) => { setShortages(v); setShortagesErr(null); noteSuccess(); },
      onError: (err) => setShortagesErr(formatApiError(err)),
    });
    return () => ctl.stop();
  }, [role, cadenceMult]);

  // MC% by unit — 60s cadence.
  useEffect(() => {
    const interval = 60_000 * cadenceMult;
    const ctl = pollWithBackoff(() => api.decisionBridge.mcByUnit(3), {
      baseMs: interval,
      maxMs: interval,
      multiplier: 1,
      onResult: (v) => { setMc(v); setMcErr(null); noteSuccess(); },
      onError: (err) => setMcErr(formatApiError(err)),
    });
    return () => ctl.stop();
  }, [role, cadenceMult]);

  // Audit health — 5s base cadence (highest cadence for the security
  // tile). Identical-response back-off is *intentionally* enabled (no
  // multiplier:1 override): an unchanged hash chain doesn't need to be
  // refetched every five seconds — the steady-state load drops to ~1/min
  // (Task #47) but a real anomaly snaps the cadence back to baseMs. Caps
  // at maxMs to bound the worst case during quiet stretches.
  useEffect(() => {
    const base = 5_000 * cadenceMult;
    const cap = 60_000 * cadenceMult;
    const ctl = pollWithBackoff(() => api.decisionBridge.audit(5), {
      baseMs: base,
      maxMs: cap,
      // default multiplier (1.5) — restored per Task #47 so an unchanging
      // chain stops hammering at 5s.
      onResult: (v) => { setAudit(v); setAuditErr(null); noteSuccess(); },
      onError: (err) => setAuditErr(formatApiError(err)),
    });
    return () => ctl.stop();
  }, [cadenceMult]);

  // Recommended actions (GC-1) — 60s cadence; same slow-logistics tempo as
  // shortages. Role-scoped server-side, so it reflects the operator's units.
  useEffect(() => {
    const interval = 60_000 * cadenceMult;
    const ctl = pollWithBackoff(() => api.pulse.recommendActions({ top: 6 }), {
      baseMs: interval,
      maxMs: interval,
      multiplier: 1,
      onResult: (v) => { setRecs(v); setRecsErr(null); noteSuccess(); },
      onError: (err) => setRecsErr(formatApiError(err)),
    });
    return () => ctl.stop();
  }, [role, cadenceMult]);

  const fallbackPath = useMemo(() => ROLE_DEFAULT_VIEW[role] ?? "/bastion", [role]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-x-hidden overflow-y-auto bg-[var(--color-bg)] p-3">
      {/* Quiet eyebrow — view name + escape hatch on a single thin row.
       * Demo subtitle moves into the eyebrow itself (DemoOnly) so the
       * operational pilot reads as `BRIDGE     skip → BASTION` and
       * nothing else. The h1 + paragraph stack was the loudest single
       * piece of chrome on the page; trimming it reclaims ~60px of
       * vertical space without losing the breadcrumb cue. */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-3">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--color-text-muted)]">
            Bridge
          </span>
          <DemoOnly>
            <span className="hidden truncate font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)] md:inline">
              click any tile to drill
            </span>
          </DemoOnly>
        </div>
        <Pressable
          onClick={() => nav(fallbackPath)}
          aria-label={`Skip to ${fallbackPath}`}
          block={false}
          className="shrink-0 rounded-sm font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          skip → {fallbackPath.replace(/^\//, "").toUpperCase()}
        </Pressable>
      </div>

      {/* Link-status strip — only renders when the lane is degraded, a
       * write is queued, or a sync is in flight. Happy path is silent. */}
      <LinkStatusStrip lastSuccessAt={lastSuccessAt} />

      {/* Task #183 — stage live-ingest mode. While the dataset is empty
       * the hero card occupies the row below the link-status strip and
       * lets the data_custodian / security_manager drag in the three
       * sanitized GCSS-MC CSVs. The tile grid stays mounted underneath
       * (each tile renders its own "awaiting GCSS-MC ingest" placeholder)
       * so the layout doesn't reflow when ingest completes. */}
      {datasetStatus?.empty && (
        <StageIngestHero
          onIngested={() => {
            refreshDatasetStatus();
          }}
        />
      )}

      {/* Hero tile grid — auto-fit responsive with generous breathing room.
       * The grid packs as many 22rem-min tiles per row as fits, no
       * breakpoints. Reflows smoothly from 320px (1 col) to 2560px+
       * without code branches.
       *
       * Each tile is a @container so the tile's own internal layout
       * adapts to its actual rendered width, not the viewport. */}
      <div
        className="grid min-h-0 flex-1 gap-4 sm:gap-5"
        style={{
          gridTemplateColumns: "repeat(auto-fit, minmax(min(22rem, 100%), 1fr))",
          // Rows divide the available flex height (minmax floor keeps tiles
          // legible on short windows). On the standard wide layout this makes
          // the 3x2 grid fill the viewport exactly — no page scroll — instead
          // of a fixed 15rem-per-row that spilled just past the fold.
          gridAutoRows: "minmax(11rem, 1fr)",
        }}
      >
        <div className="@container min-h-0">
          <MissionTile mission={mission} error={missionErr} />
        </div>
        <div className="@container min-h-0">
          <AlertsTile data={alerts} cop={cop} error={alertsErr} />
        </div>
        <div className="@container min-h-0">
          <ShortagesTile data={shortages} error={shortagesErr} />
        </div>
        <div className="@container min-h-0">
          <McTile data={mc} error={mcErr} />
        </div>
        <div className="@container min-h-0">
          <AuditTile data={audit} error={auditErr} />
        </div>
        <div className="@container min-h-0">
          <RecommendTile data={recs} error={recsErr} />
        </div>
      </div>
    </div>
  );
}
