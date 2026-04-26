import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import clsx from "clsx";
import { LineChart, Line, ResponsiveContainer } from "recharts";
import { api, type RiskBoard, type RiskBoardAsset, type AssetDeepDive } from "../../api";
import { RiskBar } from "../../components/RiskBar";
import { LoadingOverlay } from "./FleetOverviewTab";
import { useSpireStore } from "../../state/store";
import { PredictedFailurePanel } from "../../components/PredictedFailurePanel";
import { CollapsiblePanel } from "../../components/CollapsiblePanel";

// Track-G1 — role-shaped default scope. A Maintenance Chief landing on the
// Risk Board cold should see CLB-6 only (their unit), not the whole MEF.
// Other roles default to fleet-wide. The override affordance (the Filter
// chip at top-right of the board) keeps "expand to fleet" one click away.
const ROLE_DEFAULT_UNIT: Partial<Record<string, string>> = {
  maintenance_chief: "CLB-6",
};
// Sentinel applied when the operator explicitly opts out of the role
// default — kept across renders so it doesn't snap back on re-mount.
const ALL_UNITS_SENTINEL = "__ALL__";

export function RiskBoardTab() {
  const role = useSpireStore((s) => s.role);
  const pushToast = useSpireStore((s) => s.pushToast);
  const [params, setParams] = useSearchParams();
  const explicitUnit = params.get("unit");
  const equipFilter = params.get("equipment");
  // Role default applies only when no explicit param is set. Operator
  // can always override either direction.
  const roleDefault = ROLE_DEFAULT_UNIT[role] ?? null;
  const usingRoleDefault = !explicitUnit && roleDefault != null;
  const rawUnitFilter = explicitUnit ?? roleDefault;
  const unitFilter = rawUnitFilter === ALL_UNITS_SENTINEL ? null : rawUnitFilter;
  const [board, setBoard] = useState<RiskBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<AssetDeepDive | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    setBoard(null);
    setSelected(null);
    setDetail(null);
    api.pulse.riskBoard(30).then(setBoard).catch((e) => setError(String(e)));
  }, [role]);

  const filteredAssets = useMemo(() => {
    if (!board) return [];
    return board.assets.filter((a) => {
      if (unitFilter && a.unit_name !== unitFilter) return false;
      if (equipFilter && a.equipment_type !== equipFilter) return false;
      return true;
    });
  }, [board, unitFilter, equipFilter]);

  function clearFilter() {
    // If the only filter active is the role default, swap to the show-all
    // sentinel so the Maintenance Chief can override CLB-6 → fleet without
    // the role default re-applying on the next render.
    if (usingRoleDefault && !explicitUnit) {
      setParams({ unit: ALL_UNITS_SENTINEL });
    } else {
      setParams({});
    }
  }

  useEffect(() => {
    if (!selected) return;
    setDetailLoading(true);
    setDetail(null);
    api.pulse
      .assetDeepDive(selected)
      .then(setDetail)
      .catch((e) => setError(String(e)))
      .finally(() => setDetailLoading(false));
  }, [selected]);

  if (error) return <ErrorPanel msg={error} />;
  if (!board) return <RiskBoardSkeleton />;

  return (
    <div className="flex h-full">
      <div data-pulse-risk-scroll className="flex-1 overflow-y-auto p-4">
        {/* Track-G2 — G-4 sees too many panels at once on landing. Collapse
         * Predicted Failures by default for G-4 (they have BASTION as their
         * primary surface; PULSE is a drill-down). Maintenance Chief and
         * MEF Commander see it expanded as before. */}
        <div className="mb-3">
          <CollapsiblePanel
            view="pulse.risk"
            panel="predicted"
            defaultCollapsedFor={{ g4: true }}
            header={
              <span
                className="font-mono uppercase text-[var(--color-warning)]"
                style={{ fontSize: "var(--text-xs)", letterSpacing: "var(--tracking-widest)" }}
              >
                Predicted Failures
              </span>
            }
            collapsedSummary={
              <span>
                Assets likely to fail in the configured window. Click ▾ to expand.
              </span>
            }
          >
            <div className="border-t border-[var(--color-border)]">
              <PredictedFailurePanel unit={unitFilter} hideHeader />
            </div>
          </CollapsiblePanel>
        </div>
        <div className="mb-3 flex items-end justify-between">
          <div>
            <h2
              className="font-mono text-base font-semibold uppercase text-[var(--color-text)] tracking-widest"
            >
              Risk Board · Top {filteredAssets.length}
              {filteredAssets.length !== board.assets.length && (
                <span className="ml-2 text-[var(--color-text-muted)]"> / {board.assets.length}</span>
              )}
            </h2>
            <div className="spire-body-muted mt-0.5">
              Weighted: fault frequency 30% · days NMC 25% · hours 20% · severity trend 15% · age 7% · cost 3%.
            </div>
          </div>
          {(unitFilter || equipFilter) && (
            <button
              onClick={clearFilter}
              className="flex items-center gap-1.5 rounded-sm border border-[var(--color-primary)] bg-[color-mix(in_oklab,var(--color-primary)_10%,var(--color-surface))] px-2.5 py-1 font-mono text-xs font-semibold uppercase text-[var(--color-primary)] hover:bg-[color-mix(in_oklab,var(--color-primary)_20%,var(--color-surface))] tracking-wider"
              title={usingRoleDefault ? "Default scope from your role. Click to expand to all units." : "Clear filter"}
            >
              {usingRoleDefault ? "Role scope: " : "Filter: "}
              {unitFilter ?? ""} {equipFilter ? `· ${equipFilter}` : ""} ✕
            </button>
          )}
        </div>
        <div className="flex flex-col gap-2">
          {filteredAssets.map((a) => (
            <RiskRow
              key={a.asset_id}
              asset={a}
              selected={selected === a.asset_id}
              onClick={() => setSelected(a.asset_id)}
            />
          ))}
          {filteredAssets.length === 0 && (
            <div className="rounded-sm border border-dashed border-[var(--color-border)] p-8 text-center font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
              NO ASSETS MATCH CURRENT FILTER
            </div>
          )}
        </div>
      </div>

      {selected && (
        <aside className="flex w-[420px] shrink-0 flex-col overflow-y-auto border-l border-[var(--color-border)] bg-[var(--color-bg)]">
          {detailLoading && <LoadingOverlay message="Loading asset history ..." />}
          {detail && (
            <AssetDeepDivePanel
              detail={detail}
              onClose={() => setSelected(null)}
              onFeedback={(correct) => {
                api.pulse.feedback(detail.asset.asset_id, correct).catch(() => {});
                pushToast({
                  tone: correct ? "ok" : "warn",
                  text: `Feedback recorded · ${detail.asset.asset_id} marked ${correct ? "correct" : "incorrect"}`,
                });
              }}
            />
          )}
        </aside>
      )}
    </div>
  );
}

