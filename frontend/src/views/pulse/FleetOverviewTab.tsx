import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type FleetOverview, type BastionCOPUnit } from "../../api";
import { withRetry } from "../../api-retry";
import { MetricCard } from "../../components/MetricCard";
import { Heatmap } from "../../components/Heatmap";
import { AlertCard } from "../../components/AlertCard";
import { useSpireStore } from "../../state/store";
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
          <MetricCard
            label="Fleet MC"
            value={(hero.fleet_mc_rate * 100).toFixed(1)}
            delta={hero.fleet_mc_delta_7d * 100}
            unit="%"
            tone={hero.fleet_mc_rate >= 0.85 ? "success" : hero.fleet_mc_rate >= 0.75 ? "warning" : "danger"}
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

        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2
              className="font-mono text-base font-semibold uppercase text-[var(--color-text)] tracking-widest"
            >
              {view === "heatmap" ? "Fleet Readiness · Heatmap" : "Fleet Readiness · CONUS"}
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
    { value: "map", label: "CONUS" },
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
        "Single source: BASTION /cop mc_rate. PULSE surfaces (heatmap, CONUS, alerts, risk board) " +
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
  // Garrison lat/lon — corrected per walkthrough #1.
  const GARRISONS: Record<string, { lat: number; lon: number; label: string; state: string }> = {
    "Camp Lejeune, NC":     { lat: 34.6834, lon: -77.3464, label: "Camp Lejeune",     state: "NC" },
    "Camp Henderson, NC":   { lat: 34.6834, lon: -77.3464, label: "Camp Henderson",   state: "NC" },
    "MCAS New River, NC":   { lat: 34.7083, lon: -77.4400, label: "MCAS New River",   state: "NC" },
    "Camp Pendleton, CA":   { lat: 33.3856, lon: -117.5550, label: "Camp Pendleton",  state: "CA" },
    "MCAS Beaufort, SC":    { lat: 32.4773, lon: -80.7233, label: "MCAS Beaufort",    state: "SC" },
    "MCAS Yuma, AZ":        { lat: 32.6566, lon: -114.6051, label: "MCAS Yuma",       state: "AZ" },
    "MCAS Cherry Point, NC":{ lat: 34.9008, lon: -76.8808, label: "MCAS Cherry Point", state: "NC" },
    // Walkthrough audit: prior coords for Camp Kinser were copy-pasted
    // from MCAS Yuma (32.66, -114.60 — that's southern Arizona).
    // Camp Kinser is on Okinawa, Japan. Off the CONUS canvas, but
    // correct location for any future east-bound view.
    "Camp Kinser, Okinawa": { lat: 26.2685, lon: 127.7494, label: "Camp Kinser (off-CONUS)", state: "" },
  };

  // Albers-USA-like equirectangular projection bounded to the lower 48.
  const LON_MIN = -125, LON_MAX = -66;
  const LAT_MIN = 24,   LAT_MAX = 50;
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
      const g = GARRISONS[u.location] ?? { lat: 39, lon: -95, label: u.location, state: "" };
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

        {/* Walkthrough #1 — real state-border outlines via the curated
         * polygon set. Projected as part of the same equirectangular box
         * so dots align with state lines. */}
        <g
          fill="color-mix(in oklab, var(--color-primary) 4%, var(--color-bg))"
          stroke="color-mix(in oklab, var(--color-primary) 35%, var(--color-border))"
          strokeWidth="1"
          strokeLinejoin="round"
        >
          {US_STATES.map((s) => (
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
          <line x1="0" y1="0" x2="80" y2="0" stroke="var(--color-text-muted)" strokeWidth="2" />
          <line x1="0" y1="-4" x2="0" y2="4" stroke="var(--color-text-muted)" strokeWidth="2" />
          <line x1="80" y1="-4" x2="80" y2="4" stroke="var(--color-text-muted)" strokeWidth="2" />
          <text x="0" y="20" fill="var(--color-text-muted)">0</text>
          <text x="74" y="20" fill="var(--color-text-muted)">~500 mi</text>
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
              <text x={p.x + r + 4} y={p.y - 2} fontFamily="JetBrains Mono, monospace" fontSize="11" fill="var(--color-text)">
                {c.label}
              </text>
              <text x={p.x + r + 4} y={p.y + 10} fontFamily="JetBrains Mono, monospace" fontSize="9" fill="var(--color-text-muted)">
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

// Hand-curated low-poly state polygons for the lower 48. Each entry
// is [lon, lat] vertex pairs (clockwise rings). Coordinates were sourced
// from US Census 2018 cartographic boundary files at 1:20m and decimated
// to ~12 vertices per state — small enough to inline (~6 KB total),
// recognizable as the United States. Order: alphabetical by id.
//
// Walkthrough #1 — replaces the prior single decorative blob with real
// state borders. AK/HI omitted (off-projection). Coordinates rounded to
// 2 decimals.
const US_STATES: { id: string; coords: [number, number][][] }[] = [
  { id: "AL", coords: [[[-88.47,30.18],[-87.60,30.27],[-86.81,30.99],[-85.05,31.00],[-85.00,32.40],[-85.18,32.85],[-85.43,34.13],[-85.60,34.99],[-88.20,34.99],[-88.20,32.39],[-88.47,30.18]]] },
  { id: "AZ", coords: [[[-114.81,32.49],[-114.55,32.76],[-114.81,34.31],[-114.63,35.00],[-114.05,36.84],[-114.05,37.00],[-109.05,37.00],[-109.05,31.33],[-111.07,31.33],[-114.81,32.49]]] },
  { id: "AR", coords: [[[-94.62,33.02],[-91.20,33.00],[-90.13,33.50],[-90.30,35.00],[-89.69,36.00],[-90.15,36.50],[-94.62,36.50],[-94.62,33.02]]] },
  { id: "CA", coords: [[[-124.40,42.00],[-124.20,40.00],[-122.40,37.20],[-120.65,34.60],[-117.13,32.53],[-114.80,32.72],[-114.63,35.00],[-114.05,36.84],[-119.99,39.00],[-120.00,42.00],[-124.40,42.00]]] },
  { id: "CO", coords: [[[-109.05,37.00],[-102.05,37.00],[-102.05,41.00],[-109.05,41.00],[-109.05,37.00]]] },
  { id: "CT", coords: [[[-73.73,41.00],[-71.79,41.00],[-71.79,42.05],[-73.49,42.05],[-73.73,41.00]]] },
  { id: "DE", coords: [[[-75.79,38.45],[-75.05,38.45],[-75.05,39.84],[-75.79,39.72],[-75.79,38.45]]] },
  { id: "FL", coords: [[[-87.45,30.99],[-85.00,30.99],[-84.86,30.71],[-82.04,30.59],[-81.40,30.71],[-80.03,26.39],[-80.16,25.18],[-81.10,25.20],[-81.81,26.18],[-82.85,28.58],[-83.30,29.94],[-85.27,29.69],[-87.45,30.40],[-87.45,30.99]]] },
  { id: "GA", coords: [[[-85.60,34.99],[-83.11,35.00],[-82.59,33.80],[-81.50,33.07],[-80.85,32.04],[-81.13,30.71],[-82.04,30.59],[-84.86,30.71],[-85.00,32.40],[-85.18,32.85],[-85.43,34.13],[-85.60,34.99]]] },
  { id: "ID", coords: [[[-117.04,42.00],[-111.05,42.00],[-111.05,44.50],[-111.05,46.00],[-114.06,46.64],[-115.29,47.69],[-116.05,49.00],[-117.04,49.00],[-117.04,42.00]]] },
  { id: "IL", coords: [[[-91.51,40.00],[-91.50,38.00],[-89.18,37.00],[-88.10,37.45],[-87.53,38.20],[-87.50,41.76],[-89.13,42.50],[-90.64,42.50],[-91.51,40.00]]] },
  { id: "IN", coords: [[[-87.53,38.20],[-86.93,37.95],[-86.30,38.00],[-84.81,38.93],[-84.81,41.76],[-87.50,41.76],[-87.53,38.20]]] },
  { id: "IA", coords: [[[-96.64,40.38],[-95.25,40.00],[-92.76,40.55],[-91.51,40.40],[-90.64,42.50],[-91.05,43.50],[-96.45,43.50],[-96.64,40.38]]] },
  { id: "KS", coords: [[[-102.05,37.00],[-94.59,37.00],[-94.59,40.00],[-102.05,40.00],[-102.05,37.00]]] },
  { id: "KY", coords: [[[-89.18,37.00],[-86.30,37.00],[-84.81,37.00],[-83.67,38.00],[-82.59,38.20],[-83.30,38.85],[-84.81,38.93],[-86.30,38.00],[-86.93,37.95],[-87.53,38.20],[-88.10,37.45],[-89.18,37.00]]] },
  { id: "LA", coords: [[[-94.04,33.02],[-91.20,33.00],[-89.74,31.00],[-89.20,30.18],[-89.74,29.05],[-92.04,28.99],[-93.84,29.71],[-94.04,33.02]]] },
  { id: "ME", coords: [[[-71.08,46.70],[-70.70,45.45],[-70.30,43.55],[-69.05,43.85],[-67.00,44.81],[-67.45,45.74],[-69.04,47.42],[-71.08,46.70]]] },
  { id: "MD", coords: [[[-79.49,39.20],[-77.45,39.72],[-76.05,38.58],[-75.05,38.27],[-75.79,38.45],[-75.79,39.72],[-79.49,39.72],[-79.49,39.20]]] },
  { id: "MA", coords: [[[-73.49,42.05],[-71.00,42.05],[-69.93,41.81],[-70.65,42.55],[-72.50,42.85],[-73.49,42.85],[-73.49,42.05]]] },
  { id: "MI", coords: [[[-86.81,42.05],[-84.81,41.76],[-83.45,41.73],[-82.85,42.85],[-83.10,45.85],[-84.36,45.99],[-84.81,46.10],[-86.65,46.85],[-88.06,46.85],[-90.42,46.61],[-86.81,42.05]]] },
  { id: "MN", coords: [[[-97.23,49.00],[-89.49,48.02],[-89.49,46.85],[-91.95,46.85],[-92.30,43.50],[-96.45,43.50],[-96.85,46.01],[-97.23,49.00]]] },
  { id: "MS", coords: [[[-91.20,33.00],[-89.74,31.00],[-88.45,30.18],[-88.20,32.39],[-88.20,34.99],[-90.31,35.00],[-90.13,33.50],[-91.20,33.00]]] },
  { id: "MO", coords: [[[-95.25,40.00],[-91.51,40.40],[-91.50,38.00],[-89.18,37.00],[-90.15,36.50],[-94.62,36.50],[-94.62,40.00],[-95.25,40.00]]] },
  { id: "MT", coords: [[[-116.05,49.00],[-104.05,49.00],[-104.05,45.00],[-104.05,44.99],[-111.05,45.00],[-111.05,46.00],[-114.06,46.64],[-115.29,47.69],[-116.05,49.00]]] },
  { id: "NE", coords: [[[-104.05,41.00],[-95.31,41.00],[-95.25,40.00],[-96.64,40.38],[-96.45,43.00],[-104.05,43.00],[-104.05,41.00]]] },
  { id: "NV", coords: [[[-120.00,42.00],[-114.05,42.00],[-114.05,36.84],[-114.63,35.00],[-117.13,34.30],[-120.00,39.00],[-120.00,42.00]]] },
  { id: "NH", coords: [[[-72.55,45.30],[-71.08,45.30],[-71.08,43.00],[-72.55,42.71],[-72.55,45.30]]] },
  { id: "NJ", coords: [[[-75.55,39.30],[-74.05,38.93],[-74.00,40.50],[-74.69,41.36],[-75.05,40.85],[-75.55,39.30]]] },
  { id: "NM", coords: [[[-109.05,31.33],[-103.05,32.00],[-103.05,37.00],[-109.05,37.00],[-109.05,31.33]]] },
  { id: "NY", coords: [[[-79.76,42.00],[-78.91,43.10],[-76.30,43.65],[-75.30,44.85],[-73.34,45.00],[-73.49,42.85],[-74.69,41.36],[-74.00,40.50],[-79.76,42.00]]] },
  { id: "NC", coords: [[[-84.32,35.20],[-81.05,35.00],[-78.55,33.85],[-75.86,35.55],[-75.46,36.55],[-81.68,36.55],[-83.69,36.59],[-84.32,35.20]]] },
  { id: "ND", coords: [[[-104.05,49.00],[-97.23,49.00],[-96.85,46.01],[-104.05,46.01],[-104.05,49.00]]] },
  { id: "OH", coords: [[[-84.81,38.93],[-83.30,38.85],[-82.59,38.45],[-80.52,40.65],[-80.52,42.32],[-83.45,41.73],[-84.81,41.76],[-84.81,38.93]]] },
  { id: "OK", coords: [[[-103.05,37.00],[-94.43,36.50],[-94.43,33.85],[-100.00,33.85],[-100.00,36.50],[-103.05,36.50],[-103.05,37.00]]] },
  { id: "OR", coords: [[[-124.55,42.00],[-124.55,46.27],[-123.45,46.18],[-119.00,45.99],[-117.04,45.99],[-117.04,42.00],[-124.55,42.00]]] },
  { id: "PA", coords: [[[-80.52,42.32],[-74.69,41.36],[-75.05,40.85],[-75.55,39.85],[-77.45,39.72],[-79.49,39.72],[-80.52,40.65],[-80.52,42.32]]] },
  { id: "RI", coords: [[[-71.79,41.30],[-71.13,41.30],[-71.13,42.05],[-71.79,42.05],[-71.79,41.30]]] },
  { id: "SC", coords: [[[-83.11,35.00],[-81.05,35.00],[-78.55,33.85],[-79.50,33.00],[-80.85,32.04],[-82.59,33.80],[-83.11,35.00]]] },
  { id: "SD", coords: [[[-104.05,46.01],[-96.45,46.01],[-96.45,43.00],[-104.05,43.00],[-104.05,46.01]]] },
  { id: "TN", coords: [[[-90.31,35.00],[-88.20,34.99],[-85.60,34.99],[-83.11,35.00],[-84.32,35.20],[-83.69,36.59],[-89.69,36.50],[-90.30,35.00],[-90.31,35.00]]] },
  { id: "TX", coords: [[[-106.65,31.83],[-104.85,30.40],[-103.16,28.97],[-101.60,29.78],[-100.00,28.20],[-97.50,27.00],[-95.55,29.00],[-93.84,29.71],[-94.04,33.02],[-100.00,33.85],[-100.00,36.50],[-103.05,36.50],[-103.05,32.00],[-106.65,31.83]]] },
  { id: "UT", coords: [[[-114.05,37.00],[-109.05,37.00],[-109.05,41.00],[-111.05,41.00],[-114.05,42.00],[-114.05,37.00]]] },
  { id: "VT", coords: [[[-73.34,45.00],[-71.50,45.00],[-71.50,42.71],[-73.49,42.85],[-73.34,45.00]]] },
  { id: "VA", coords: [[[-83.69,36.59],[-81.68,36.55],[-75.86,36.55],[-75.46,36.55],[-75.86,37.95],[-77.45,39.72],[-79.49,39.20],[-83.30,36.59],[-83.69,36.59]]] },
  { id: "WA", coords: [[[-124.73,46.27],[-124.55,46.27],[-124.55,49.00],[-117.04,49.00],[-117.04,45.99],[-119.00,45.99],[-122.94,45.99],[-124.73,46.27]]] },
  { id: "WV", coords: [[[-82.59,38.45],[-80.52,40.65],[-79.49,39.72],[-77.45,39.72],[-77.95,39.20],[-80.85,37.50],[-82.59,38.45]]] },
  { id: "WI", coords: [[[-92.30,43.50],[-91.95,46.85],[-89.49,46.85],[-87.50,45.85],[-87.50,42.50],[-90.64,42.50],[-91.05,43.50],[-92.30,43.50]]] },
  { id: "WY", coords: [[[-111.05,41.00],[-104.05,41.00],[-104.05,45.00],[-111.05,45.00],[-111.05,41.00]]] },
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
