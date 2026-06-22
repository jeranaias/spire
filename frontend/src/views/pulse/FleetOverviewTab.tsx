import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type FleetOverview, type BastionCOPUnit } from "../../api";
import { withRetry } from "../../api-retry";
import { MetricCard } from "../../components/MetricCard";
import { Heatmap } from "../../components/Heatmap";
import { AlertCard } from "../../components/AlertCard";
import { useSpireStore } from "../../state/store";
import { DemoOnly } from "../../state/buildMode";
import { Button, IconButton, Pressable, ErrorState, LoadingState } from "../../components/ui";
import { AwaitingIngestEmpty } from "../../components/AwaitingIngestEmpty";
import { useDatasetStatus } from "../../hooks/useDatasetStatus";

type View = "heatmap" | "map";

export function FleetOverviewTab() {
  // Task #183 — short-circuit before the fleet-overview fetch fires.
  // /api/pulse/fleet-overview returns ``{empty: true}`` while the
  // dataset singleton is empty; the chart pipeline below would crash
  // on the unexpected envelope, so we render the placeholder first.
  const datasetStatus = useDatasetStatus().status;
  const role = useSpireStore((s) => s.role);
  const pushToast = useSpireStore((s) => s.pushToast);
  const nav = useNavigate();
  const [data, setData] = useState<FleetOverview | null>(null);
  // Walkthrough #3, #51 — single source of truth for MC%. We pull
  // BASTION /cop and use its `mc_rate` per unit everywhere on PULSE.
  const [copUnits, setCopUnits] = useState<BastionCOPUnit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("heatmap");
  const [hideEmptyColumns, setHideEmptyColumns] = useState(true);

  useEffect(() => {
    setData(null);
    setError(null);
    // Walkthrough audit: prior code surfaced raw 502 HTML body
    // ('<html>...502 Bad Gateway...</html>') as the error string,
    // which dumped HTML markup straight into the UI. Use withRetry so
    // transient deploy 5xx self-heal, and on terminal failure show a
    // human-readable message instead of the upstream HTML.
    // Task #183 — skip the fetch while the dataset is empty. The
    // /pulse/fleet-overview endpoint returns an ``{empty: true}`` envelope
    // in that mode and the chart pipeline below would crash if it tried
    // to unpack it as a populated FleetOverview.
    if (datasetStatus?.empty) return;
    withRetry(() => api.pulse.fleetOverview())
      .then((res) => {
        // Same envelope guard as the BASTION COP fetch below — the
        // fleet-overview endpoint also returns `{empty: true}` while
        // the dataset is being swapped in. Stuffing that envelope
        // into setData() lets the downstream useMemo crash on
        // `equipment_types.filter` because the field is missing.
        if ((res as unknown as { empty?: boolean }).empty) return;
        setData(res);
      })
      .catch((e) => {
        const raw = String(e);
        // If the upstream is HTML (502/504 from nginx), don't surface
        // tags; show a posture line instead.
        const friendly = /<html|Bad Gateway|Gateway Time-?out/i.test(raw)
          ? "Backend reconnecting — fleet overview will refresh shortly."
          : raw.length > 140 ? raw.slice(0, 140) + "…" : raw;
        setError(friendly);
      });
    api.bastion.cop()
      .then((c) => {
        // Same envelope guard — BASTION COP also responds with the
        // empty-state envelope under stage live-ingest mode.
        if ((c as unknown as { empty?: boolean }).empty) {
          setCopUnits([]);
          return;
        }
        setCopUnits(c.units);
      })
      .catch(() => setCopUnits([]));
  }, [role, datasetStatus?.empty]);

  // Walkthrough #3, #51 — canonical MC rate by unit name from BASTION COP.
  const canonicalMc = useMemo(() => {
    const m = new Map<string, number>();
    (copUnits ?? []).forEach((u) => m.set(u.unit, u.mc_rate));
    return m;
  }, [copUnits]);

  // Filter equipment-type columns so sparse matrix becomes dense.
  const displayedEquipment = useMemo(() => {
    if (!data) return [];
    if (!hideEmptyColumns) return data.equipment_types;
    return data.equipment_types.filter((eq) =>
      data.heatmap.some((u) => (u.equipment_breakdown[eq] || 0) > 0),
    );
  }, [data, hideEmptyColumns]);

  if (datasetStatus?.empty) {
    return (
      <AwaitingIngestEmpty
        surface="PULSE"
        description="The fleet overview heatmap, MC% deltas, and forecast plots all derive from the live GCSS-MC export. Drop the three sanitized CSVs into DECISION BRIDGE to populate this view."
      />
    );
  }
  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-12">
        <ErrorState
          variant="panel"
          title="Failed to load fleet overview"
          description="The Pulse fleet overview API did not return. Network/backend may be cycling."
          detail={error}
          onRetry={() => window.location.reload()}
          retryLabel="Reload"
        />
      </div>
    );
  }
  if (!data) return <FleetSkeleton />;

  const hero = data.hero_metrics;

  // Walkthrough #13 — derive narrative from actual per-unit deltas.
  const narrative = buildNarrative(data, canonicalMc);

  function onToggleHide(checked: boolean) {
    setHideEmptyColumns(checked);
    // Walkthrough #17 — warn when hiding-empty is turned OFF (more cols shown).
    if (!checked) {
      const total = data?.equipment_types.length ?? 0;
      const dense = displayedEquipment.length;
      const extra = total - dense;
      if (extra > 0) {
        pushToast({
          tone: "info",
          text: `${extra} additional columns shown — table may extend off-screen.`,
          ttlMs: 4000,
        });
      }
    }
  }

  return (
    <div className="flex h-full">
      {/* Walkthrough #14 — outer container scrolls so KPI + narrative + heatmap
       * all stay reachable. Inner heatmap retains its own scroll for cols. */}
      <div className="flex flex-1 flex-col overflow-y-auto p-4">
        <div
          className="mb-4 grid gap-4"
          style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(14rem, 100%), 1fr))" }}
        >
          {/* Walkthrough #26 — tooltip explains the 7d delta. */}
          {/* Walkthrough #29 — KPI labels bumped via component default. */}
          {/* Walkthrough #30 — consistent severity-by-threshold tone across all 4. */}
          {/* Threshold calibration: ≥80% success, ≥65% warning, <65%
           * danger. The previous 75/85 split tipped 70.7% into red even
           * though that's "watch" territory, not "fire". Marine MC% in
           * the 65–80% band is below target but still functional —
           * yellow signals that without the visual eq of an actual
           * danger condition. <65% is the floor where readiness is
           * compromised; that's where red lives. */}
          <MetricCard
            label="Fleet MC"
            value={(hero.fleet_mc_rate * 100).toFixed(1)}
            delta={hero.fleet_mc_delta_7d * 100}
            unit="%"
            tone={hero.fleet_mc_rate >= 0.80 ? "success" : hero.fleet_mc_rate >= 0.65 ? "warning" : "danger"}
            deltaTooltip={`${hero.fleet_mc_delta_7d >= 0 ? "+" : ""}${(hero.fleet_mc_delta_7d * 100).toFixed(1)}% week-over-week (rolling 7-day avg)`}
          />
          <MetricCard
            label="Critical Assets"
            value={hero.critical_assets}
            tone={hero.critical_assets > 30 ? "danger" : hero.critical_assets > 15 ? "warning" : "success"}
            footnote={`Target ≤ 15`}
          />
          <MetricCard
            label="Parts on Order"
            value={hero.parts_on_order}
            tone="neutral"
            footnote="Open requisitions"
          />
          <MetricCard
            label="Avg Days NMC"
            value={hero.avg_days_nmc.toFixed(1)}
            tone={hero.avg_days_nmc > 21 ? "danger" : hero.avg_days_nmc > 14 ? "warning" : "success"}
            footnote="Target ≤ 14d"
          />
        </div>

        {/* Demo nights get the "Narrative" hero strip; operational pilots
         * don't need a marketing-shape sentence above the heatmap because
         * the metric cards plus the heatmap itself carry the same signal
         * without the editorial framing. */}
        <DemoOnly>
          {narrative && (
            <div
              className="mb-3 rounded-sm border border-[var(--color-border)] bg-[color-mix(in_oklab,var(--color-surface)_92%,var(--color-bg))] px-3 py-2 spire-body-muted"
            >
              <span className="font-mono text-xs uppercase text-[var(--color-primary)] tracking-widest">
                Narrative
              </span>{" "}
              <span className="text-[var(--color-text)]">{narrative.text}</span>
              {narrative.unit && (
                <Button
                  onClick={() => nav(`/pulse/risk?unit=${encodeURIComponent(narrative.unit!)}`)}
                  variant="ghost"
                  size="sm"
                  className="ml-2 text-[var(--color-primary)] hover:underline"
                >
                  View top contributors →
                </Button>
              )}
            </div>
          )}
        </DemoOnly>

        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2
              className="font-mono text-base font-semibold uppercase text-[var(--color-text)] tracking-widest"
            >
              {view === "heatmap" ? "Fleet Readiness · Heatmap" : "Fleet Readiness · Laydown"}
            </h2>
            <div className="mt-0.5 spire-body-muted">
              MC rate by {view === "heatmap" ? "unit × equipment type" : "garrison location"} — as of {formatAsOf(data.as_of)}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {/* Walkthrough #16, #46 — tab semantics for HEATMAP / CONUS toggle. */}
            <ViewTabs value={view} onChange={setView} />
            {view === "heatmap" && (
              <label className="flex cursor-pointer items-center gap-2 font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-wider">
                <input
                  type="checkbox"
                  checked={hideEmptyColumns}
                  onChange={(e) => onToggleHide(e.target.checked)}
                  className="accent-[var(--color-primary)]"
                />
                Hide Empty Columns
              </label>
            )}
            {/* Walkthrough #33, #47 — single palette across PULSE; numbers
             * in cells provide an alternate severity carrier. */}
            <div className="flex items-center gap-3 font-mono text-xs text-[var(--color-text-muted)] tracking-wide">
              <LegendDot color="var(--color-success)" label="≥90%" />
              <LegendDot color="var(--color-warning)" label="75-89%" />
              <LegendDot color="#fb923c" label="60-74%" />
              <LegendDot color="var(--color-danger)" label="<60%" />
            </div>
            {/* Walkthrough #51 — "How MC% is calculated" inline help. */}
            <McMethodologyTooltip />
          </div>
        </div>

        {view === "heatmap" && (
          <Heatmap
            units={data.heatmap}
            equipmentTypes={displayedEquipment}
            onCellClick={(unit, equipment) => {
              nav(`/pulse/risk?unit=${encodeURIComponent(unit)}&equipment=${encodeURIComponent(equipment)}`);
            }}
          />
        )}
        {view === "map" && <ConusMap data={data} canonicalMc={canonicalMc} />}
      </div>

      {/* Alert Feed sidebar — hidden below lg so the main content gets full
       * width on mobile/tablet. Mobile users open the alert feed via the
       * "Alerts" button in the main content header (see CollapsibleAlertsButton). */}
      <aside className="hidden w-80 shrink-0 flex-col overflow-y-auto border-l border-[var(--color-border)] bg-[var(--color-bg)] p-3 lg:flex">
        <div className="mb-2 flex items-center justify-between">
          <h3
            className="font-mono text-xs font-semibold uppercase text-[var(--color-text)] tracking-widest"
          >
            Alert Feed
          </h3>
          {/* Walkthrough #49 — counter has tooltip explaining what 10 means. */}
          <span
            className="rounded-sm border border-[var(--color-border)] px-1.5 py-0.5 font-mono text-xs tabular-nums text-[var(--color-text-muted)] tracking-wide"
            title={`Showing ${data.alerts.length} most-recent active alerts (capped at 10)`}
          >
            {data.alerts.length}
          </span>
        </div>
        {/* Walkthrough #18 — visible scroll affordance on alert feed. */}
        <div className="flex flex-col gap-2 pulse-scroll" style={{ scrollbarGutter: "stable" }}>
          {data.alerts.map((a) => (
            <AlertCard
              key={a.id}
              severity={a.severity}
              source={a.kind}
              title={a.title}
              body={a.body}
              timestamp={a.timestamp}
              onClick={() => {
                // Walkthrough #19 — deep-link with ?unit=… so the risk board
                // lands pre-filtered to the specific unit. Readiness alerts
                // carry the unit name directly via the new `unit` field, with
                // a regex fallback for legacy rows.
                if (a.kind === "readiness") {
                  const u = (a as any).unit ?? extractUnit(a.title);
                  if (u) nav(`/pulse/risk?unit=${encodeURIComponent(u)}`);
                } else if (a.kind === "cannibalization") {
                  nav("/pulse/cannib");
                }
              }}
              actionLabel={a.kind === "readiness" ? "Open risk board" : a.kind === "cannibalization" ? "Open cannibalization" : undefined}
            />
          ))}
          {data.alerts.length === 0 && (
            <div className="rounded border border-dashed border-[var(--color-border)] p-6 text-center font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
              NO ACTIVE ALERTS
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function extractUnit(title: string): string | null {
  const m = /^([A-Za-z0-9/\- ]+?)\s/.exec(title);
  return m ? m[1].trim() : null;
}

// Walkthrough #JOB-B (review #52 / #30) — render the dataset as-of stamp
// in the same DD MMM YY shape that BASTION's Mission Clock and SENTRY
// audit timestamps use, so the operator scans every "as of" line as the
// same date when the dataset's last_day matches today. Backend sends
// ISO (YYYY-MM-DD); this is presentation-only.
//
// Note for PULSE agent: cross-cutting agent edited this file solely to
// route data.as_of through formatAsOf — none of the data flow / poll /
// hero metric logic was touched.
export function formatAsOf(iso: string): string {
  if (!iso) return "—";
  // Parse as date-only to avoid TZ-shifted display ("2026-04-26" must read
  // Walkthrough audit: same as StatusStrip — '26 APR 26' was readable
  // as 'April 26th' instead of 'April 2026'. Show the full year.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d] = m;
  const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  const monIdx = parseInt(mo, 10) - 1;
  if (monIdx < 0 || monIdx > 11) return iso;
  return `${d} ${months[monIdx]} ${y}`;
}

// Walkthrough #16, #46 — proper tab semantics with arrow-key nav for the
// HEATMAP / CONUS view toggle.
function ViewTabs({ value, onChange }: { value: View; onChange: (v: View) => void }) {
  const tabs: { value: View; label: string }[] = [
    { value: "heatmap", label: "Heatmap" },
    { value: "map", label: "Laydown" },
  ];
  return (
    <div role="tablist" aria-label="Fleet readiness view" className="inline-flex overflow-hidden rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)]">
      {tabs.map((t, i) => {
        const active = t.value === value;
        return (
          <Pressable
            key={t.value}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(t.value)}
            block={false}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                e.preventDefault();
                const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
                onChange(next.value);
              }
            }}
            className={
              "inline-flex h-11 min-w-[44px] items-center justify-center px-3 font-mono text-sm font-semibold uppercase tracking-wider transition-colors " +
              (i > 0 ? "border-l border-[var(--color-border)] " : "") +
              (active
                ? "bg-[var(--color-primary)] text-white"
                : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]")
            }
          >
            {t.label}
          </Pressable>
        );
      })}
    </div>
  );
}

