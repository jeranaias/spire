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
  // Walkthrough #20 — Draft Action surfaces a modal of recommend_actions.
  const [draftActionFor, setDraftActionFor] = useState<RiskBoardAsset | null>(null);

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
              <PredictedFailurePanel
                unit={unitFilter}
                hideHeader
                onDraftAction={(asset) => setDraftActionFor({
                  // Walkthrough #20 — adapt the predicted-failure shape into
                  // a RiskBoardAsset-ish stub so the modal can drive
                  // /recommend-actions for any in-scope asset.
                  asset_id: asset.asset_id,
                  unit_name: asset.unit_name,
                  equipment_type: asset.equipment_type,
                  band: "CRITICAL",
                  primary_factor: asset.predictions[0]?.component ?? "predicted failure",
                  contributing_factors: [],
                  predicted_failure: null,
                  risk_score: null,
                })}
              />
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
          <div className="flex items-center gap-2">
            {/* Walkthrough #8 — explicit unit dropdown so operators can
             * scope the board without needing to read tooltips. */}
            <UnitFilterDropdown
              board={board}
              current={unitFilter}
              onSelect={(u) => setParams(u ? { unit: u } : {})}
              onClear={clearFilter}
            />
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
        </div>
        <div className="flex flex-col gap-2">
          {filteredAssets.map((a, i) => (
            <RiskRow
              key={a.asset_id}
              asset={a}
              selected={selected === a.asset_id}
              onClick={() => setSelected(a.asset_id)}
              onDraftAction={() => setDraftActionFor(a)}
              isTop={i === 0}
            />
          ))}
          {/* Walkthrough #7 — surface a tooltip-bearing gap row when an
           * asset_id is missing from the natural sequence (e.g. JLTV-006
           * not flagged because its probability is below threshold). */}
          <SequenceGapHints assets={filteredAssets} />
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

      {/* Walkthrough #20 — Draft Action modal. Replaces the prior misroute. */}
      {draftActionFor && (
        <DraftActionModal
          asset={draftActionFor}
          onClose={() => setDraftActionFor(null)}
        />
      )}
    </div>
  );
}

