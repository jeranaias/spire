import { useEffect, useState } from "react";
import { api, type FleetOverview } from "../../api";
import { MetricCard } from "../../components/MetricCard";
import { Heatmap } from "../../components/Heatmap";
import { AlertCard } from "../../components/AlertCard";
import { useSpireStore } from "../../state/store";

export function FleetOverviewTab() {
  const role = useSpireStore((s) => s.role);
  const [data, setData] = useState<FleetOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    api.pulse
      .fleetOverview()
      .then(setData)
      .catch((e) => setError(String(e)));
  }, [role]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-12">
        <div className="rounded border border-[var(--color-danger-muted)] bg-[var(--color-surface)] p-6 text-sm text-[var(--color-danger)]">
          Failed to load fleet overview: {error}
        </div>
      </div>
    );
  }
  if (!data) return <LoadingOverlay message="Loading fleet data ..." />;

  const hero = data.hero_metrics;
  return (
    <div className="flex h-full">
      {/* Main */}
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

        <div className="mb-3 flex items-end justify-between">
          <div>
            <h2 className="text-sm font-semibold text-[var(--color-text)]">Fleet readiness heatmap</h2>
            <div className="text-xs text-[var(--color-text-muted)]">
              MC rate by unit × equipment type — as of {data.as_of}
            </div>
          </div>
          <div className="flex items-center gap-3 text-[10px] text-[var(--color-text-muted)]">
            <LegendDot color="var(--color-success)" label="≥90%" />
            <LegendDot color="var(--color-warning)" label="75-89%" />
            <LegendDot color="#fb923c" label="60-74%" />
            <LegendDot color="var(--color-danger)" label="<60%" />
          </div>
        </div>

        <Heatmap units={data.heatmap} equipmentTypes={data.equipment_types} />
      </div>

      {/* Alerts sidebar */}
      <aside className="flex w-80 shrink-0 flex-col overflow-y-auto border-l border-[var(--color-border)] bg-[var(--color-bg)] p-3">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            Alert feed
          </h3>
          <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[10px] tabular-nums text-[var(--color-text-muted)]">
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
            />
          ))}
          {data.alerts.length === 0 && (
            <div className="rounded border border-dashed border-[var(--color-border)] p-6 text-center text-xs text-[var(--color-text-muted)]">
              No active alerts.
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="h-2.5 w-2.5 rounded-sm" style={{ background: color, opacity: 0.5 }} />
      {label}
    </span>
  );
}

export function LoadingOverlay({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center p-12">
      <div className="flex items-center gap-3 text-sm text-[var(--color-text-secondary)]">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--color-primary)]" />
        {message}
      </div>
    </div>
  );
}