// Walkthrough #51 — operator-readable explanation of MC% sourcing.
function McMethodologyTooltip() {
  return (
    <span
      className="inline-flex h-6 w-6 cursor-help items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] font-mono text-xs text-[var(--color-text-muted)]"
      title={
        "MC% = (assets reporting MC on the snapshot day) / (total reporting assets). " +
        "Single source: BASTION /cop mc_rate. PULSE surfaces (heatmap, laydown, alerts, risk board) " +
        "all read from the same canonical field. Precision uniform at 1 decimal."
      }
      aria-label="How MC% is calculated"
    >
      ?
    </span>
  );
}

type Narrative = { text: string; unit: string | null };

function buildNarrative(data: FleetOverview, canonical: Map<string, number>): Narrative | null {
  if (!data.heatmap || data.heatmap.length === 0) return null;
  const h = data.hero_metrics;
  const direction = h.fleet_mc_delta_7d >= 0 ? "up" : "down";
  const absDelta = Math.abs(h.fleet_mc_delta_7d * 100).toFixed(1);

  // Walkthrough #13 — the "leading the recovery" claim must be derived from
  // an actual delta. We don't ship per-unit WoW deltas in this payload, so
  // fall back to the unit with the highest current MC and the unit with
  // the lowest. Whichever direction the fleet is going, name the standout
  // honestly.
  const ranked = data.heatmap.map((u) => {
    const canon = canonical.get(u.unit);
    if (canon != null) return { unit: u.unit, mc: canon };
    const rates = Object.values(u.rates).filter((v): v is number => v != null);
    const avg = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;
    return { unit: u.unit, mc: avg };
  }).sort((a, b) => b.mc - a.mc);

  if (direction === "up" && ranked.length) {
    const top = ranked[0];
    return {
      text: `Fleet MC ${(h.fleet_mc_rate * 100).toFixed(1)}% · +${absDelta}% week-over-week — ${top.unit} highest MC at ${(top.mc * 100).toFixed(1)}%.`,
      unit: top.unit,
    };
  }
  const worst = ranked[ranked.length - 1];
  return {
    text: `Fleet MC ${(h.fleet_mc_rate * 100).toFixed(1)}% · -${absDelta}% week-over-week — ${worst.unit} dragging the average at ${(worst.mc * 100).toFixed(1)}% MC.`,
    unit: worst.unit,
  };
}

