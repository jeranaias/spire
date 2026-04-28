import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  ComposedChart,
  Line,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

// Measured width via callback ref + ResizeObserver. Used instead of Recharts'
// ResponsiveContainer (which reports 0 width on the Rolldown build's first
// paint and leaves the pane blank).
//
// Why a callback ref and not useRef + useEffect: this component has an early
// `if (!data) return <skeleton>` branch, so on first mount the chart wrapper
// isn't in the DOM, ref.current is null, and a useEffect with `[]` deps fires
// once against a null ref and never re-fires when the wrapper later mounts.
// A callback ref runs whenever React attaches/detaches the underlying
// element, so we always observe the live wrapper.
function useElementWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [w, setW] = useState(0);
  const obsRef = useRef<ResizeObserver | null>(null);
  const setRef = useCallback((el: T | null) => {
    obsRef.current?.disconnect();
    obsRef.current = null;
    if (!el) return;
    // Synchronous initial measure — covers the case where the element is
    // already laid out at attach time and ResizeObserver's first callback
    // would otherwise deliver the same value one frame late.
    const initial = Math.round(el.getBoundingClientRect().width);
    if (initial > 0) setW(initial);
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width ?? 0;
      if (cw > 0) setW(Math.round(cw));
    });
    ro.observe(el);
    obsRef.current = ro;
  }, []);
  // Tear down the observer on unmount.
  useEffect(() => () => obsRef.current?.disconnect(), []);
  return [setRef, w];
}
import { api, type Forecast } from "../../api";
import { formatApiError } from "../../api-retry";
import { SegmentedControl } from "../../components/SegmentedControl";
import { useSpireStore } from "../../state/store";
import { RecommendPanel } from "../../components/RecommendPanel";
import { CollapsiblePanel } from "../../components/CollapsiblePanel";

type Horizon = "7" | "14" | "30";