// Deterministic sparkline data for a given asset — based on asset_id hash so
// it's stable across re-renders but varies per asset. In a production build
// this would query a real /assets/{id}/faults?window=30d endpoint; the shape
// here reads as a 30-day fault count trend.
function sparklineFor(assetId: string, riskScore: number): { v: number }[] {
  let h = 0;
  for (let i = 0; i < assetId.length; i++) h = (h * 31 + assetId.charCodeAt(i)) | 0;
  const pts: { v: number }[] = [];
  const bias = Math.min(3, riskScore / 35);
  for (let i = 0; i < 30; i++) {
    h = (h * 1103515245 + 12345) | 0;
    const rand = ((h >>> 16) & 0x7fff) / 0x7fff;
    const trend = (i / 30) * bias;
    pts.push({ v: Math.max(0, Math.round(rand * 3 + trend - 0.5)) });
  }
  return pts;
}

function RiskRow({ asset, selected, onClick }: { asset: RiskBoardAsset; selected: boolean; onClick: () => void }) {
  const riskScore = asset.risk_score ?? 0;
  const spark = useMemo(() => sparklineFor(asset.asset_id, riskScore), [asset.asset_id, riskScore]);
  const trendUp = spark[spark.length - 1].v > spark[0].v;
  const sparkColor = riskScore >= 76 ? "var(--color-danger)"
    : riskScore >= 51 ? "#fb923c"
    : riskScore >= 26 ? "var(--color-warning)"
    : "var(--color-success)";

  return (
    <button
      onClick={onClick}
      className={clsx(
        "group flex w-full items-center gap-4 rounded-md border bg-[var(--color-surface)] px-4 py-3 text-left transition-colors",
        selected
          ? "border-[var(--color-primary)] bg-[var(--color-surface-hover)]"
          : "border-[var(--color-border)] hover:border-[var(--color-border-active)] hover:bg-[var(--color-surface-hover)]",
      )}
    >
      <div className="flex-1">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-base font-semibold text-[var(--color-text)]">{asset.asset_id}</span>
          <span className="font-mono text-xs text-[var(--color-text-muted)] tracking-wide">
            {asset.equipment_type} · {asset.unit_name} · SN {asset.serial_number}
          </span>
          <span
            className="ml-auto rounded-sm border border-[var(--color-border)] px-1.5 py-[1px] font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-wider"
          >
            UNCLASSIFIED // SYNTHETIC
          </span>
        </div>
        <div className="mt-2">
          <RiskBar score={asset.risk_score} band={asset.band} compact />
        </div>
        <div className="mt-1 font-mono text-sm text-[var(--color-text-secondary)] tracking-wide">
          Primary: {asset.primary_factor}
          {asset.predicted_failure && <span className="ml-3 text-[var(--color-warning)]">· {asset.predicted_failure}</span>}
        </div>
      </div>
      <div className="flex flex-col items-center gap-0.5 self-stretch justify-center">
        <div
          className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest"
        >
          30D Faults
        </div>
        <div style={{ width: 72, height: 24 }}>
          <ResponsiveContainer>
            <LineChart data={spark}>
              <Line
                dataKey="v"
                stroke={sparkColor}
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div
          className="font-mono text-xs tabular-nums"
          style={{ color: trendUp ? sparkColor : "var(--color-text-muted)" }}
        >
          {trendUp ? "↑" : "↓"} {spark.reduce((a, b) => a + b.v, 0)} faults
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3 text-right font-mono text-xs text-[var(--color-text-muted)] tracking-wide">
        <Stat label="Hours" value={asset.current_hours?.toFixed(0) ?? "—"} />
        <Stat label="Miles" value={asset.current_miles?.toLocaleString() ?? "—"} />
        <Stat label="Days Maint" value={asset.days_since_maintenance ?? "—"} />
      </div>
    </button>
  );
}