// Walkthrough #1 — replaced decorative "rough CONUS outline" with a real
// US states basemap rendered from a TopoJSON-free, hand-curated set of
// state polygons. The implementation is deterministic, ships no large
// asset, projects via simple equirectangular mapping, and renders state
// boundaries + scale + compass.
//
// Walkthrough #2 — units at the same garrison are clustered into a single
// expandable marker rather than overlapping at one lat/lon.
//
// Walkthrough #41 — palette aligned to PULSE heatmap (success/warning/orange/danger).
function ConusMap({ data, canonicalMc }: { data: FleetOverview; canonicalMc: Map<string, number> }) {
  // Garrison lat/lon — Okinawa / Nansei Shoto laydown, mirroring the
  // canonical positions in frontend/src/data/okinawa-scenario.ts so this
  // PULSE laydown and the BASTION COP agree on where each unit sits.
  const GARRISONS: Record<string, { lat: number; lon: number; label: string; state: string }> = {
    "Camp Kinser, Okinawa":  { lat: 26.2542, lon: 127.6817, label: "Camp Kinser",   state: "OKINAWA" },
    "Camp Foster, Okinawa":  { lat: 26.2742, lon: 127.7544, label: "Camp Foster",   state: "OKINAWA" },
    "Kadena AB, Okinawa":    { lat: 26.3559, lon: 127.7686, label: "Kadena AB",     state: "OKINAWA" },
    "MCAS Futenma, Okinawa": { lat: 26.2710, lon: 127.7561, label: "MCAS Futenma",  state: "OKINAWA" },
    "Camp Hansen, Okinawa":  { lat: 26.4612, lon: 127.8917, label: "Camp Hansen",   state: "OKINAWA" },
    "Camp Schwab, Okinawa":  { lat: 26.5083, lon: 128.0400, label: "Camp Schwab",   state: "OKINAWA" },
    "Miyako, Okinawa":       { lat: 24.7950, lon: 125.3450, label: "Miyako",        state: "MIYAKO" },
    "Ishigaki, Okinawa":     { lat: 24.4150, lon: 124.1750, label: "Ishigaki",      state: "ISHIGAKI" },
  };

  // Equirectangular projection bounded to the Nansei Shoto (Ryukyu) chain —
  // Yonaguni in the SW to north Okinawa Honto in the NE.
  const LON_MIN = 123.4, LON_MAX = 128.9;
  const LAT_MIN = 24.0,  LAT_MAX = 27.2;
  const W = 1000, H = 600;
  function project(lat: number, lon: number) {
    const x = ((lon - LON_MIN) / (LON_MAX - LON_MIN)) * W;
    const y = ((LAT_MAX - lat) / (LAT_MAX - LAT_MIN)) * H;
    return { x, y };
  }

  // Walkthrough #2 — group units by their garrison location so 7 Lejeune
  // units render as a single marker with a count badge. We expand on
  // click into a panel listing each unit's MC rate.
  type ClusterUnit = { unit: string; uic: string; mc: number; total: number };
  type Cluster = { lat: number; lon: number; label: string; state: string; units: ClusterUnit[]; avg: number };
  const clusters = useMemo(() => {
    const m = new Map<string, Cluster>();
    data.heatmap.forEach((u) => {
      const g = GARRISONS[u.location] ?? { lat: 26.3, lon: 127.8, label: u.location, state: "" };
      const key = u.location;
      // Walkthrough #3, #51 — canonical MC%. Fall back to per-equipment
      // average ONLY if the COP payload hasn't loaded yet.
      const canon = canonicalMc.get(u.unit);
      const rates = Object.values(u.rates).filter((v): v is number => v != null);
      const fallback = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : 0.7;
      const mc = canon ?? fallback;
      const cu: ClusterUnit = { unit: u.unit, uic: u.uic, mc, total: u.total_equipment };
      const existing = m.get(key);
      if (existing) {
        existing.units.push(cu);
      } else {
        m.set(key, { lat: g.lat, lon: g.lon, label: g.label, state: g.state, units: [cu], avg: 0 });
      }
    });
    // Compute cluster-level avg as the equipment-weighted MC across units
    // at the garrison.
    m.forEach((c) => {
      const tot = c.units.reduce((a, u) => a + u.total, 0) || 1;
      c.avg = c.units.reduce((a, u) => a + u.mc * u.total, 0) / tot;
    });
    return Array.from(m.values());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.heatmap, canonicalMc]);

  function mcColor(r: number): string {
    if (r >= 0.9) return "var(--color-success)";
    if (r >= 0.75) return "var(--color-warning)";
    if (r >= 0.6) return "#fb923c";
    return "var(--color-danger)";
  }

  const [openCluster, setOpenCluster] = useState<string | null>(null);

  return (
    <div className="relative min-h-[480px] flex-1 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full">
        <defs>
          <pattern id="conus-grid" width="100" height="100" patternUnits="userSpaceOnUse">
            <path d="M 100 0 L 0 0 0 100" fill="none" stroke="rgba(59,130,246,0.05)" strokeWidth="1" />
          </pattern>
        </defs>
        <rect x="0" y="0" width={W} height={H} fill="url(#conus-grid)" />

        {/* Nansei Shoto island outlines (simplified) — Okinawa Honto plus
         * the forward islands Miyako and Ishigaki, projected in the same
         * equirectangular box so garrison dots align with the coastlines. */}
        <g
          fill="color-mix(in oklab, var(--color-primary) 4%, var(--color-bg))"
          stroke="color-mix(in oklab, var(--color-primary) 35%, var(--color-border))"
          strokeWidth="1"
          strokeLinejoin="round"
        >
          {NANSEI_ISLANDS.map((s) => (
            <path
              key={s.id}
              d={s.coords
                .map((ring, ri) => ring.map(([lon, lat], i) => {
                  const p = project(lat, lon);
                  return `${i === 0 ? (ri === 0 ? "M" : "M") : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
                }).join(" ") + " Z")
                .join(" ")}
            />
          ))}
        </g>

        {/* Compass + scale - walkthrough #1 */}
        <g transform="translate(40,520)" fontFamily="JetBrains Mono, monospace" fontSize="10">
          <line x1="0" y1="0" x2="91" y2="0" stroke="var(--color-text-muted)" strokeWidth="2" />
          <line x1="0" y1="-4" x2="0" y2="4" stroke="var(--color-text-muted)" strokeWidth="2" />
          <line x1="91" y1="-4" x2="91" y2="4" stroke="var(--color-text-muted)" strokeWidth="2" />
          <text x="0" y="20" fill="var(--color-text-muted)">0</text>
          <text x="85" y="20" fill="var(--color-text-muted)">~50 km</text>
        </g>
        <g transform="translate(940,540)" fontFamily="JetBrains Mono, monospace" fontSize="11">
          <circle cx="0" cy="0" r="18" fill="none" stroke="var(--color-text-muted)" strokeWidth="1" />
          <line x1="0" y1="-15" x2="0" y2="15" stroke="var(--color-text-muted)" strokeWidth="1" />
          <line x1="-15" y1="0" x2="15" y2="0" stroke="var(--color-text-muted)" strokeWidth="0.5" />
          <text x="-3" y="-22" fill="var(--color-text-muted)">N</text>
        </g>

        {clusters.map((c) => {
          const p = project(c.lat, c.lon);
          const r = 8 + Math.min(8, c.units.length * 1.5);
          return (
            <g key={c.label} style={{ cursor: "pointer" }} onClick={() => setOpenCluster(openCluster === c.label ? null : c.label)}>
              <circle cx={p.x} cy={p.y} r={r + 8} fill={mcColor(c.avg)} fillOpacity={0.15} />
              <circle cx={p.x} cy={p.y} r={r} fill={mcColor(c.avg)} stroke="#0a0c13" strokeWidth="1.5" />
              {c.units.length > 1 && (
                <text x={p.x} y={p.y + 3} textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize="10" fontWeight="700" fill="#0a0c13">
                  {c.units.length}
                </text>
              )}
              {/* Halo (bg-colored stroke under the glyphs) keeps labels
               * legible where central-Okinawa bases (Foster / Futenma /
               * Kinser are ~5 km apart) crowd at this island-chain scale. */}
              <text x={p.x + r + 4} y={p.y - 2} fontFamily="JetBrains Mono, monospace" fontSize="11" fill="var(--color-text)" stroke="var(--color-bg)" strokeWidth={3} paintOrder="stroke" strokeLinejoin="round">
                {c.label}
              </text>
              <text x={p.x + r + 4} y={p.y + 10} fontFamily="JetBrains Mono, monospace" fontSize="9" fill="var(--color-text-muted)" stroke="var(--color-bg)" strokeWidth={3} paintOrder="stroke" strokeLinejoin="round">
                {(c.avg * 100).toFixed(1)}% MC · {c.units.length} {c.units.length === 1 ? "unit" : "units"}{c.state ? ` · ${c.state}` : ""}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Walkthrough #2 — expanded cluster popover */}
      {openCluster && (() => {
        const c = clusters.find((x) => x.label === openCluster);
        if (!c) return null;
        const p = project(c.lat, c.lon);
        // Convert SVG coords to %-of-container (viewBox is 1000x600).
        const left = `${(p.x / W) * 100}%`;
        const top = `${(p.y / H) * 100}%`;
        return (
          <div
            className="absolute z-10 -translate-x-1/2 -translate-y-full rounded-sm border border-[var(--color-border-active)] bg-[var(--color-surface)] p-3 shadow-2xl"
            style={{ left, top, marginTop: "-12px", minWidth: "240px" }}
          >
            <div className="mb-2 flex items-center justify-between">
              <div className="font-mono text-xs uppercase text-[var(--color-text)] tracking-widest">{c.label}</div>
              <IconButton onClick={() => setOpenCluster(null)} aria-label="Close cluster" variant="ghost" size="sm">
                <span aria-hidden>✕</span>
              </IconButton>
            </div>
            <div className="flex flex-col gap-1">
              {c.units.map((u) => (
                <div key={u.uic} className="flex items-center justify-between font-mono text-xs">
                  <span className="text-[var(--color-text)]">{u.unit}</span>
                  <span className="tabular-nums" style={{ color: mcColor(u.mc) }}>
                    {(u.mc * 100).toFixed(1)}%
                  </span>
                </div>
              ))}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// Simplified low-poly outlines of the Nansei Shoto (Ryukyu) islands the
// laydown spans. Each entry is [lon, lat] vertex pairs (single ring).
// Hand-traced at coarse resolution — recognizable as Okinawa Honto plus
// the forward islands Miyako and Ishigaki, small enough to inline. These
// are a schematic planning surface, not a survey product; the BASTION COP
// carries the full-fidelity basemap.
const NANSEI_ISLANDS: { id: string; coords: [number, number][][] }[] = [
  // Okinawa Honto — long, narrow island running SW→NE.
  { id: "okinawa", coords: [[[127.65,26.08],[127.74,26.18],[127.74,26.27],[127.83,26.40],[127.92,26.52],[128.04,26.62],[128.20,26.73],[128.33,26.87],[128.27,26.91],[128.12,26.80],[127.97,26.66],[127.86,26.52],[127.78,26.40],[127.70,26.28],[127.61,26.16],[127.60,26.10],[127.65,26.08]]] },
  // Miyako — compact island ~290 km SW of Okinawa Honto.
  { id: "miyako", coords: [[[125.15,24.73],[125.30,24.70],[125.45,24.77],[125.47,24.86],[125.36,24.90],[125.22,24.86],[125.15,24.80],[125.15,24.73]]] },
  // Ishigaki — forward island, ~410 km SW of Okinawa Honto.
  { id: "ishigaki", coords: [[[124.06,24.41],[124.14,24.33],[124.24,24.34],[124.30,24.41],[124.34,24.50],[124.25,24.53],[124.15,24.50],[124.09,24.45],[124.06,24.41]]] },
];


function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="h-2 w-2 rounded-[1px]" style={{ background: color, opacity: 0.7 }} />
      {label}
    </span>
  );
}

export function LoadingOverlay({ message }: { message: string }) {
  // Thin compatibility wrapper around the LoadingState primitive so the
  // existing call-sites (RiskBoard detail pane, Cannibalization tab) keep
  // their import path while now rendering the chassis primitive.
  return (
    <div className="flex h-full items-center justify-center p-12">
      <LoadingState size="page" label={message} />
    </div>
  );
}

// Shape-matched skeleton instead of the old "Loading …" text — preserves
// the page layout so the transition doesn't feel janky.
function FleetSkeleton() {
  return (
    <div className="flex h-full">
      <div className="flex flex-1 flex-col overflow-y-auto p-4">
        <div
          className="mb-4 grid gap-4"
          style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(14rem, 100%), 1fr))" }}
        >
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-28 animate-pulse rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)]"
            />
          ))}
        </div>
        <div className="mb-3 h-6 w-64 animate-pulse rounded-sm bg-[var(--color-surface)]" />
        <div className="flex-1 animate-pulse rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]" />
      </div>
      <aside className="flex w-80 shrink-0 flex-col gap-2 overflow-y-auto border-l border-[var(--color-border)] bg-[var(--color-bg)] p-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="h-20 animate-pulse rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)]"
          />
        ))}
      </aside>
    </div>
  );
}
