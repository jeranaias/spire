/**
 * PredictedFailurePanel — GC-3 surface.
 *
 * Mounted at the top of the Risk Board. Pulls /pulse/predict-failures and
 * renders the assets most likely to fail within the configured horizon
 * window. Each prediction shows component + probability + days-out and a
 * "Draft Requisition" button that pre-fills a parts order routed through
 * the existing /pulse/recommend-actions surface (cannib / expedite /
 * cross-level — the operator picks the right action).
 *
 * Engine label visible on every card so the operator knows whether the
 * score came from the rule-based fallback or the J2 trained predictor
 * once weights are loaded.
 */
import { useEffect, useState } from "react";
import { api, type PredictedFailureAsset, type FailurePrediction } from "../api";
import { useSpireStore } from "../state/store";
import { useNavigate } from "react-router-dom";

export function PredictedFailurePanel({ unit, hideHeader = false }: { unit?: string | null; hideHeader?: boolean }) {
  const role = useSpireStore((s) => s.role);
  const pushToast = useSpireStore((s) => s.pushToast);
  const nav = useNavigate();
  const [data, setData] = useState<PredictedFailureAsset[] | null>(null);
  const [engine, setEngine] = useState<string>("");
  const [horizon, setHorizon] = useState(14);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    api.pulse
      .predictFailures({ unit: unit ?? undefined, horizon_days: horizon, threshold: 0.4 })
      .then((r) => {
        setData(r.assets);
        setEngine(r.engine);
      })
      .catch((e) => setError(String(e)));
  }, [unit, horizon, role]);

  if (error) {
    return (
      <div className="mb-4 rounded-sm border border-[var(--color-danger-muted)] bg-[var(--color-surface)] p-3 text-xs text-[var(--color-danger)]">
        Predictive engine unavailable: {error}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="mb-4 flex items-center gap-3 rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] p-3 font-mono text-sm text-[var(--color-text-muted)] tracking-wider">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--color-primary)]" />
        Computing predicted failures …
      </div>
    );
  }
  if (data.length === 0) {
    // Visible "no predictions" line so operators don't wonder whether the
    // panel is broken vs. simply quiet. Engine label is preserved so the
    // J2-vs-rule_based distinction is still legible at a glance.
    return (
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
        <span
          className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-success)]"
          style={{ boxShadow: "0 0 4px var(--color-success)" }}
          aria-hidden
        />
        <span
          className="font-mono text-xs font-semibold uppercase text-[var(--color-success)] tracking-widest"
        >
          Predicted Failures
        </span>
        <span
          className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest"
        >
          No assets above threshold within {horizon}d horizon
        </span>
        <span className="ml-auto font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
          engine: {engine}
        </span>
      </div>
    );
  }

  return (
    <div className="mb-4 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-2">
        <div>
          {!hideHeader && (
            <div className="font-mono text-xs uppercase text-[var(--color-warning)] tracking-widest">
              Predicted Failures
            </div>
          )}
          <div className={hideHeader ? "spire-body-muted text-base" : "mt-0.5 spire-body-muted text-base"}>
            {data.length} asset{data.length === 1 ? "" : "s"} flagged within {horizon}d horizon
            <span className="ml-2 font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
              engine: {engine}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
            Horizon
          </span>
          {[7, 14, 30].map((h) => (
            <button
              key={h}
              onClick={() => setHorizon(h)}
              className="rounded-sm border px-2 py-[2px] font-mono text-xs font-semibold uppercase transition-colors tracking-wider"
              style={{
                borderColor: horizon === h ? "var(--color-primary)" : "var(--color-border)",
                background: horizon === h ? "var(--color-primary)" : "transparent",
                color: horizon === h ? "white" : "var(--color-text-secondary)",
              }}
            >
              {h}d
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-col divide-y divide-[var(--color-border)]">
        {data.slice(0, 6).map((a) => (
          <PredictedRow
            key={a.asset_id}
            asset={a}
            onDraftRequisition={() => {
              // Reviewer round 2: prior "scroll-to-top + toast" was a
              // no-op-with-side-effects — the URL changed but the operator
              // landed nowhere useful. Recommended Actions actually live on
              // PULSE Forecast (GC-1 panel). Navigate there scoped to this
              // asset's unit so the operator lands directly on the action
              // ranking for the predicted-failing asset.
              pushToast({
                tone: "info",
                text: `Opening recommended actions for ${a.unit_name} · ${a.equipment_type}`,
                ttlMs: 4000,
              });
              nav(
                `/pulse/forecast?unit=${encodeURIComponent(a.unit_name)}&asset=${encodeURIComponent(a.asset_id)}`,
              );
            }}
          />
        ))}
        {data.length > 6 && (
          <div className="px-4 py-2 font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
            + {data.length - 6} more flagged · scope to a unit to see them
          </div>
        )}
      </div>
    </div>
  );
}

function PredictedRow({
  asset,
  onDraftRequisition,
}: {
  asset: PredictedFailureAsset;
  onDraftRequisition: () => void;
}) {
  const top: FailurePrediction = asset.predictions[0];
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 font-mono text-sm tracking-wide">
          <span className="font-semibold text-[var(--color-text)]">{asset.asset_id}</span>
          <span className="text-[var(--color-text-muted)]">{asset.equipment_type}</span>
          <span className="text-[var(--color-text-muted)]">· {asset.unit_name}</span>
          <span className="text-[var(--color-text-muted)]">· {asset.current_hours.toFixed(0)} hrs</span>
        </div>
        <div className="mt-0.5 font-mono text-xs text-[var(--color-text-secondary)] tracking-wide">
          {asset.predictions.slice(0, 3).map((p, i) => (
            <span key={i} className="mr-3">
              <span style={{ color: criticalityColor(p.criticality) }}>
                {p.component}
              </span>{" "}
              <span className="text-[var(--color-text-muted)]">in {p.predicted_window_days}d</span>
              {p.common_failure_modes && p.common_failure_modes.length > 0 && (
                <span className="text-[var(--color-text-muted)]">
                  {" "}({p.common_failure_modes.slice(0, 2).join(", ")})
                </span>
              )}
            </span>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2 font-mono">
        <ProbBar prob={top.probability} />
        <span
          className="rounded-sm border px-1.5 py-[1px] text-xs uppercase tracking-wider"
          style={{
            borderColor: criticalityColor(top.criticality),
            color: criticalityColor(top.criticality),
            background: `color-mix(in oklab, ${criticalityColor(top.criticality)} 12%, transparent)`,
          }}
        >
          {top.criticality}
        </span>
      </div>
      <button
        onClick={onDraftRequisition}
        className="rounded-sm border border-[var(--color-warning)] bg-[color-mix(in_oklab,var(--color-warning-muted)_30%,transparent)] px-3 py-1 font-mono text-xs font-semibold uppercase text-[var(--color-warning)] hover:bg-[color-mix(in_oklab,var(--color-warning-muted)_50%,transparent)] tracking-wider"
      >
        Draft Action
      </button>
    </div>
  );
}

function ProbBar({ prob }: { prob: number }) {
  const color = prob >= 0.75 ? "var(--color-danger)" : prob >= 0.55 ? "#fb923c" : "var(--color-warning)";
  return (
    <div className="flex items-center gap-1.5">
      <div className="relative h-[5px] w-[60px] overflow-hidden rounded-[1px] border" style={{ borderColor: `color-mix(in oklab, ${color} 30%, var(--color-border))` }}>
        <div
          className="absolute inset-y-0 left-0"
          style={{ width: `${prob * 100}%`, background: color }}
        />
      </div>
      <span className="font-mono text-xs tabular-nums tracking-wide" style={{ color }}>
        {(prob * 100).toFixed(0)}%
      </span>
    </div>
  );
}

function criticalityColor(c: string): string {
  if (c === "high") return "var(--color-danger)";
  if (c === "medium") return "var(--color-warning)";
  return "var(--color-text-secondary)";
}