function RiskBoardSkeleton() {
  return (
    <div className="flex h-full">
      <div className="flex-1 overflow-y-auto p-4">
        <div className="mb-3 h-6 w-64 animate-pulse rounded-sm bg-[var(--color-surface)]" />
        <div className="flex flex-col gap-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-20 animate-pulse rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]" />
          ))}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="font-mono text-sm tabular-nums text-[var(--color-text)]">{value}</div>
      <div className="text-xs uppercase tracking-wider">{label}</div>
    </div>
  );
}

function AssetDeepDivePanel({
  detail,
  onClose,
  onFeedback,
}: {
  detail: AssetDeepDive;
  onClose: () => void;
  onFeedback: (correct: boolean) => void;
}) {
  const a = detail.asset;
  const r = detail.risk;

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 border-b border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-mono text-sm font-semibold">{a.asset_id}</div>
            <div className="text-xs text-[var(--color-text-muted)]">
              {a.equipment_type} · {a.unit_name}
            </div>
            <div className="mt-1 text-sm text-[var(--color-text-muted)]">
              {a.nomenclature}
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded px-2 py-1 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
          >
            ✕
          </button>
        </div>
        <div className="mt-3">
          <RiskBar score={r.risk_score} band={r.band} />
        </div>
      </div>

      <div className="flex flex-col gap-4 p-4">
        <section>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            Contributing factors
          </h4>
          <div className="flex flex-col gap-1.5">
            {r.contributing_factors?.slice(0, 6).map((f: any) => (
              <div key={f.factor} className="flex items-center gap-3 text-xs">
                <span className="w-40 truncate text-[var(--color-text-secondary)]">{f.factor}</span>
                <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--color-bg)]">
                  <div
                    className="absolute inset-y-0 left-0 bg-[var(--color-primary)]"
                    style={{ width: `${Math.min(100, f.raw * 100)}%` }}
                  />
                </div>
                <span className="w-10 text-right font-mono tabular-nums text-[var(--color-text-muted)]">
                  {(f.raw * 100).toFixed(0)}
                </span>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            Equipment facts
          </h4>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <Fact label="Serial" value={a.serial_number} />
            <Fact label="TAMCN" value={a.tamcn} />
            <Fact label="NSN" value={a.nsn} />
            <Fact label="Fielded" value={a.fielding_date} />
            <Fact label="Current hours" value={a.current_hours} />
            <Fact label="Current miles" value={a.current_miles?.toLocaleString?.() ?? a.current_miles} />
            <Fact label="Status" value={a.current_status} />
            <Fact label="Days since maint" value={a.days_since_maintenance} />
          </div>
        </section>

        <section>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            Component faults (last 12 mo)
          </h4>
          <div className="flex flex-col gap-1">
            {Object.entries(detail.component_counts_12mo || {})
              .sort(([, a], [, b]) => b - a)
              .map(([component, count]) => (
                <div key={component} className="flex items-center gap-3 text-xs">
                  <span className="w-32 text-[var(--color-text-secondary)]">{component}</span>
                  <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--color-bg)]">
                    <div
                      className="absolute inset-y-0 left-0 bg-[var(--color-warning)]"
                      style={{ width: `${Math.min(100, (count / 5) * 100)}%` }}
                    />
                  </div>
                  <span className="w-6 text-right font-mono tabular-nums text-[var(--color-text-muted)]">{count}</span>
                </div>
              ))}
          </div>
        </section>

        <section>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            Maintenance timeline ({detail.timeline.length} events)
          </h4>
          <div className="flex flex-col gap-1.5">
            {detail.timeline.slice(-8).reverse().map((t: any) => (
              <div key={t.sr_number} className="rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[var(--color-text)]">{t.sr_number}</span>
                  <span className="text-[var(--color-text-muted)]">{t.open_date}</span>
                </div>
                <div className="mt-0.5 text-[var(--color-text-secondary)]">
                  {t.is_pmcs ? "PMCS" : `${t.condition} · ${t.fault_component}`}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="flex items-center gap-2 pt-2">
          <span
            className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest"
          >
            Feedback:
          </span>
          <button
            onClick={() => onFeedback(true)}
            className="rounded-sm border border-[var(--color-success-muted)] px-3 py-1 font-mono text-sm font-semibold uppercase text-[var(--color-success)] hover:bg-[var(--color-success-muted)] tracking-wider"
          >
            ✓ Correct
          </button>
          <button
            onClick={() => onFeedback(false)}
            className="rounded-sm border border-[var(--color-danger-muted)] px-3 py-1 font-mono text-sm font-semibold uppercase text-[var(--color-danger)] hover:bg-[var(--color-danger-muted)] tracking-wider"
          >
            ✗ Incorrect
          </button>
        </section>
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: any }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-[var(--color-text-muted)]">{label}</div>
      <div className="font-mono text-[var(--color-text)]">{String(value ?? "—")}</div>
    </div>
  );
}

function ErrorPanel({ msg }: { msg: string }) {
  return (
    <div className="flex h-full items-center justify-center p-12">
      <div className="rounded border border-[var(--color-danger-muted)] bg-[var(--color-surface)] p-6 text-sm text-[var(--color-danger)]">
        {msg}
      </div>
    </div>
  );
}