// Task #3 follow-on (PR polish): persist the operator's last-used unit and
// horizon so a fresh tab re-entry restores the prior selection. Watch-floor
// sessions tend to stay on a single unit and re-open the tab repeatedly;
// resetting to FLEET on every load is friction.
const FORECAST_PREFS_KEY = "spire.pulse.forecast.v1";
function readForecastPrefs(): { unit?: string; horizon?: Horizon } {
  try {
    const raw = localStorage.getItem(FORECAST_PREFS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    const horizon = ["7", "14", "30"].includes(parsed?.horizon) ? (parsed.horizon as Horizon) : undefined;
    const unit = typeof parsed?.unit === "string" && parsed.unit.length > 0 ? parsed.unit : undefined;
    return { unit, horizon };
  } catch {
    return {};
  }
}
function writeForecastPrefs(unit: string, horizon: Horizon): void {
  try {
    localStorage.setItem(FORECAST_PREFS_KEY, JSON.stringify({ unit, horizon }));
  } catch {
    /* localStorage may be unavailable (private browsing); fail silent. */
  }
}

export function ForecastTab() {
  const role = useSpireStore((s) => s.role);
  const [params] = useSearchParams();
  // Honor an inbound ?unit=… deep link (e.g. from PredictedFailurePanel's
  // Draft Action button). URL param wins over persisted prefs (deep links
  // are explicit operator intent), then persisted, then FLEET default.
  const persistedRef = useRef(readForecastPrefs());
  const initialUnit = params.get("unit") ?? persistedRef.current.unit ?? "FLEET";
  const initialHorizon = persistedRef.current.horizon ?? "14";
  const [unit, setUnit] = useState<string>(initialUnit);
  const [horizon, setHorizon] = useState<Horizon>(initialHorizon);
  const [data, setData] = useState<Forecast | null>(null);
  const [units, setUnits] = useState<string[]>([]);
  // Issues #19, #20, #21, #22 — explicit error + loading state. The prior
  // implementation swallowed errors with a no-op `.catch(() => {})` and
  // left the skeleton on screen forever, which the operator interpreted
  // as "the chart loads once and then nothing happens" when nav-ing away
  // and back during a transient backend hiccup. We now track:
  //   - loading: a request is in flight
  //   - error:   the last request failed (with a retry CTA)
  // Plus an AbortController + request-generation guard to discard stale
  // responses when unit/horizon change rapidly.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every manual retry so the fetch effect re-runs even when
  // unit/horizon haven't changed.
  const [reloadKey, setReloadKey] = useState(0);
  // Task #3 follow-on: timestamp of the last successful response so the
  // operator can see how stale the displayed projection is. Wall-clock
  // time avoids the complexity of an interval-driven "X seconds ago".
  const [lastRefreshed, setLastRefreshed] = useState<number | null>(null);
  // Generation token guards against late-arriving stale responses
  // overwriting fresh ones (race when the user toggles unit/horizon
  // faster than the network resolves).
  const reqGenRef = useRef(0);
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
    // Walkthrough audit: prior code had no .catch, so a transient
    // 502 during deploy churn surfaced as 'Uncaught (in promise)' in
    // the console. Tolerate quietly — the dropdown just stays at FLEET.
    api.bastion.cop()
      .then((cop) => setUnits(cop.units.map((u) => u.unit)))
      .catch(() => { /* tolerate; dropdown stays at FLEET */ });
  }, [role]);

  // Task #3 follow-on: if a persisted unit isn't in the role-scoped unit
  // list (e.g. the operator switched from MEF Commander to Maintenance
  // Chief, whose persisted MWSS-271 isn't visible), fall back to FLEET so
  // the dropdown isn't showing a value that isn't an option.
  useEffect(() => {
    if (unit !== "FLEET" && units.length > 0 && !units.includes(unit)) {
      setUnit("FLEET");
    }
  }, [units, unit]);

  // Task #3 follow-on: write current selection to localStorage whenever
  // it changes. Persist-on-change rather than persist-on-unmount so an
  // unexpected reload still preserves the operator's choice.
  useEffect(() => {
    writeForecastPrefs(unit, horizon);
  }, [unit, horizon]);

  useEffect(() => {
    const targetUnit = unit === "FLEET" ? undefined : unit;
    const myGen = ++reqGenRef.current;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    // Issues #19–#22 — pass the abort signal so we can cancel in-flight
    // requests when the user changes unit/horizon mid-fetch (or
    // unmounts), and gate state updates on the generation token so a
    // late response from a previous selection cannot overwrite the
    // current one.
    api.pulse.forecast(targetUnit, Number(horizon), ctrl.signal)
      .then((d) => {
        if (myGen !== reqGenRef.current) return;
        setData(d);
        setError(null);
        setLastRefreshed(Date.now());
      })
      .catch((e) => {
        if (myGen !== reqGenRef.current) return;
        // AbortError is expected on dependency changes; don't surface it.
        if (e?.name === "AbortError") return;
        setError(formatApiError(e));
      })
      .finally(() => {
        if (myGen !== reqGenRef.current) return;
        setLoading(false);
      });
    return () => ctrl.abort();
  }, [unit, horizon, role, reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  // Build the combined series. Null-guarded so hooks order stays stable.
  // Walkthrough audit: per-path data was passed via `<Line data={...}>`,
  // which recharts appends to the parent x-axis as additional categories
  // (44 path dates × 30 paths got rendered as duplicate ticks at the end
  // of the chart). Inline each sampled path as a `path{i}` field on the
  // parent series so every line shares the same 44-position x-axis.
  const PATHS_TO_RENDER = 30;
  const series = useMemo(() => {
    if (!data) return [];
    const hist = data.history.map((h, hi) => {
      const row: Record<string, unknown> = {
        date: h.date.slice(5),
        actual: h.mc_rate,
        projected: undefined,
        p10: undefined,
        p90: undefined,
      };
      // Pre-fill path columns so each row has the same shape (recharts
      // tolerates `null` better than `undefined` for skipped points).
      for (let i = 0; i < PATHS_TO_RENDER; i++) row[`path${i}`] = null;
      // Anchor each path at TODAY (last hist row) with the actual value
      // so the spaghetti reads as continuing from the historical line.
      if (hi === data.history.length - 1) {
        for (let i = 0; i < PATHS_TO_RENDER; i++) row[`path${i}`] = h.mc_rate;
      }
      return row;
    });
    const proj = data.projection.map((p, pi) => {
      const row: Record<string, unknown> = {
        date: p.date.slice(5),
        actual: undefined,
        projected: p.projected_mc_rate,
        p10: p.p10,
        p90: p.p90,
      };
      const paths = data.paths || [];
      for (let i = 0; i < PATHS_TO_RENDER; i++) {
        const v = paths[i]?.[pi];
        row[`path${i}`] = v != null ? v : null;
      }
      return row;
    });
    if (hist.length && proj.length) {
      proj[0] = { ...proj[0], actual: hist[hist.length - 1].actual };
    }
    return [...hist, ...proj];
  }, [data]);

  // Walkthrough #21 — keep controls mounted during fetch by NOT returning
  // an early loading state. Skeleton only fills the chart pane.
  // Issues #19–#22 — distinguish data-present from in-flight: the chart
  // re-renders cached data while a refresh is loading, so the operator
  // never sees a blank screen on re-entry to the tab.
  const dataLoaded = !!data;
  const showSkeleton = !dataLoaded && loading && !error;
  const showError = !!error && !loading;
  const todayLabel = data?.history?.length
    ? data.history[data.history.length - 1].date.slice(5)
    : null;

  const endCross = data?.projection?.length
    ? data.projection[data.projection.length - 1].cross_probability
    : 0;

  // Walkthrough #50 — render the sample paths, not just an envelope. Bump
  // sample count and opacity so the spaghetti is visible.
  const visiblePaths = (data?.paths || []).slice(0, 60);

  const thresholdSafe = typeof data?.threshold === "number" && !Number.isNaN(data!.threshold)
    ? data!.threshold : 0.85;
  const chartUsable = !!data && series.length > 0 && data.history.length > 0 && data.projection.length > 0;

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
          {/* Issues #19–#22 — manual reload control. The chart is cached
           * across nav-aways, but the operator can force a fresh fit on
           * the latest snapshot without changing unit/horizon. */}
          <div className="flex flex-col items-end gap-0.5">
            <button
              onClick={reload}
              disabled={loading}
              className="rounded-sm border border-[var(--color-border-active)] px-2 py-1 font-mono text-xs uppercase text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)] disabled:opacity-50 tracking-widest"
              title="Re-fit Monte Carlo on latest data"
              aria-label="Reload forecast"
            >
              {loading && dataLoaded ? "Refreshing…" : "Reload"}
            </button>
            {/* Task #3 follow-on: timestamp of last successful response so
             * the operator can tell at a glance how stale the chart is. */}
            {lastRefreshed != null && (
              <span
                className="font-mono text-[10px] uppercase text-[var(--color-text-muted)] tracking-widest tabular-nums"
                title={new Date(lastRefreshed).toString()}
              >
                refreshed {new Date(lastRefreshed).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Chart pane — fixed height; width measured by ResizeObserver. The
       * ComposedChart receives explicit numeric width/height so paint is
       * never gated on Recharts' ResponsiveContainer correctly resolving its
       * parent box (which it does not, reliably, on Rolldown's first frame).
       * Internal margin gives the chart breathing room — no inner padding on
       * the wrapper, which used to be the source of double-padding offsets. */}
      {/* Walkthrough #21 — chart pane shows skeleton while controls stay
       * mounted above. */}
      <div
        ref={chartRef}
        className="relative shrink-0 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]"
        style={{ height: CHART_HEIGHT, minHeight: CHART_HEIGHT }}
      >
        {/* Issues #19–#22 (review polish): when refreshing over already-
         * rendered data, a tiny in-chart pill makes it obvious the chart
         * is being re-fit, so the operator doesn't read stale-looking
         * lines as fresh. */}
        {loading && dataLoaded && !showError && (
          <div
            className="pointer-events-none absolute right-2 top-2 z-10 flex items-center gap-1.5 rounded-sm border border-[var(--color-border-active)] bg-[var(--color-surface)]/90 px-2 py-1 font-mono text-[10px] uppercase text-[var(--color-text-secondary)] tracking-widest shadow"
            aria-live="polite"
          >
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-primary)]" />
            Refreshing
          </div>
        )}
        {showError ? (
          // Issues #19–#22 — explicit error pane with retry. Replaces the
          // prior silent skeleton-forever behavior on transient failures.
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
            <div className="font-semibold uppercase text-[var(--color-danger)] tracking-widest">
              Forecast Unavailable
            </div>
            <div className="max-w-md text-[var(--color-text-secondary)] leading-relaxed">
              {error}
            </div>
            <button
              onClick={reload}
              className="mt-1 rounded-sm border border-[var(--color-primary)] bg-[var(--color-primary)] px-3 py-1.5 font-mono text-xs font-semibold uppercase text-white hover:bg-[var(--color-primary-hover)] tracking-widest"
            >
              Retry
            </button>
          </div>
        ) : showSkeleton ? (
          <div className="flex h-full items-center justify-center font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--color-primary)] mr-2" />
            Running Monte Carlo forecast …
          </div>
        ) : !dataLoaded ? (
          // No data, no error, not loading — should not happen normally,
          // but provide a manual recovery path just in case.
          <div className="flex h-full flex-col items-center justify-center gap-2 font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
            Forecast not loaded.
            <button
              onClick={reload}
              className="rounded-sm border border-[var(--color-border-active)] px-2 py-1 uppercase tracking-widest hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
            >
              Load now
            </button>
          </div>
        ) : !chartUsable ? (
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
            {/* Walkthrough audit: with 44 entries (30 history + 14
             * projection) and no tick reduction, recharts crammed every
             * date label across the bottom. Use `interval` to space ticks
             * out so labels are readable, and `minTickGap` to prevent
             * overlap on narrow charts. */}
            <XAxis
              dataKey="date"
              stroke="var(--color-text-muted)"
              fontSize={10}
              tick={{ fill: "var(--color-text-muted)" }}
              interval="preserveStartEnd"
              minTickGap={28}
            />
            {/* Walkthrough #34 — explicit ticks at 25/50/75/100 with minor
             * gridlines. Was: a single light-gray gridline pattern with no
             * tick marks at all. */}
            <YAxis
              domain={[0, 1]}
              ticks={[0, 0.25, 0.5, 0.75, 1.0]}
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
            {/* Walkthrough #35 — move threshold label to the right margin
             * so it doesn't sit on top of the projected line. `right`
             * position renders outside the plot area. */}
            <ReferenceLine
              y={thresholdSafe}
              stroke="var(--color-danger)"
              strokeDasharray="6 4"
              label={{
                value: `${(thresholdSafe * 100).toFixed(0)}%`,
                position: "right",
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
            {/* Walkthrough audit (round 2): paths now live as path0..pathN
             * fields on the parent series rows, so every Line shares the
             * one 44-position x-axis. No per-Line data prop, so recharts
             * doesn't append per-path categories to the bottom axis. */}
            {Array.from({ length: PATHS_TO_RENDER }).map((_, idx) => (
              <Line
                key={`path-${idx}`}
                dataKey={`path${idx}`}
                stroke="var(--color-primary)"
                strokeWidth={0.6}
                strokeOpacity={0.18}
                dot={false}
                isAnimationActive={false}
                connectNulls={false}
              />
            ))}
            {/* p10 / p90 envelope lines — thin, translucent, complement
             * the mean projection. Wider opacity on the band so it reads
             * as a band, not a hairline (Walkthrough #50 spirit). */}
            <Line
              dataKey="p10"
              stroke="var(--color-primary)"
              strokeWidth={1.5}
              strokeOpacity={0.55}
              dot={false}
              isAnimationActive={false}
              connectNulls={false}
            />
            <Line
              dataKey="p90"
              stroke="var(--color-primary)"
              strokeWidth={1.5}
              strokeOpacity={0.55}
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
            {dataLoaded ? (
              <>
                {(data!.projection.length > 0 ? data!.projection[data!.projection.length - 1].projected_mc_rate * 100 : 0).toFixed(1)}
                <span className="ml-0.5 text-base text-[var(--color-text-muted)]">%</span>
              </>
            ) : (
              <span className="text-[var(--color-text-muted)]">—</span>
            )}
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
          {/* Walkthrough #4 — semantic label honors cross direction
           * (recovery vs decline). starts_below_threshold flips the
           * meaning to "P(recovery to ≥75%)" for already-below units. */}
          <div className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
            {dataLoaded && (data as any).starts_below_threshold
              ? `P(recovery to ≥${(data!.threshold * 100).toFixed(0)}%)`
              : `P(cross ${(thresholdSafe * 100).toFixed(0)}% threshold)`}
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
            {dataLoaded && data!.threshold_cross_date
              ? data!.threshold_cross_date.slice(5)
              : "—"}
          </div>
          <div className="mt-0.5 font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
            {dataLoaded && data!.threshold_cross_date
              ? "mean projection crosses"
              : "no mean crossing in window"}
          </div>
        </div>
      </div>

      {/* Walkthrough #34, #50 — legend includes the spaghetti label since
       * sample paths are now actually rendered. */}
      <div className="mt-2 flex flex-wrap items-center gap-4 font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
        <LegendDot color="var(--color-success)" label="historical actuals" />
        <LegendDot color="var(--color-primary)" label="mean projection" dashed />
        <LegendDot color="var(--color-primary)" label="p10 / p90 envelope" opacity={0.55} />
        <LegendDot color="var(--color-primary)" label="sample paths" opacity={0.18} />
        <LegendDot color="var(--color-danger)" label={`${(thresholdSafe * 100).toFixed(0)}% threshold`} dashed />
        <span className="ml-auto">
          {dataLoaded ? `${visiblePaths.length} of ${data!.paths.length} sample paths summarized` : ""}
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
