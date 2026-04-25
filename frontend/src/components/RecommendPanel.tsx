/**
 * RecommendPanel — GC-1 Autonomous Replenishment surface.
 *
 * Mounted under the PULSE Forecast chart. Pulls /pulse/recommend-actions
 * and renders the top-N at-risk assets with their ranked candidate
 * actions (cannibalize / expedite / cross-level). Each action shows the
 * impact-per-dollar-per-day score, cost, time-to-effect, expected MC%
 * delta, and an Approve button that creates the downstream artifact.
 *
 * This is the moment PULSE stops being a scoreboard and becomes an
 * operator. The score is the same primitive a G-4 would use to choose
 * between "wait for the depot order" and "burn the expedite budget."
 */
import { useEffect, useState } from "react";
import { api, type RecommendActionsAsset, type RecommendedAction } from "../api";
import { useSpireStore } from "../state/store";

const KIND_COLOR: Record<string, string> = {
  cannibalize: "var(--color-warning)",
  expedite: "var(--color-danger)",
  cross_level: "var(--color-primary)",
  redistribute: "var(--color-info)",
};

const KIND_LABEL: Record<string, string> = {
  cannibalize: "CANNIBALIZE",
  expedite: "EXPEDITE",
  cross_level: "CROSS-LEVEL",
  redistribute: "REDISTRIBUTE",
};

export function RecommendPanel({ unit }: { unit?: string }) {
  const role = useSpireStore((s) => s.role);
  const pushToast = useSpireStore((s) => s.pushToast);
  const [data, setData] = useState<RecommendActionsAsset[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingApproval, setPendingApproval] = useState<string | null>(null);
  const [executed, setExecuted] = useState<Set<string>>(new Set());

  useEffect(() => {
    setData(null);
    setError(null);
    api.pulse
      .recommendActions({ unit, top: 5 })
      .then((r) => setData(r.assets))
      .catch((e) => setError(String(e)));
  }, [unit, role]);

  async function approve(asset: RecommendActionsAsset, action: RecommendedAction) {
    const key = `${asset.asset_id}:${action.kind}:${action.title}`;
    setPendingApproval(key);
    try {
      // Cannibalization is the only action with a real backend endpoint today;
      // expedite and cross-level surface their artifact and toast — production
      // wires them up to TMR/MILSTRIP submission paths.
      if (action.kind === "cannibalize" && (action.artifact as any).recipient_sr) {
        await fetch("/api/pulse/cannibalization/propose", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(action.artifact),
        });
      }
      pushToast({
        tone: "ok",
        text: `${KIND_LABEL[action.kind]} approved for ${asset.asset_id} · MC +${action.mc_delta_pct.toFixed(1)}%`,
      });
      setExecuted((prev) => {
        const n = new Set(prev);
        n.add(key);
        return n;
      });
    } catch (e) {
      pushToast({ tone: "error", text: `Approval failed: ${e}` });
    } finally {
      setPendingApproval(null);
    }
  }

  if (error) {
    return (
      <div className="rounded-md border border-[var(--color-danger-muted)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-danger)]">
        Recommendation engine: {error}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex items-center gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4 font-mono text-[11px] text-[var(--color-text-muted)]" style={{ letterSpacing: "0.1em" }}>
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--color-primary)]" />
        Computing recommended actions …
      </div>
    );
  }
  if (data.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-center font-mono text-[11px] text-[var(--color-text-muted)]" style={{ letterSpacing: "0.12em" }}>
        NO HIGH-RISK ASSETS — no recommended actions
      </div>
    );
  }

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-2.5">
        <div>
          <div
            className="font-mono text-[10px] uppercase text-[var(--color-primary)]"
            style={{ letterSpacing: "0.22em" }}
          >
            Recommended Actions · GC-1 Auto Replenishment
          </div>
          <div className="mt-0.5 spire-body-muted text-[12px]">
            Top {data.length} at-risk assets. Each action ranked by impact-per-dollar-per-day.
          </div>
        </div>
        <div
          className="font-mono text-[9px] uppercase text-[var(--color-text-muted)]"
          style={{ letterSpacing: "0.18em" }}
        >
          {unit ? `Scope: ${unit}` : "Fleet-wide"}
        </div>
      </div>
      <div className="flex flex-col gap-3 p-3">
        {data.map((asset) => (
          <AssetActionGroup
            key={asset.asset_id}
            asset={asset}
            executed={executed}
            pendingApproval={pendingApproval}
            onApprove={approve}
          />
        ))}
      </div>
    </div>
  );
}

