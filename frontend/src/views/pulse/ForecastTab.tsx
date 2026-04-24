import { useEffect, useState } from "react";
import {
  Area,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api, type Forecast } from "../../api";
import { LoadingOverlay } from "./FleetOverviewTab";

export function ForecastTab() {
  const [unit, setUnit] = useState<string>("FLEET");
  const [data, setData] = useState<Forecast | null>(null);
  const [units, setUnits] = useState<string[]>([]);

  useEffect(() => {
    api.bastion.cop().then((cop) => setUnits(cop.units.map((u) => u.unit)));
  }, []);

  useEffect(() => {
    setData(null);
    const targetUnit = unit === "FLEET" ? undefined : unit;
    api.pulse.forecast(targetUnit, 14).then(setData);
  }, [unit]);

  if (!data) return <LoadingOverlay message="Computing forecast ..." />;

  // Merge history + projection for a single chart series
  const series = [
    ...data.history.map((h) => ({
      date: h.date.slice(5),
      actual: h.mc_rate,
      projected: undefined as number | undefined,
      lo: undefined as number | undefined,
      hi: undefined as number | undefined,
    })),
    ...data.projection.map((p) => ({
      date: p.date.slice(5),
      actual: undefined as number | undefined,
      projected: p.projected_mc_rate,
      lo: p.confidence_lower,
      hi: p.confidence_upper,
    })),
  ];

  return (
    <div className="flex h-full flex-col p-4">
      <div className="mb-4 flex items-end justify-between">
        <div>
          <h2 className="text-sm font-semibold">Readiness forecast — 14-day projection</h2>
          <div className="text-xs text-[var(--color-text-muted)]">
            Linear-regression trend over the last 30 days, 75% threshold line marked.
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
          <span>Unit</span>
          <select
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            className="appearance-none rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[var(--color-text)] hover:border-[var(--color-border-active)] focus:border-[var(--color-primary)] focus:outline-none"
          >
            <option value="FLEET">Fleet (all units)</option>
            {units.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="min-h-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={series}>
            <XAxis dataKey="date" stroke="var(--color-text-muted)" fontSize={10} />
            <YAxis
              domain={[0, 1]}
              tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
              stroke="var(--color-text-muted)"
              fontSize={10}
            />
            <Tooltip
              contentStyle={{
                background: "var(--color-surface)",
                border: "1px solid var(--color-border-active)",
                color: "var(--color-text)",
                fontSize: "12px",
              }}
              formatter={(v) => (typeof v === "number" ? `${(v * 100).toFixed(1)}%` : String(v ?? "—"))}
            />
            <ReferenceLine
              y={data.threshold}
              stroke="var(--color-danger)"
              strokeDasharray="4 4"
              label={{
                value: `Threshold ${(data.threshold * 100).toFixed(0)}%`,
                position: "insideTopRight",
                fill: "var(--color-danger)",
                fontSize: 10,
              }}
            />
            <Area
              dataKey="hi"
              stroke="none"
              fill="var(--color-primary)"
              fillOpacity={0.08}
              isAnimationActive={false}
            />
            <Area
              dataKey="lo"
              stroke="none"
              fill="var(--color-bg)"
              fillOpacity={1}
              isAnimationActive={false}
            />
            <Line
              dataKey="actual"
              stroke="var(--color-success)"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            <Line
              dataKey="projected"
              stroke="var(--color-primary)"
              strokeWidth={2}
              strokeDasharray="4 4"
              dot={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {data.threshold_cross_date && (
        <div className="mt-3 rounded border border-[var(--color-danger-muted)] bg-[color-mix(in_oklab,var(--color-danger-muted)_10%,var(--color-surface))] p-3 text-sm text-[var(--color-danger)]">
          Projected to cross the {(data.threshold * 100).toFixed(0)}% threshold on{" "}
          <span className="font-mono">{data.threshold_cross_date}</span>. Recommend pre-emptive cannibalization and
          parts expedite.
        </div>
      )}
    </div>
  );
}
