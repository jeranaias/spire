/**
 * InferenceEconomicsView — D3, the answer to J3 DELTA's pushback that
 * "you can't field a $0.40-per-prompt LLM across 180,000 Marines."
 *
 * Reachable at /admin/economics, alongside /admin (Flywheel) and
 * /admin/audit (SOC). Three blocks:
 *   1. Live telemetry — calls/min, $/min, $/Marine/day extrapolated from
 *      observed mix; per-tier roll-up; top 10 most-expensive call sites.
 *   2. Rate card — the source of truth for per-tier $/1k tokens,
 *      including p50 latency and "served locally" flag for IL5 fit.
 *   3. "Defend the cost" panel — sliders for force_size,
 *      calls/Marine/day, and tier mix; computed daily/annual $ for the
 *      configured ladder, plus the all-frontier nightmare ceiling so the
 *      operator can show what the ladder is avoiding.
 *
 * Polls /admin/inference-economics every 8s (same cadence as the
 * training-flywheel telemetry).
 */
import { useEffect, useMemo, useState } from "react";
import {
  api,
  type InferenceEconomics,
  type InferenceExtrapolation,
} from "../../api";
import { useSpireStore } from "../../state/store";
import { InsufficientPrivilege } from "../../components/InsufficientPrivilege";
import { ErrorState, LoadingState } from "../../components/ui";
import { AdminTabs } from "../AdminView";

export function InferenceEconomicsView() {
  const role = useSpireStore((s) => s.role);
  if (role !== "security_manager") {
    return (
      <InsufficientPrivilege
        feature="Admin · Inference Economics"
        requiredRoles={["security_manager"]}
        description="Per-call LLM cost telemetry and the 180k-Marine extrapolation panel are restricted to Security Manager review per the audit posture."
      />
    );
  }
  return (
    <div className="flex h-full flex-col overflow-y-auto p-6">
      <AdminTabs active="economics" />
      <InferenceEconomicsTab />
    </div>
  );
}

const TIER_LABELS: Record<string, string> = {
  tier0_rule: "Tier-0 · Rule",
  tier1_small: "Tier-1 · Small SLM",
  tier2_mid: "Tier-2 · Gemma 4 26B",
  tier3_frontier: "Tier-3 · Frontier",
};

const TIER_TONES: Record<string, string> = {
  tier0_rule: "var(--color-success)",
  tier1_small: "var(--color-primary)",
  tier2_mid: "var(--color-warning)",
  tier3_frontier: "var(--color-danger)",
};

function fmtUsd(v: number, digits = 6): string {
  if (v === 0) return "$0";
  if (v >= 1) return `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  return `$${v.toFixed(digits).replace(/0+$/, "").replace(/\.$/, ".0")}`;
}

function fmtBigUsd(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}k`;
  return `$${v.toFixed(2)}`;
}

function fmtBigInt(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return v.toLocaleString("en-US");
}

export function InferenceEconomicsTab() {
  const [econ, setEcon] = useState<InferenceEconomics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const e = await api.system.inferenceEconomics(60);
        if (cancelled) return;
        setEcon(e);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        if (!econ) setError(String(e));
        else console.warn("inference-economics poll failed:", e);
      }
    };
    tick();
    const id = setInterval(tick, 8000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error && !econ) {
    return (
      <ErrorState
        title="Inference Economics Offline"
        description="Cost telemetry endpoint did not respond."
        detail={error}
        onRetry={() => window.location.reload()}
      />
    );
  }
  if (!econ) {
    return <LoadingState size="page" label="Loading inference economics …" />;
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-mono text-base font-semibold uppercase text-[var(--color-text)] tracking-widest">
          Admin · Inference Economics
        </h1>
        <div className="mt-1 spire-body-muted">
          Per-call cost telemetry for every model invocation. Tiered model
          ladder defaults to the cheapest sufficient model and escalates only
          when the cheaper rung returns insufficient confidence.{" "}
          <span className="text-[var(--color-text-muted)]">
            Window: rolling {econ.window_seconds}s · {econ.total_calls.toLocaleString("en-US")} calls in buffer.
          </span>
        </div>
      </div>

      <LiveTelemetry econ={econ} />
      <PerTierBreakdown econ={econ} />
      <TopCallSites econ={econ} />
      <RateCardBlock econ={econ} />
      <DefendCostPanel observedMix={observedMix(econ)} />
      <RecentCalls econ={econ} />
    </div>
  );
}

