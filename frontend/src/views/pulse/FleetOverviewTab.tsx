import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type FleetOverview } from "../../api";
import { MetricCard } from "../../components/MetricCard";
import { Heatmap } from "../../components/Heatmap";
import { AlertCard } from "../../components/AlertCard";
import { useSpireStore } from "../../state/store";
import { SegmentedControl } from "../../components/SegmentedControl";

type View = "heatmap" | "map";

export function FleetOverviewTab() {
  const role = useSpireStore((s) => s.role);
  const nav = useNavigate();
  const [data, setData] = useState<FleetOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("heatmap");
  const [hideEmptyColumns, setHideEmptyColumns] = useState(true);

  useEffect(() => {
    setData(null);
    api.pulse
      .fleetOverview()
      .then(setData)
      .catch((e) => setError(String(e)));
  }, [role]);

  // Filter equipment-type columns so sparse matrix becomes dense.
  const displayedEquipment = useMemo(() => {
    if (!data) return [];
    if (!hideEmptyColumns) return data.equipment_types;
    return data.equipment_types.filter((eq) =>
      data.heatmap.some((u) => (u.equipment_breakdown[eq] || 0) > 0),
    );
  }, [data, hideEmptyColumns]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-12">
        <div className="rounded border border-[var(--color-danger-muted)] bg-[var(--color-surface)] p-6 text-sm text-[var(--color-danger)]">
          Failed to load fleet overview: {error}
        </div>
      </div>
    );
  }
  if (!data) return <FleetSkeleton />;

  const hero = data.hero_metrics;

  // Narrative copy — find the unit with the biggest week-over-week MC gain.
  const narrative = buildNarrative(data);

  return (
    <div className="flex h-full">
      <div className="flex flex-1 flex-col overflow-y-auto p-4">
        <div className="mb-4 grid grid-cols-4 gap-3">
          <MetricCard
            label="Fleet MC"
            value={(hero.fleet_mc_rate * 100).toFixed(1)}
            delta={hero.fleet_mc_delta_7d * 100}
            unit="%"
            tone={hero.fleet_mc_rate >= 0.75 ? "success" : hero.fleet_mc_rate >= 0.65 ? "warning" : "danger"}
          />
          <MetricCard
            label="Critical Assets"
            value={hero.critical_assets}
            tone={hero.critical_assets > 30 ? "danger" : hero.critical_assets > 15 ? "warning" : "neutral"}
          />
          <MetricCard
            label="Parts on Order"
            value={hero.parts_on_order}
            tone="neutral"
          />
          <MetricCard
            label="Avg Days NMC"
            value={hero.avg_days_nmc.toFixed(1)}
            tone={hero.avg_days_nmc > 30 ? "danger" : hero.avg_days_nmc > 15 ? "warning" : "success"}
          />
        </div>

        {narrative && (
          <div
            className="mb-3 rounded-sm border border-[var(--color-border)] bg-[color-mix(in_oklab,var(--color-surface)_92%,var(--color-bg))] px-3 py-2 spire-body-muted"
          >
            <span className="font-mono text-[10px] uppercase text-[var(--color-primary)]" style={{ letterSpacing: "0.18em" }}>
              Narrative
            </span>{" "}
            <span className="text-[var(--color-text)]">{narrative}</span>
          </div>
        )}

        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2
              className="font-mono text-[12px] font-semibold uppercase text-[var(--color-text)]"
              style={{ letterSpacing: "0.2em" }}
            >
              {view === "heatmap" ? "Fleet Readiness · Heatmap" : "Fleet Readiness · CONUS"}
            </h2>
            <div className="mt-0.5 spire-body-muted">
              MC rate by {view === "heatmap" ? "unit × equipment type" : "garrison location"} — as of {data.as_of}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <SegmentedControl
              value={view}
              options={[
                { value: "heatmap", label: "Heatmap" },
                { value: "map",     label: "CONUS" },
              ]}
              onChange={setView}
            />
            {view === "heatmap" && (
              <label className="flex cursor-pointer items-center gap-2 font-mono text-[10px] uppercase text-[var(--color-text-muted)]" style={{ letterSpacing: "0.16em" }}>
                <input
                  type="checkbox"
                  checked={hideEmptyColumns}
                  onChange={(e) => setHideEmptyColumns(e.target.checked)}
                  className="accent-[var(--color-primary)]"
                />
                Hide Empty Columns
              </label>
            )}
            <div className="flex items-center gap-3 font-mono text-[10px] text-[var(--color-text-muted)]" style={{ letterSpacing: "0.08em" }}>
              <LegendDot color="var(--color-success)" label="≥90%" />
              <LegendDot color="var(--color-warning)" label="75-89%" />
              <LegendDot color="#fb923c" label="60-74%" />
              <LegendDot color="var(--color-danger)" label="<60%" />
            </div>
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
        {view === "map" && <ConusMap data={data} />}
      </div>

      <aside className="flex w-80 shrink-0 flex-col overflow-y-auto border-l border-[var(--color-border)] bg-[var(--color-bg)] p-3">
        <div className="mb-2 flex items-center justify-between">
          <h3
            className="font-mono text-[10px] font-semibold uppercase text-[var(--color-text)]"
            style={{ letterSpacing: "0.2em" }}
          >
            Alert Feed
          </h3>
          <span
            className="rounded-sm border border-[var(--color-border)] px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-[var(--color-text-muted)]"
            style={{ letterSpacing: "0.08em" }}
          >
            {data.alerts.length}
          </span>
        </div>
        <div className="flex flex-col gap-2">
          {data.alerts.map((a) => (
            <AlertCard
              key={a.id}
              severity={a.severity}
              source={a.kind}
              title={a.title}
              body={a.body}
              timestamp={a.timestamp}
              onClick={() => {
                // Deep-link into the appropriate view. Readiness alerts carry
                // a `unit` field via the title; cannibalization alerts go to
                // the cannib tab.
                if (a.kind === "readiness") {
                  const match = /^([A-Za-z0-9/\- ]+?)\s/.exec(a.title);
                  if (match) nav(`/pulse/risk?unit=${encodeURIComponent(match[1].trim())}`);
                } else if (a.kind === "cannibalization") {
                  nav("/pulse/cannib");
                }
              }}
              actionLabel={a.kind === "readiness" ? "Open risk board" : a.kind === "cannibalization" ? "Open cannibalization" : undefined}
            />
          ))}
          {data.alerts.length === 0 && (
            <div className="rounded border border-dashed border-[var(--color-border)] p-6 text-center font-mono text-[10px] text-[var(--color-text-muted)]" style={{ letterSpacing: "0.1em" }}>
              NO ACTIVE ALERTS
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function buildNarrative(data: FleetOverview): string | null {
  if (!data.heatmap || data.heatmap.length === 0) return null;
  const h = data.hero_metrics;
  const direction = h.fleet_mc_delta_7d >= 0 ? "up" : "down";
  const absDelta = Math.abs(h.fleet_mc_delta_7d * 100).toFixed(1);
  // Pick the unit with highest MC rate across equipment types as the "top" unit
  const unitBest = data.heatmap
    .map((u) => {
      const rates = Object.values(u.rates).filter((v): v is number => v != null);
      const avg = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;
      return { unit: u.unit, avg };
    })
    .sort((a, b) => b.avg - a.avg)[0];
  const unitWorst = data.heatmap
    .map((u) => {
      const rates = Object.values(u.rates).filter((v): v is number => v != null);
      const avg = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : 1;
      return { unit: u.unit, avg };
    })
    .sort((a, b) => a.avg - b.avg)[0];

  if (direction === "up") {
    return `Fleet MC ${(h.fleet_mc_rate * 100).toFixed(1)}% · ${absDelta}% week-over-week — ${unitBest.unit} leading the recovery.`;
  }
  return `Fleet MC ${(h.fleet_mc_rate * 100).toFixed(1)}% · ${absDelta}% week-over-week — ${unitWorst.unit} dragging the average (${(unitWorst.avg * 100).toFixed(0)}% MC).`;
}

// Simple CONUS map — renders unit locations as MC-coloured dots on a
// lightweight schematic of the continental US. No real tile layer; this is a
// focused companion view to the heatmap, not a full geographic exploration.
function ConusMap({ data }: { data: FleetOverview }) {
  // Approximate projection: normalize known USMC installation lat/lon to a
  // 1000×600 viewBox. These are handcoded since the dataset doesn't ship
  // coordinates on unit records.
  const LOCATIONS: Record<string, { lat: number; lon: number; label: string }> = {
    "Camp Lejeune, NC":     { lat: 34.67, lon: -77.33, label: "Camp Lejeune" },
    "Camp Henderson, NC":   { lat: 34.67, lon: -77.33, label: "Camp Henderson" },
    "Camp Pendleton, CA":   { lat: 33.39, lon: -117.58, label: "Camp Pendleton" },
    "MCAS Beaufort, SC":    { lat: 32.48, lon: -80.72, label: "MCAS Beaufort" },
    "MCAS Yuma, AZ":        { lat: 32.66, lon: -114.60, label: "MCAS Yuma" },
    "Camp Kinser, Okinawa": { lat: 32.66, lon: -114.60, label: "Camp Kinser (proxy)" }, // off-CONUS, placed near Yuma for display
  };

  // CONUS bounding box
  const LON_MIN = -125,
    LON_MAX = -66;
  const LAT_MIN = 24,
    LAT_MAX = 50;
  const W = 1000,
    H = 600;

  function project(lat: number, lon: number): { x: number; y: number } {
    const x = ((lon - LON_MIN) / (LON_MAX - LON_MIN)) * W;
    const y = ((LAT_MAX - lat) / (LAT_MAX - LAT_MIN)) * H;
    return { x, y };
  }

  const units = data.heatmap.map((u) => {
    const loc = LOCATIONS[u.location] ?? { lat: 39, lon: -95, label: u.location };
    const rates = Object.values(u.rates).filter((v): v is number => v != null);
    const avg = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : 0.7;
    return { ...u, ...project(loc.lat, loc.lon), avg, label: loc.label };
  });

  function mcColor(r: number): string {
    if (r >= 0.9) return "#22c55e";
    if (r >= 0.75) return "#eab308";
    if (r >= 0.6) return "#fb923c";
    return "#ef4444";
  }

  return (
    <div className="min-h-[480px] flex-1 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full">
        <defs>
          <pattern id="conus-grid" width="100" height="100" patternUnits="userSpaceOnUse">
            <path d="M 100 0 L 0 0 0 100" fill="none" stroke="rgba(59,130,246,0.05)" strokeWidth="1" />
          </pattern>
        </defs>
        <rect x="0" y="0" width={W} height={H} fill="url(#conus-grid)" />
        {/* Rough CONUS outline — decorative, not geographic */}
        <path
          d="M 90 180 Q 180 120 320 110 L 480 100 L 640 140 L 820 170 L 900 220 L 910 320 L 850 420 L 700 480 L 540 500 L 360 520 L 220 500 L 140 450 L 110 360 Z"
          fill="color-mix(in oklab, var(--color-primary) 4%, var(--color-bg))"
          stroke="color-mix(in oklab, var(--color-primary) 35%, var(--color-border))"
          strokeWidth="1.5"
        />
        {units.map((u) => (
          <g key={u.uic}>
            <circle
              cx={u.x}
              cy={u.y}
              r="16"
              fill={mcColor(u.avg)}
              fillOpacity={0.2}
            />
            <circle
              cx={u.x}
              cy={u.y}
              r="8"
              fill={mcColor(u.avg)}
              stroke="#0a0c13"
              strokeWidth="1.5"
            />
            <text
              x={u.x + 12}
              y={u.y - 8}
              fontFamily="JetBrains Mono, monospace"
              fontSize="11"
              fill="var(--color-text)"
              style={{ letterSpacing: "0.04em" }}
            >
              {u.unit}
            </text>
            <text
              x={u.x + 12}
              y={u.y + 5}
              fontFamily="JetBrains Mono, monospace"
              fontSize="9"
              fill="var(--color-text-muted)"
              style={{ letterSpacing: "0.1em" }}
            >
              {(u.avg * 100).toFixed(0)}% MC · {u.label}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="h-2 w-2 rounded-[1px]" style={{ background: color, opacity: 0.7 }} />
      {label}
    </span>
  );
}

export function LoadingOverlay({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center p-12">
      <div className="flex items-center gap-3 font-mono text-[11px] text-[var(--color-text-secondary)]" style={{ letterSpacing: "0.1em" }}>
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--color-primary)]" />
        {message}
      </div>
    </div>
  );
}

// Shape-matched skeleton instead of the old "Loading …" text — preserves
// the page layout so the transition doesn't feel janky.
function FleetSkeleton() {
  return (
    <div className="flex h-full">
      <div className="flex flex-1 flex-col overflow-y-auto p-4">
        <div className="mb-4 grid grid-cols-4 gap-3">
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