function AssetActionGroup({
  asset,
  executed,
  pendingApproval,
  onApprove,
}: {
  asset: RecommendActionsAsset;
  executed: Set<string>;
  pendingApproval: string | null;
  onApprove: (a: RecommendActionsAsset, act: RecommendedAction) => void;
}) {
  if (asset.actions.length === 0) {
    return (
      <div className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-3 font-mono text-[11px] text-[var(--color-text-muted)]" style={{ letterSpacing: "0.04em" }}>
        {asset.asset_id} — no actions available
      </div>
    );
  }
  return (
    <div className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
      <div className="mb-2 flex items-baseline gap-2 font-mono text-[11px]" style={{ letterSpacing: "0.06em" }}>
        <span className="font-semibold text-[var(--color-text)]">{asset.asset_id}</span>
        <span className="text-[var(--color-text-muted)]">{asset.equipment_type}</span>
        <span className="text-[var(--color-text-muted)]">· {asset.unit_name}</span>
        {asset.risk_score != null && (
          <span className="ml-auto rounded-sm border border-[var(--color-danger-muted)] px-1.5 py-[1px] text-[9px] uppercase text-[var(--color-danger)]" style={{ letterSpacing: "0.18em" }}>
            Risk {asset.risk_score.toFixed(0)}
          </span>
        )}
      </div>
      {asset.primary_factor && (
        <div className="mb-2 font-mono text-[10px] text-[var(--color-text-secondary)]" style={{ letterSpacing: "0.04em" }}>
          Primary factor: {asset.primary_factor}
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        {asset.actions.map((action, i) => {
          const key = `${asset.asset_id}:${action.kind}:${action.title}`;
          const done = executed.has(key);
          const pending = pendingApproval === key;
          const color = KIND_COLOR[action.kind] ?? "var(--color-text-secondary)";
          return (
            <div
              key={i}
              className="flex items-center gap-3 rounded-sm border bg-[var(--color-surface)] px-3 py-2 transition-colors"
              style={{
                borderColor: done
                  ? "color-mix(in oklab, var(--color-success) 40%, var(--color-border))"
                  : "var(--color-border)",
                background: done
                  ? "color-mix(in oklab, var(--color-success-muted) 18%, var(--color-surface))"
                  : "var(--color-surface)",
              }}
            >
              <span
                className="rounded-sm border px-1.5 py-[1px] font-mono text-[9px] font-semibold uppercase"
                style={{
                  color,
                  borderColor: `color-mix(in oklab, ${color} 40%, var(--color-border))`,
                  background: `color-mix(in oklab, ${color} 12%, transparent)`,
                  letterSpacing: "0.18em",
                  minWidth: "8.5rem",
                  textAlign: "center",
                }}
              >
                {KIND_LABEL[action.kind]}
              </span>
              <div className="flex-1 min-w-0">
                <div className="font-mono text-[11px] font-semibold text-[var(--color-text)]" style={{ letterSpacing: "0.04em" }}>
                  {action.title}
                </div>
                <div className="truncate font-mono text-[10px] text-[var(--color-text-secondary)]" style={{ letterSpacing: "0.04em" }}>
                  {action.description}
                </div>
              </div>
              <div className="flex items-center gap-3 font-mono text-[10px] tabular-nums text-[var(--color-text-muted)]" style={{ letterSpacing: "0.04em" }}>
                <Stat label="MC%" value={`+${action.mc_delta_pct.toFixed(1)}`} tone="ok" />
                <Stat label="Cost" value={`$${action.cost_usd.toLocaleString()}`} />
                <Stat label="ETA" value={`${action.time_to_effect_hours}h`} />
                <Stat label="Conf" value={`${(action.confidence * 100).toFixed(0)}%`} />
              </div>
              <button
                onClick={() => onApprove(asset, action)}
                disabled={done || pending}
                className="rounded-sm border px-3 py-1 font-mono text-[10px] font-semibold uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                style={{
                  letterSpacing: "0.18em",
                  borderColor: done ? "var(--color-success)" : "var(--color-primary)",
                  color: done ? "var(--color-success)" : "var(--color-primary)",
                  background: done
                    ? "color-mix(in oklab, var(--color-success-muted) 30%, transparent)"
                    : "transparent",
                }}
              >
                {done ? "✓ Approved" : pending ? "…" : "Approve"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "ok" }) {
  const color = tone === "ok" ? "var(--color-success)" : "var(--color-text)";
  return (
    <div className="flex flex-col items-end leading-tight" style={{ minWidth: "3.5rem" }}>
      <span className="text-[8px] uppercase text-[var(--color-text-muted)]" style={{ letterSpacing: "0.18em" }}>
        {label}
      </span>
      <span style={{ color }}>{value}</span>
    </div>
  );
}