function observedMix(econ: InferenceEconomics): Record<string, number> {
  const total = econ.total_calls || 1;
  const out: Record<string, number> = {};
  for (const t of econ.tier_order) {
    out[t] = (econ.by_tier[t]?.calls ?? 0) / total;
  }
  return out;
}

// ---------------------------------------------------------------------------

function LiveTelemetry({ econ }: { econ: InferenceEconomics }) {
  const recent = econ.recent;
  // 180k extrapolation — direct from observed cost/min, not the
  // "Defend the cost" panel below which lets the operator override.
  const minutesPerMarinePerDay = 24 * 60;
  const callsPerMarinePerDay = (recent.calls_per_minute * minutesPerMarinePerDay) / 180_000;
  const costPerMarinePerDay = (recent.cost_per_minute_usd * minutesPerMarinePerDay) / 180_000;

  return (
    <div className="grid grid-cols-4 gap-3">
      <Stat label="Calls / min" value={recent.calls_per_minute.toFixed(2)} sub={`${recent.calls} in ${econ.window_seconds}s`} />
      <Stat label="$ / min" value={fmtUsd(recent.cost_per_minute_usd, 4)} sub={`${fmtUsd(econ.total_cost_usd, 4)} buffered`} />
      <Stat label="Avg latency" value={`${recent.avg_latency_ms.toFixed(0)} ms`} sub="recent window" />
      <Stat
        label="$/Marine/day @ 180k"
        value={fmtUsd(costPerMarinePerDay, 4)}
        sub={`${callsPerMarinePerDay.toFixed(2)} calls/Marine/day`}
        tone={costPerMarinePerDay > 0.5 ? "danger" : costPerMarinePerDay > 0.05 ? "warn" : "ok"}
      />
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "ok" | "warn" | "danger" }) {
  const color =
    tone === "ok" ? "var(--color-success)" :
    tone === "warn" ? "var(--color-warning)" :
    tone === "danger" ? "var(--color-danger)" :
    "var(--color-text)";
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest">{label}</div>
      <div className="mt-1 font-mono text-xl font-semibold tabular-nums" style={{ color }}>{value}</div>
      {sub && <div className="mt-0.5 font-mono text-xs text-[var(--color-text-muted)]">{sub}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------

function PerTierBreakdown({ econ }: { econ: InferenceEconomics }) {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="mb-3 font-mono text-xs uppercase text-[var(--color-primary)] tracking-widest">
        Per-Tier Breakdown
      </div>
      <div className="grid grid-cols-4 gap-3">
        {econ.tier_order.map((tier) => {
          const b = econ.by_tier[tier];
          const tone = TIER_TONES[tier] || "var(--color-text)";
          const calls = b?.calls ?? 0;
          const cost = b?.total_cost_usd ?? 0;
          const errs = b?.errors ?? 0;
          const tokens = (b?.total_input_tokens ?? 0) + (b?.total_output_tokens ?? 0);
          return (
            <div
              key={tier}
              className="rounded-md border bg-[var(--color-bg)] p-3"
              style={{ borderColor: `color-mix(in oklab, ${tone} 35%, var(--color-border))` }}
            >
              <div className="font-mono text-xs uppercase tracking-widest" style={{ color: tone }}>
                {TIER_LABELS[tier] || tier}
              </div>
              <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-[var(--color-text)]">
                {calls.toLocaleString("en-US")}
              </div>
              <div className="mt-0.5 font-mono text-[10px] uppercase text-[var(--color-text-muted)] tracking-wider">
                calls
              </div>
              <div className="mt-2 flex justify-between font-mono text-xs">
                <span className="text-[var(--color-text-muted)]">cost</span>
                <span className="tabular-nums text-[var(--color-text)]">{fmtUsd(cost, 4)}</span>
              </div>
              <div className="flex justify-between font-mono text-xs">
                <span className="text-[var(--color-text-muted)]">tokens</span>
                <span className="tabular-nums text-[var(--color-text-secondary)]">{fmtBigInt(tokens)}</span>
              </div>
              {errs > 0 && (
                <div className="flex justify-between font-mono text-xs">
                  <span className="text-[var(--color-text-muted)]">errors</span>
                  <span className="tabular-nums text-[var(--color-danger)]">{errs}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function TopCallSites({ econ }: { econ: InferenceEconomics }) {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="mb-3 font-mono text-xs uppercase text-[var(--color-primary)] tracking-widest">
        Top 10 Most-Expensive Call Sites
      </div>
      {econ.top_call_sites.length === 0 ? (
        <div className="rounded-sm border border-dashed border-[var(--color-border)] p-4 text-center font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
          NO CALLS YET — invoke SPIRO or a TMR submission to populate this table
        </div>
      ) : (
        <table className="w-full font-mono text-xs">
          <thead>
            <tr className="text-[var(--color-text-muted)] tracking-wider">
              <th className="px-1 py-1 text-left uppercase">Call site</th>
              <th className="px-1 py-1 text-right uppercase">Calls</th>
              <th className="px-1 py-1 text-right uppercase">Total $</th>
              <th className="px-1 py-1 text-right uppercase">Avg $/call</th>
              <th className="px-1 py-1 text-right uppercase">Avg latency</th>
              <th className="px-1 py-1 text-left uppercase">Tier mix</th>
            </tr>
          </thead>
          <tbody>
            {econ.top_call_sites.map((s) => (
              <tr key={s.call_site} className="border-t border-[var(--color-border)]">
                <td className="px-1 py-1 text-[var(--color-text)]">{s.call_site}</td>
                <td className="px-1 py-1 text-right tabular-nums">{s.calls}</td>
                <td className="px-1 py-1 text-right tabular-nums">{fmtUsd(s.total_cost_usd, 4)}</td>
                <td className="px-1 py-1 text-right tabular-nums">{fmtUsd(s.avg_cost_usd, 6)}</td>
                <td className="px-1 py-1 text-right tabular-nums text-[var(--color-text-secondary)]">
                  {s.avg_latency_ms.toFixed(0)} ms
                </td>
                <td className="px-1 py-1 text-[var(--color-text-secondary)]">
                  {Object.entries(s.tiers).map(([t, n]) => (
                    <span
                      key={t}
                      className="mr-1 inline-block rounded-sm border px-1 text-[10px] tracking-wider"
                      style={{
                        color: TIER_TONES[t] || "var(--color-text-muted)",
                        borderColor: `color-mix(in oklab, ${TIER_TONES[t] || "var(--color-border)"} 40%, var(--color-border))`,
                      }}
                    >
                      {(TIER_LABELS[t] || t).split("·")[0].trim()} ×{n}
                    </span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function RateCardBlock({ econ }: { econ: InferenceEconomics }) {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <div className="font-mono text-xs uppercase text-[var(--color-primary)] tracking-widest">
          Model Ladder · Rate Card
        </div>
        <div className="font-mono text-[10px] uppercase text-[var(--color-text-muted)] tracking-widest">
          source: backend/inference_economics.py
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {econ.tier_order.map((tier) => {
          const r = econ.rate_card[tier];
          const tone = TIER_TONES[tier] || "var(--color-text)";
          return (
            <div
              key={tier}
              className="rounded-sm border bg-[var(--color-bg)] p-3"
              style={{ borderColor: `color-mix(in oklab, ${tone} 35%, var(--color-border))` }}
            >
              <div className="flex items-baseline justify-between">
                <div className="font-mono text-sm font-semibold tracking-wide" style={{ color: tone }}>
                  {r.label}
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] uppercase text-[var(--color-text-muted)] tracking-widest">
                    p50 {r.p50_latency_ms} ms
                  </span>
                  <span
                    className="rounded-sm border px-1 font-mono text-[10px] uppercase tracking-wider"
                    style={{
                      color: r.served_locally ? "var(--color-success)" : "var(--color-danger)",
                      borderColor: r.served_locally ? "var(--color-success-muted)" : "var(--color-danger-muted)",
                    }}
                    title={r.served_locally ? "Served on-prem; air-gap compatible" : "Served off-rig; air-gap incompatible"}
                  >
                    {r.served_locally ? "LOCAL" : "OFF-RIG"}
                  </span>
                </div>
              </div>
              <div className="mt-0.5 font-mono text-xs text-[var(--color-text-secondary)]">{r.model}</div>
              <div className="mt-2 grid grid-cols-2 gap-2 font-mono text-xs">
                <div>
                  <span className="text-[var(--color-text-muted)]">input</span>{" "}
                  <span className="tabular-nums text-[var(--color-text)]">{fmtUsd(r.input_per_1k_usd, 5)}</span>
                  <span className="text-[var(--color-text-muted)]"> / 1k tok</span>
                </div>
                <div>
                  <span className="text-[var(--color-text-muted)]">output</span>{" "}
                  <span className="tabular-nums text-[var(--color-text)]">{fmtUsd(r.output_per_1k_usd, 5)}</span>
                  <span className="text-[var(--color-text-muted)]"> / 1k tok</span>
                </div>
              </div>
              <div className="mt-1 font-mono text-[11px] italic text-[var(--color-text-muted)] tracking-wide">
                {r.notes}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function DefendCostPanel({ observedMix }: { observedMix: Record<string, number> }) {
  const [forceSize, setForceSize] = useState<number>(180_000);
  const [callsPerDay, setCallsPerDay] = useState<number>(6);
  const [mix, setMix] = useState<Record<string, number>>({
    tier0_rule: 50,
    tier1_small: 35,
    tier2_mid: 14,
    tier3_frontier: 1,
  });
  const [proj, setProj] = useState<InferenceExtrapolation | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Fast-drag debounce + in-flight cancellation. The original useEffect
  // fired one POST per slider tick which raced itself; under a fast drag
  // the backend returned a transient 502 (caught by Run B walkthrough).
  // We now coalesce changes into a single trailing call (~180ms after
  // the slider settles) and abort any in-flight extrapolation when a
  // newer request lands.
  useEffect(() => {
    const controller = new AbortController();
    const t = setTimeout(async () => {
      setBusy(true);
      setErr(null);
      try {
        const result = await api.system.inferenceExtrapolate({
          force_size: forceSize,
          calls_per_marine_per_day: callsPerDay,
          tier_mix: mix,
        }, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setProj(result);
      } catch (e) {
        // AbortError is the expected outcome of a faster drag landing
        // a newer request — don't surface it as a UI error.
        const name = (e as { name?: string } | null)?.name;
        if (controller.signal.aborted || name === "AbortError") return;
        setErr(String(e));
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    }, 180);
    return () => {
      clearTimeout(t);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceSize, callsPerDay, mix.tier0_rule, mix.tier1_small, mix.tier2_mid, mix.tier3_frontier]);

  const useObserved = () => {
    const sum = Object.values(observedMix).reduce((a, b) => a + b, 0);
    if (sum <= 0) return;
    const next = {
      tier0_rule: Math.round((observedMix.tier0_rule || 0) * 100),
      tier1_small: Math.round((observedMix.tier1_small || 0) * 100),
      tier2_mid: Math.round((observedMix.tier2_mid || 0) * 100),
      tier3_frontier: Math.round((observedMix.tier3_frontier || 0) * 100),
    };
    setMix(next);
  };

  const totalMix = useMemo(
    () => Object.values(mix).reduce((a, b) => a + Math.max(0, b), 0),
    [mix],
  );

  return (
    <div className="rounded-md border-2 border-[var(--color-warning)] bg-[var(--color-surface)] p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <div className="font-mono text-xs uppercase tracking-widest" style={{ color: "var(--color-warning)" }}>
          ◢◤ Defend the Cost · 180,000-Marine extrapolation
        </div>
        <button
          onClick={useObserved}
          className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-secondary)] hover:border-[var(--color-primary)] hover:text-[var(--color-text)]"
          title="Set tier mix to the observed live ratio"
        >
          Use observed mix
        </button>
      </div>
      <div className="font-mono text-xs italic text-[var(--color-text-muted)] tracking-wide">
        J3 stress test: every knob below stress-tests the cost claim. Move the
        sliders. Watch the daily/annual $ track.
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <Slider
          label="Force size (Marines)"
          min={1000}
          max={500_000}
          step={1000}
          value={forceSize}
          onChange={setForceSize}
          fmt={(v) => v.toLocaleString("en-US")}
        />
        <Slider
          label="Calls / Marine / day"
          min={0.1}
          max={50}
          step={0.1}
          value={callsPerDay}
          onChange={setCallsPerDay}
          fmt={(v) => v.toFixed(1)}
        />
      </div>

      <div className="mt-3 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-2">
        <div className="mb-2 flex items-baseline justify-between">
          <div className="font-mono text-[10px] uppercase text-[var(--color-text-muted)] tracking-widest">
            Tier mix · weights renormalize automatically
          </div>
          <div className="font-mono text-[10px] tabular-nums text-[var(--color-text-secondary)] tracking-wider">
            sum {totalMix}
          </div>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {(["tier0_rule", "tier1_small", "tier2_mid", "tier3_frontier"] as const).map((t) => (
            <div key={t} className="flex flex-col">
              <label className="mb-1 font-mono text-[10px] uppercase tracking-widest" style={{ color: TIER_TONES[t] }}>
                {(TIER_LABELS[t] || t).split("·")[0].trim()}
              </label>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={mix[t]}
                onChange={(e) => setMix({ ...mix, [t]: Number(e.target.value) })}
                className="accent-[var(--color-primary)]"
              />
              <div className="mt-0.5 font-mono text-[10px] tabular-nums text-[var(--color-text)]">
                {mix[t]}%
              </div>
            </div>
          ))}
        </div>
      </div>

      {err && <div className="mt-2 font-mono text-xs text-[var(--color-danger)]">{err}</div>}

      {proj && (
        <div className="mt-3 grid grid-cols-2 gap-3">
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
            <div className="font-mono text-[10px] uppercase text-[var(--color-text-muted)] tracking-widest">
              Configured ladder
            </div>
            <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-[var(--color-text)]">
              {fmtBigUsd(proj.daily_cost_usd)}
              <span className="ml-1 text-xs text-[var(--color-text-muted)]">/ day</span>
            </div>
            <div className="font-mono text-sm tabular-nums text-[var(--color-text-secondary)]">
              {fmtBigUsd(proj.annual_cost_usd)}<span className="ml-1 text-xs text-[var(--color-text-muted)]"> / year</span>
            </div>
            <div className="mt-2 font-mono text-xs text-[var(--color-text-secondary)] tracking-wide">
              Blended {fmtUsd(proj.blended_cost_per_call_usd, 5)} / call ·
              {" "}{fmtUsd(proj.cost_per_marine_per_day_usd, 4)} / Marine / day
            </div>
          </div>
          <div className="rounded-md border-2 border-[var(--color-danger)] bg-[var(--color-bg)] p-3">
            <div className="font-mono text-[10px] uppercase tracking-widest" style={{ color: "var(--color-danger)" }}>
              All-frontier nightmare ($0.40-per-prompt scenario)
            </div>
            <div className="mt-1 font-mono text-2xl font-semibold tabular-nums" style={{ color: "var(--color-danger)" }}>
              {fmtBigUsd(proj.all_frontier_daily_cost_usd)}
              <span className="ml-1 text-xs text-[var(--color-text-muted)]">/ day</span>
            </div>
            <div className="font-mono text-sm tabular-nums" style={{ color: "var(--color-danger)" }}>
              {fmtBigUsd(proj.all_frontier_annual_cost_usd)}<span className="ml-1 text-xs text-[var(--color-text-muted)]"> / year</span>
            </div>
            <div className="mt-2 font-mono text-xs text-[var(--color-success)] tracking-wide">
              Ladder saves {proj.savings_vs_all_frontier_pct}% vs every-call-on-frontier.
            </div>
          </div>
        </div>
      )}

      {proj && (
        <div className="mt-3 overflow-hidden rounded-sm border border-[var(--color-border)]">
          <table className="w-full font-mono text-xs">
            <thead>
              <tr className="bg-[var(--color-bg)] text-[var(--color-text-muted)] tracking-wider">
                <th className="px-2 py-1 text-left uppercase">Tier</th>
                <th className="px-2 py-1 text-right uppercase">Share</th>
                <th className="px-2 py-1 text-right uppercase">$/call (ref 1k+500)</th>
                <th className="px-2 py-1 text-right uppercase">Calls / day</th>
                <th className="px-2 py-1 text-right uppercase">$ / day</th>
              </tr>
            </thead>
            <tbody>
              {proj.by_tier.map((row) => (
                <tr key={row.tier} className="border-t border-[var(--color-border)]">
                  <td className="px-2 py-1" style={{ color: TIER_TONES[row.tier] }}>
                    {(TIER_LABELS[row.tier] || row.tier).split("·")[0].trim()}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">{(row.share * 100).toFixed(1)}%</td>
                  <td className="px-2 py-1 text-right tabular-nums">{fmtUsd(row.cost_per_call_usd, 5)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{fmtBigInt(row.calls_per_day)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{fmtBigUsd(row.daily_cost_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {busy && (
        <div className="mt-2 font-mono text-[10px] uppercase text-[var(--color-text-muted)] tracking-widest">
          recomputing …
        </div>
      )}
    </div>
  );
}

function Slider({
  label,
  min,
  max,
  step,
  value,
  onChange,
  fmt,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  fmt: (v: number) => string;
}) {
  return (
    <div className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-2">
      <div className="flex items-baseline justify-between">
        <label className="font-mono text-[10px] uppercase text-[var(--color-text-muted)] tracking-widest">
          {label}
        </label>
        <span className="font-mono text-sm tabular-nums text-[var(--color-text)]">{fmt(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full accent-[var(--color-primary)]"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

function RecentCalls({ econ }: { econ: InferenceEconomics }) {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="mb-3 font-mono text-xs uppercase text-[var(--color-primary)] tracking-widest">
        Recent Calls ({econ.recent_calls.length})
      </div>
      {econ.recent_calls.length === 0 ? (
        <div className="rounded-sm border border-dashed border-[var(--color-border)] p-4 text-center font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
          NO CALLS YET
        </div>
      ) : (
        <div className="max-h-72 overflow-y-auto">
          <table className="w-full font-mono text-xs">
            <thead>
              <tr className="text-[var(--color-text-muted)] tracking-wider">
                <th className="px-1 py-1 text-left uppercase">When</th>
                <th className="px-1 py-1 text-left uppercase">Tier</th>
                <th className="px-1 py-1 text-left uppercase">Call site</th>
                <th className="px-1 py-1 text-left uppercase">Route</th>
                <th className="px-1 py-1 text-right uppercase">In tok</th>
                <th className="px-1 py-1 text-right uppercase">Out tok</th>
                <th className="px-1 py-1 text-right uppercase">Latency</th>
                <th className="px-1 py-1 text-right uppercase">Cost</th>
              </tr>
            </thead>
            <tbody>
              {econ.recent_calls.map((c, i) => (
                <tr key={`${c.ts}-${i}`} className="border-t border-[var(--color-border)]">
                  <td className="px-1 py-1 tabular-nums text-[var(--color-text-secondary)]" title={c.ts}>
                    {c.ts.slice(11, 19)}z
                  </td>
                  <td className="px-1 py-1" style={{ color: TIER_TONES[c.tier] || "var(--color-text)" }}>
                    {(TIER_LABELS[c.tier] || c.tier).split("·")[0].trim()}
                  </td>
                  <td className="px-1 py-1 text-[var(--color-text)]">{c.call_site}</td>
                  <td className="px-1 py-1 text-[var(--color-text-muted)]">{c.route}</td>
                  <td className="px-1 py-1 text-right tabular-nums">{c.input_tokens}</td>
                  <td className="px-1 py-1 text-right tabular-nums">{c.output_tokens}</td>
                  <td className="px-1 py-1 text-right tabular-nums text-[var(--color-text-secondary)]">
                    {c.latency_ms.toFixed(0)} ms
                  </td>
                  <td className="px-1 py-1 text-right tabular-nums">
                    {c.error ? (
                      <span className="text-[var(--color-danger)]" title={c.error}>err</span>
                    ) : (
                      fmtUsd(c.cost_usd, 6)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
