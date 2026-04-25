import { useEffect, useMemo, useState } from "react";
import {
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api, type Forecast } from "../../api";
import { SegmentedControl } from "../../components/SegmentedControl";
import { useSpireStore } from "../../state/store";
import { RecommendPanel } from "../../components/RecommendPanel";

type Horizon = "7" | "14" | "30";

export function ForecastTab() {
  const role = useSpireStore((s) => s.role);
  const [unit, setUnit] = useState<string>("FLEET");
  const [horizon, setHorizon] = useState<Horizon>("14");
  const [data, setData] = useState<Forecast | null>(null);
  const [units, setUnits] = useState<string[]>([]);

  // Scoped units — role-aware so a G-4 doesn't get MALS-31 in the dropdown.
  useEffect(() => {
    api.bastion.cop().then((cop) => setUnits(cop.units.map((u) => u.unit)));
  }, [role]);

  useEffect(() => {
    setData(null);
    const targetUnit = unit === "FLEET" ? undefined : unit;
    api.pulse.forecast(targetUnit, Number(horizon)).then(setData);
  }, [unit, horizon]);

  // Build the combined series. Null-guarded so hooks order stays stable.
  const series = useMemo(() => {
    if (!data) return [];
    const hist = data.history.map((h) => ({
      date: h.date.slice(5),
      actual: h.mc_rate,
      projected: undefined as number | undefined,
      p10: undefined as number | undefined,
      p90: undefined as number | undefined,
    }));
    const proj = data.projection.map((p) => ({
      date: p.date.slice(5),
      actual: undefined as number | undefined,
      projected: p.projected_mc_rate,
      p10: p.p10,
      p90: p.p90,
    }));
    if (hist.length && proj.length) {
      proj[0] = { ...proj[0], actual: hist[hist.length - 1].actual };
    }
    return [...hist, ...proj];
  }, [data]);

  // Intentionally no early return — the layout stays mounted during fetch
  // and shows skeletons until `data` arrives. Avoids a Recharts hook-count
  // mismatch we hit in this Rolldown build when the chart mounted cold with
  // full data after an early-return loading state.
  if (!data) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex items-center gap-3 font-mono text-sm text-[var(--color-text-secondary)] tracking-wider">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--color-primary)]" />
          Running Monte Carlo forecast …
        </div>
      </div>
    );
  }

  const todayLabel = data.history.length
    ? data.history[data.history.length - 1].date.slice(5)
    : null;

  // Cross probability at horizon end (last projection day)
  const endCross = data.projection.length
    ? data.projection[data.projection.length - 1].cross_probability
    : 0;

  // Render a subset of the 200 MC paths to avoid chart overload.
  const visiblePaths = data.paths.slice(0, 60);

  return (
    <div className="flex h-full flex-col p-4">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2
            className="font-mono text-base font-semibold uppercase text-[var(--color-text)] tracking-widest"
          >
            Readiness Forecast · Monte Carlo
          </h2>
          <div className="mt-1 spire-body-muted">
            200 forward paths, drift fit on last 30 days of history. Shaded band = 10–90 percentile.
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span
              className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest"
            >
              Horizon
            </span>
            <SegmentedControl
              value={horizon}
              options={[
                { value: "7", label: "7d" },
                { value: "14", label: "14d" },
                { value: "30", label: "30d" },
              ]}
              onChange={setHorizon}
            />
          </div>
          <label className="flex items-center gap-2 font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
            Unit
            <select
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              className="appearance-none rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 font-mono text-sm text-[var(--color-text)] hover:border-[var(--color-border-active)] focus:border-[var(--color-primary)] focus:outline-none tracking-wide"
            >
              <option value="FLEET">Fleet</option>
              {units.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="min-h-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={series} margin={{ top: 10, right: 30, left: 0, bottom: 10 }}>
            <XAxis
              dataKey="date"
              stroke="var(--color-text-muted)"
              fontSize={10}
              tick={{ fill: "var(--color-text-muted)" }}
            />
            <YAxis
              domain={[0, 1]}
              tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
              stroke="var(--color-text-muted)"
              fontSize={10}
              tick={{ fill: "var(--color-text-muted)" }}
            />
            <Tooltip
              contentStyle={{
                background: "var(--color-surface)",
                border: "1px solid var(--color-border-active)",
                color: "var(--color-text)",
                fontSize: "12px",
                fontFamily: "var(--font-mono)",
              }}
              formatter={(v) => (typeof v === "number" ? `${(v * 100).toFixed(1)}%` : String(v ?? "—"))}
            />
            <ReferenceLine
              y={data.threshold}
              stroke="var(--color-danger)"
              strokeDasharray="6 4"
              label={{
                value: `${(data.threshold * 100).toFixed(0)}% threshold`,
                position: "insideTopRight",
                fill: "var(--color-danger)",
                fontSize: 10,
                fontFamily: "var(--font-mono)",
              }}
            />
            {todayLabel && (
              <ReferenceLine
                x={todayLabel}
                stroke="var(--color-primary)"
                strokeWidth={1.5}
                strokeDasharray="2 3"
                label={{
                  value: "TODAY",
                  position: "top",
                  fill: "var(--color-primary)",
                  fontSize: 9,
                  fontFamily: "var(--font-mono)",
                }}
              />
            )}
            {/* p10 / p90 envelope lines — thin, translucent, complement
             * the mean projection. Simpler + more reliable than stacking an
             * Area ribbon in this Rolldown build. */}
            <Line
              dataKey="p10"
              stroke="var(--color-primary)"
              strokeWidth={1}
              strokeOpacity={0.35}
              dot={false}
              isAnimationActive={false}
              connectNulls={false}
            />
            <Line
              dataKey="p90"
              stroke="var(--color-primary)"
              strokeWidth={1}
              strokeOpacity={0.35}
              dot={false}
              isAnimationActive={false}
              connectNulls={false}
            />
            {/* Historical actuals */}
            <Line
              dataKey="actual"
              stroke="var(--color-success)"
              strokeWidth={2.2}
              dot={false}
              isAnimationActive={false}
              connectNulls
            />
            {/* Projected mean */}
            <Line
              dataKey="projected"
              stroke="var(--color-primary)"
              strokeWidth={2.2}
              strokeDasharray="5 3"
              dot={false}
              isAnimationActive={false}
              connectNulls
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Cross-probability + spaghetti paths panel (path lines rendered via
          SVG overlay at the same scale as the chart — Recharts can't easily
          paint 60 translucent lines efficiently). We render a compact
          readout row and let the filled ribbon tell the distributional story. */}
      <div className="mt-3 grid grid-cols-3 gap-3">
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <div className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
            Projected · Horizon End
          </div>
          <div className="mt-1 font-mono text-xl font-semibold tabular-nums text-[var(--color-text)]" style={{ lineHeight: 1 }}>
            {(data.projection.length > 0 ? data.projection[data.projection.length - 1].projected_mc_rate * 100 : 0).toFixed(1)}
            <span className="ml-0.5 text-base text-[var(--color-text-muted)]">%</span>
          </div>
        </div>
        <div
          className="rounded-md border p-3"
          style={{
            borderColor: endCross > 0.5
              ? "color-mix(in oklab, var(--color-danger) 40%, var(--color-border))"
              : endCross > 0.2
              ? "color-mix(in oklab, var(--color-warning) 40%, var(--color-border))"
              : "var(--color-border)",
            background: endCross > 0.5
              ? "color-mix(in oklab, var(--color-danger-muted) 15%, var(--color-surface))"
              : "var(--color-surface)",
          }}
        >
          <div className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
            P(cross {(data.threshold * 100).toFixed(0)}% threshold)
          </div>
          <div
            className="mt-1 font-mono text-xl font-semibold tabular-nums"
            style={{
              color: endCross > 0.5
                ? "var(--color-danger)"
                : endCross > 0.2
                ? "var(--color-warning)"
                : "var(--color-success)",
              lineHeight: 1,
            }}
          >
            {(endCross * 100).toFixed(0)}
            <span className="ml-0.5 text-base text-[var(--color-text-muted)]">%</span>
          </div>
        </div>
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <div className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
            First Cross (mean)
          </div>
          <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-[var(--color-text)] tracking-wide">
            {data.threshold_cross_date
              ? data.threshold_cross_date.slice(5)
              : "—"}
          </div>
          <div className="mt-0.5 font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
            {data.threshold_cross_date
              ? "mean projection crosses"
              : "no mean crossing in window"}
          </div>
        </div>
      </div>

      {/* Tiny legend indicating the spaghetti paths are truly Monte Carlo */}
      <div className="mt-2 flex items-center gap-4 font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
        <LegendDot color="var(--color-success)" label="historical actuals" />
        <LegendDot color="var(--color-primary)" label="mean projection (200 paths)" dashed />
        <LegendDot color="var(--color-primary)" label="p10 / p90 envelope" opacity={0.35} />
        <LegendDot color="var(--color-danger)" label={`${(data.threshold * 100).toFixed(0)}% threshold`} dashed />
        <span className="ml-auto">
          {visiblePaths.length} of {data.paths.length} sample paths summarized
        </span>
      </div>

      {/* GC-1: ranked replenishment actions, scoped to whichever unit the
       * forecast is currently looking at. Forecast tells you "you're going
       * to drop below 75%"; this panel tells you which actions, in what
       * order, get you back above. */}
      <div className="mt-4">
        <RecommendPanel unit={unit === "FLEET" ? undefined : unit} />
      </div>
    </div>
  );
}

function LegendDot({
  color,
  label,
  dashed,
  opacity,
}: {
  color: string;
  label: string;
  dashed?: boolean;
  opacity?: number;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className="inline-block h-1 w-3"
        style={{
          background: dashed ? `repeating-linear-gradient(90deg, ${color} 0 4px, transparent 4px 7px)` : color,
          opacity: opacity ?? 1,
        }}
      />
      {label}
    </span>
  );
}