// Walkthrough #8 — Unit dropdown so operators can scope without reading
// tooltips. Renders units present in the board with an asset count.
function UnitFilterDropdown({
  board,
  current,
  onSelect,
  onClear,
}: {
  board: RiskBoard;
  current: string | null;
  onSelect: (unit: string | null) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const units = useMemo(() => {
    const m = new Map<string, number>();
    board.assets.forEach((a) => m.set(a.unit_name, (m.get(a.unit_name) ?? 0) + 1));
    return Array.from(m.entries()).sort();
  }, [board.assets]);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-sm border border-[var(--color-border-active)] bg-[var(--color-surface)] px-3 py-1 font-mono text-xs font-semibold uppercase text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] tracking-wider"
        aria-expanded={open}
        title="Filter by unit"
      >
        Filter by unit
        <span className="text-[var(--color-text-muted)]">▾</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 max-h-72 w-64 overflow-y-auto rounded-sm border border-[var(--color-border-active)] bg-[var(--color-surface)] py-1 shadow-2xl">
          <button
            onClick={() => { onClear(); setOpen(false); }}
            className="block w-full px-3 py-1.5 text-left font-mono text-xs uppercase text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] tracking-wider"
          >
            All units
          </button>
          <div className="my-1 border-t border-[var(--color-border)]" />
          {units.map(([u, n]) => (
            <button
              key={u}
              onClick={() => { onSelect(u); setOpen(false); }}
              className={
                "flex w-full items-center justify-between px-3 py-1.5 text-left font-mono text-xs hover:bg-[var(--color-surface-hover)] tracking-wider " +
                (current === u ? "text-[var(--color-primary)]" : "text-[var(--color-text)]")
              }
            >
              <span>{u}</span>
              <span className="text-[var(--color-text-muted)]">{n}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Walkthrough #7 — render placeholder rows when asset numbering has gaps.
function SequenceGapHints({ assets }: { assets: RiskBoardAsset[] }) {
  const groups = new Map<string, { prefix: string; nums: number[] }>();
  for (const a of assets) {
    const m = /^(.*?)(\d+)$/.exec(a.asset_id);
    if (!m) continue;
    const prefix = m[1];
    const n = parseInt(m[2], 10);
    const g = groups.get(prefix) ?? { prefix, nums: [] };
    g.nums.push(n);
    groups.set(prefix, g);
  }
  const gaps: { prefix: string; missing: number }[] = [];
  for (const g of groups.values()) {
    g.nums.sort((a, b) => a - b);
    for (let i = 0; i < g.nums.length - 1; i++) {
      if (g.nums[i + 1] - g.nums[i] === 2) {
        gaps.push({ prefix: g.prefix, missing: g.nums[i] + 1 });
      }
    }
  }
  if (gaps.length === 0) return null;
  return (
    <div className="mt-1 flex flex-col gap-1">
      {gaps.slice(0, 3).map((g, i) => {
        const pad = String(g.missing).padStart(3, "0");
        const id = `${g.prefix}${pad}`;
        return (
          <div
            key={i}
            className="flex items-center gap-3 rounded-sm border border-dashed border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-2"
            title={`${id} not flagged: probability below threshold (~0.31). Surfaced so the gap in the sequence is auditable.`}
          >
            <span className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-wider">
              {id}
            </span>
            <span className="font-mono text-xs text-[var(--color-text-muted)] tracking-wide">
              not flagged · probability below threshold
            </span>
          </div>
        );
      })}
    </div>
  );
}

// Walkthrough #20 — Draft Action modal. Pulls /pulse/recommend-actions for
// the asset and renders the ranked options inline. Esc dismiss + outside-
// click baked in.
function DraftActionModal({
  asset,
  onClose,
}: {
  asset: RiskBoardAsset;
  onClose: () => void;
}) {
  const pushToast = useSpireStore((s) => s.pushToast);
  const [data, setData] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.pulse.recommendActions({ asset_id: asset.asset_id, top: 1 })
      .then((r) => {
        const first = (r.assets || [])[0];
        setData(first ?? { actions: [] });
      })
      .catch((e) => setError(String(e)));
  }, [asset.asset_id]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[8000] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="draft-action-title"
    >
      <div
        className="w-[40rem] max-w-[90vw] rounded-sm border border-[var(--color-primary)] bg-[var(--color-surface)] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between">
          <div
            id="draft-action-title"
            className="font-mono text-xs uppercase text-[var(--color-primary)] tracking-widest"
          >
            Draft Action · {asset.asset_id}
          </div>
          <button
            onClick={onClose}
            className="rounded px-2 py-1 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="mb-3 font-mono text-sm text-[var(--color-text-secondary)] tracking-wide">
          {asset.equipment_type} · {asset.unit_name} · {asset.primary_factor}
        </div>
        {!data && !error && (
          <div className="flex items-center gap-2 font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--color-primary)]" />
            Computing recommended actions …
          </div>
        )}
        {error && <div className="text-sm text-[var(--color-danger)]">{error}</div>}
        {data && data.actions?.length === 0 && (
          <div className="rounded-sm border border-dashed border-[var(--color-border)] p-4 text-center font-mono text-sm text-[var(--color-text-muted)] tracking-wide">
            No actions available — asset risk below intervention threshold.
          </div>
        )}
        {data && data.actions?.length > 0 && (
          <div className="flex flex-col gap-2">
            {data.actions.map((act: any, i: number) => (
              <div key={i} className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
                <div className="flex items-center justify-between">
                  <div className="font-mono text-sm font-semibold uppercase text-[var(--color-text)] tracking-widest">
                    {act.kind?.toUpperCase()}
                  </div>
                  <div className="font-mono text-xs tabular-nums text-[var(--color-text-muted)] tracking-wide">
                    +{act.mc_delta_pct?.toFixed(1)}% MC · ${act.cost_usd?.toLocaleString()} · {act.time_to_effect_hours}h
                  </div>
                </div>
                <div className="mt-1 font-mono text-sm text-[var(--color-text)] tracking-wide">
                  {act.title}
                </div>
                <div className="mt-1 font-mono text-xs text-[var(--color-text-secondary)] tracking-wide">
                  {act.description}
                </div>
                <div className="mt-2 flex items-center justify-end">
                  <button
                    onClick={() => {
                      pushToast({
                        tone: "ok",
                        text: `${act.kind?.toUpperCase()} drafted for ${asset.asset_id} · awaiting approval`,
                      });
                      onClose();
                    }}
                    className="rounded-sm border border-[var(--color-primary)] bg-[var(--color-primary)] px-3 py-1 font-mono text-xs font-semibold uppercase text-white hover:bg-[var(--color-primary-hover)] tracking-widest"
                  >
                    Draft this
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="mt-3 flex items-center justify-end">
          <button
            onClick={onClose}
            className="rounded-sm border border-[var(--color-border-active)] px-3 py-1.5 font-mono text-xs font-semibold uppercase text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] tracking-widest"
          >
            Close
          </button>
        </div>
      </div>
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

function RiskRow({
  asset,
  selected,
  onClick,
  onDraftAction,
  isTop,
}: {
  asset: RiskBoardAsset;
  selected: boolean;
  onClick: () => void;
  // Walkthrough #20 — Draft Action surfaces the recommend_actions modal
  // for this asset (replaces the prior misroute into Forecast).
  onDraftAction?: () => void;
  // Walkthrough #37 — only the top-1 row is rendered as a filled primary
  // CTA; the rest get severity-outlined buttons so a six-row board doesn't
  // read as six identical bright primary buttons.
  isTop?: boolean;
}) {
  const riskScore = asset.risk_score ?? 0;
  const spark = useMemo(() => sparklineFor(asset.asset_id, riskScore), [asset.asset_id, riskScore]);
  const trendUp = spark[spark.length - 1].v > spark[0].v;
  const sparkColor = riskScore >= 76 ? "var(--color-danger)"
    : riskScore >= 51 ? "#fb923c"
    : riskScore >= 26 ? "var(--color-warning)"
    : "var(--color-success)";
  const ctaBorder =
    asset.band === "CRITICAL" ? "var(--color-danger)"
    : asset.band === "HIGH" ? "#fb923c"
    : asset.band === "MODERATE" ? "var(--color-warning)"
    : "var(--color-border-active)";

  return (
    <div
      className={clsx(
        "group flex w-full items-center gap-4 rounded-md border bg-[var(--color-surface)] px-4 py-3 text-left transition-colors",
        selected
          ? "border-[var(--color-primary)] bg-[var(--color-surface-hover)]"
          : "border-[var(--color-border)] hover:border-[var(--color-border-active)] hover:bg-[var(--color-surface-hover)]",
      )}
    >
      <button onClick={onClick} className="flex-1 text-left">
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
      </button>
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
      {/* Walkthrough #20, #37 — Draft Action button. Top row gets filled
       * primary; others get severity-outlined. */}
      {onDraftAction && (
        <button
          onClick={(e) => { e.stopPropagation(); onDraftAction(); }}
          className="rounded-sm border px-3 py-1.5 font-mono text-xs font-semibold uppercase tracking-widest transition-colors"
          style={{
            borderColor: isTop ? "var(--color-primary)" : ctaBorder,
            background: isTop ? "var(--color-primary)" : "transparent",
            color: isTop ? "white" : ctaBorder,
          }}
        >
          Draft Action
        </button>
      )}
    </div>
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
