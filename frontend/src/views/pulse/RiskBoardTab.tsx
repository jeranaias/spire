import { useEffect, useState } from "react";
import clsx from "clsx";
import { api, type RiskBoard, type RiskBoardAsset, type AssetDeepDive } from "../../api";
import { RiskBar } from "../../components/RiskBar";
import { LoadingOverlay } from "./FleetOverviewTab";
import { useSpireStore } from "../../state/store";

export function RiskBoardTab() {
  const role = useSpireStore((s) => s.role);
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
  if (!board) return <LoadingOverlay message="Computing risk scores across fleet ..." />;

  return (
    <div className="flex h-full">
      <div className="flex-1 overflow-y-auto p-4">
        <div className="mb-3">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">
            Risk board — top {board.assets.length} assets
          </h2>
          <div className="text-xs text-[var(--color-text-muted)]">
            Scored per spec §PULSE weights: hours, fault frequency, severity trend, days NMC, age, cost.
          </div>
        </div>
        <div className="flex flex-col gap-2">
          {board.assets.map((a) => (
            <RiskRow
              key={a.asset_id}
              asset={a}
              selected={selected === a.asset_id}
              onClick={() => setSelected(a.asset_id)}
            />
          ))}
        </div>
      </div>

      {selected && (
        <aside className="flex w-[420px] shrink-0 flex-col overflow-y-auto border-l border-[var(--color-border)] bg-[var(--color-bg)]">
          {detailLoading && <LoadingOverlay message="Loading asset history ..." />}
          {detail && <AssetDeepDivePanel detail={detail} onClose={() => setSelected(null)} />}
        </aside>
      )}
    </div>
  );
}

function RiskRow({ asset, selected, onClick }: { asset: RiskBoardAsset; selected: boolean; onClick: () => void }) {
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
          <span className="font-mono text-sm font-semibold text-[var(--color-text)]">{asset.asset_id}</span>
          <span className="text-xs text-[var(--color-text-muted)]">
            {asset.equipment_type} · {asset.unit_name} · SN {asset.serial_number}
          </span>
        </div>
        <div className="mt-2">
          <RiskBar score={asset.risk_score} band={asset.band} compact />
        </div>
        <div className="mt-1 text-xs text-[var(--color-text-secondary)]">
          Primary: {asset.primary_factor}
          {asset.predicted_failure && <span className="ml-3 text-[var(--color-warning)]">· {asset.predicted_failure}</span>}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3 text-right text-[11px] text-[var(--color-text-muted)]">
        <Stat label="Hours" value={asset.current_hours?.toFixed(0) ?? "—"} />
        <Stat label="Miles" value={asset.current_miles?.toLocaleString() ?? "—"} />
        <Stat label="Days since maint" value={asset.days_since_maintenance ?? "—"} />
      </div>
    </button>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="font-mono text-sm tabular-nums text-[var(--color-text)]">{value}</div>
      <div className="text-[9px] uppercase tracking-wider">{label}</div>
    </div>
  );
}

function AssetDeepDivePanel({ detail, onClose }: { detail: AssetDeepDive; onClose: () => void }) {
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
            <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">
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
          <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
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
          <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
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
          <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
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
          <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            Maintenance timeline ({detail.timeline.length} events)
          </h4>
          <div className="flex flex-col gap-1.5">
            {detail.timeline.slice(-8).reverse().map((t: any) => (
              <div key={t.sr_number} className="rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-[11px]">
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
          <span className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">Feedback:</span>
          <button
            onClick={() => api.pulse.feedback(a.asset_id, true)}
            className="rounded border border-[var(--color-success-muted)] px-3 py-1 text-xs text-[var(--color-success)] hover:bg-[var(--color-success-muted)]"
          >
            ✓ Correct
          </button>
          <button
            onClick={() => api.pulse.feedback(a.asset_id, false)}
            className="rounded border border-[var(--color-danger-muted)] px-3 py-1 text-xs text-[var(--color-danger)] hover:bg-[var(--color-danger-muted)]"
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
      <div className="text-[9px] uppercase tracking-wider text-[var(--color-text-muted)]">{label}</div>
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
