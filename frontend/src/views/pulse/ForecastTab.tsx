import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  ComposedChart,
  Line,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

// Measured width via ResizeObserver. We use this instead of Recharts'
// ResponsiveContainer because the latter regularly reports 0 width on the
// Rolldown build's first paint, leaving the chart pane blank (Jesse hit this
// twice). A direct measure with explicit numeric width/height on the chart
// makes the bug impossible.
function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    setW(ref.current.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width ?? 0;
      if (cw > 0) setW(Math.round(cw));
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}
import { api, type Forecast } from "../../api";
import { SegmentedControl } from "../../components/SegmentedControl";
import { useSpireStore } from "../../state/store";
import { RecommendPanel } from "../../components/RecommendPanel";
import { CollapsiblePanel } from "../../components/CollapsiblePanel";

type Horizon = "7" | "14" | "30";

export function ForecastTab() {
  const role = useSpireStore((s) => s.role);
  const [params] = useSearchParams();
  // Honor an inbound ?unit=… deep link (e.g. from PredictedFailurePanel's
  // Draft Action button). Defaults to FLEET if no param.
  const initialUnit = params.get("unit") ?? "FLEET";
  const [unit, setUnit] = useState<string>(initialUnit);
  const [horizon, setHorizon] = useState<Horizon>("14");
  const [data, setData] = useState<Forecast | null>(null);
  const [units, setUnits] = useState<string[]>([]);
  const [chartRef, chartWidth] = useElementWidth<HTMLDivElement>();
  const CHART_HEIGHT = 360;

  // Re-sync local state if the URL param changes (back / forward nav).
  useEffect(() => {
    const u = params.get("unit");
    if (u && u !== unit) setUnit(u);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

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
  const visiblePaths = (data.paths || []).slice(0, 60);

  // Defense against malformed forecast payloads. If threshold or projection
  // is missing/NaN we bail to a friendly state instead of letting Recharts
  // crash the whole view (reviewer caught the chart canvas rendering empty
  // and the view occasionally crashing — both pointed at unguarded data).
  const thresholdSafe = typeof data.threshold === "number" && !Number.isNaN(data.threshold)
    ? data.threshold : 0.85;
  const chartUsable = series.length > 0 && data.history.length > 0 && data.projection.length > 0;

  return (
    // overflow-y-auto on the outer container so the chart + 3 KPIs + Recommend
    // Actions all stay reachable. Reviewer caught: <main> has overflow:hidden
    // and the page below the chart was unreachable. Fixed-min-height on the
    // chart container (instead of flex-1 eating everything) means the
    // Recommend Actions panel renders below the chart and the page scrolls
    // when content exceeds viewport.
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
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

      {/* Chart pane — fixed height; width measured by ResizeObserver. The
       * ComposedChart receives explicit numeric width/height so paint is
       * never gated on Recharts' ResponsiveContainer correctly resolving its
       * parent box (which it does not, reliably, on Rolldown's first frame).
       * Internal margin gives the chart breathing room — no inner padding on
       * the wrapper, which used to be the source of double-padding offsets. */}
      <div
        ref={chartRef}
        className="relative shrink-0 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]"
        style={{ height: CHART_HEIGHT, minHeight: CHART_HEIGHT }}
      >
        {!chartUsable ? (
          <div className="flex h-full items-center justify-center font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
            Forecast data incomplete · check backend
          </div>
        ) : chartWidth > 0 ? (
          <ComposedChart
            data={series}
            width={chartWidth}
            height={CHART_HEIGHT}
            margin={{ top: 16, right: 36, left: 12, bottom: 16 }}
          >
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
              y={thresholdSafe}
              stroke="var(--color-danger)"
              strokeDasharray="6 4"
              label={{
                value: `${(thresholdSafe * 100).toFixed(0)}% threshold`,
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
        ) : (
          <div className="flex h-full items-center justify-center font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
            Sizing chart …
          </div>
        )}
      </div>

      {/* Cross-probability + spaghetti paths panel — gap from parent flex
       * gap-4 spaces this from the chart above so we don't double-margin. */}
      <div className="grid grid-cols-3 gap-3">
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
       * order, get you back above.
       *
       * Track-G2 — Maintenance Chief lands on PULSE Risk Board first; when
       * they land here on Forecast, they want the chart, not the action list
       * (which is also surfaced via PULSE/Cannibalization). Default-collapse
       * for Maintenance Chief so the chart breathes. Other roles see it
       * expanded as before. */}
      <div className="mt-4">
        <CollapsiblePanel
          view="pulse.forecast"
          panel="recommend"
          defaultCollapsedFor={{ maintenance_chief: true }}
          header={
            <span
              className="font-mono uppercase text-[var(--color-primary)]"
              style={{ fontSize: "var(--text-xs)", letterSpacing: "var(--tracking-widest)" }}
            >
              Recommended Actions · Auto Replenishment
            </span>
          }
          collapsedSummary={
            <span>
              Top at-risk asset actions ranked by impact-per-dollar-per-day. Click ▾ to expand.
            </span>
          }
        >
          <div className="border-t border-[var(--color-border)]">
            <RecommendPanel unit={unit === "FLEET" ? undefined : unit} hideHeader />
          </div>
        </CollapsiblePanel>
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
