import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import clsx from "clsx";
import { LineChart, Line, ResponsiveContainer } from "recharts";
import { api, type RiskBoard, type RiskBoardAsset, type AssetDeepDive, type PulseDraft } from "../../api";
import { formatApiError, withRetry } from "../../api-retry";
import { RiskBar } from "../../components/RiskBar";
import { LoadingOverlay, formatAsOf } from "./FleetOverviewTab";
import { useSpireStore } from "../../state/store";
import { PredictedFailurePanel } from "../../components/PredictedFailurePanel";
import { CollapsiblePanel } from "../../components/CollapsiblePanel";
import { Button, IconButton, Pressable, ErrorState, fireIdempotent } from "../../components/ui";

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
  // F6 — read DDIL cache hit so the freshness banner can fire when a
  // disconnected read served the Risk Board from last-known-good. The
  // store records the cachedAt + servedAt times whenever the api client
  // falls back to cache. We also gate on the live ddilMode so the
  // banner clears the moment comms recover (rather than persisting on
  // a previous cache-hit record from before the reconnect).
  const ddilLastCacheHit = useSpireStore((s) => s.ddilLastCacheHit);
  const ddilMode = useSpireStore((s) => s.ddilMode);
  // Subscribe to the same draft-refresh nonce TopBar's NotificationsChip
  // uses so the inline "N held" pill on each row updates the moment a
  // draft is created (modal bumps it) or dismissed (chip bumps it).
  const draftsRefreshTick = useSpireStore((s) => s.draftsRefreshTick);
  // Programmatic-open of the TopBar drafts popover. The inline "N held"
  // pill on each row uses this to jump the operator straight to the
  // drafts queue (per W1 task #143 — "click-to-jump-to-popover").
  const openDraftsPopover = useSpireStore((s) => s.openDraftsPopover);
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
  const [retrying, setRetrying] = useState(false);
  // Reload counter — bumping it re-runs the load effect so the
  // ErrorState retry button can re-enter the cold-load path without a
  // full page reload (which would also lose unsaved selections in
  // sibling tabs).
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<AssetDeepDive | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // Walkthrough #20 — Draft Action surfaces a modal of recommend_actions.
  const [draftActionFor, setDraftActionFor] = useState<RiskBoardAsset | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBoard(null);
    setError(null);
    setSelected(null);
    setDetail(null);
    setRetrying(true);
    // F6 — wrap the cold load in withRetry so a single transient 5xx /
    // SATCOM yellow doesn't dead-end the lead UC13 surface. Schedule
    // matches FleetOverviewTab / BastionView (1s/3s/5s).
    withRetry(() => api.pulse.riskBoard(30))
      .then((b) => { if (!cancelled) setBoard(b); })
      .catch((e) => { if (!cancelled) setError(formatApiError(e)); })
      .finally(() => { if (!cancelled) setRetrying(false); });
    return () => { cancelled = true; };
  }, [role, loadAttempt]);

  // F5/F6 — cached-payload-age warning. When the Risk Board GET was
  // served from the DDIL cache and the cached snapshot is older than
  // 5 minutes, surface a polite inline notice so an operator drafting
  // a TMR off this view doesn't commit airframes against assumptions
  // that have already moved. Threshold lifted to 5 min per Done line.
  // Three guards keep this honest:
  //   1. Only fires while DDIL is actively DISCONNECTED — a successful
  //      live fetch flips the mode out of DISCONNECTED and the banner
  //      clears immediately.
  //   2. The cache-hit key must match this view, so a stale chip from
  //      an unrelated endpoint never bleeds onto the Risk Board.
  //   3. A 30s tick re-evaluates the threshold so a payload that is
  //      4m59s old at first render auto-surfaces the warning at the 5m
  //      mark without the operator having to re-navigate.
  const STALE_THRESHOLD_MS = 5 * 60 * 1000;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  const cacheStaleMs = useMemo(() => {
    if (ddilMode !== "DISCONNECTED") return null;
    if (!ddilLastCacheHit) return null;
    if (!ddilLastCacheHit.key.includes("/pulse/risk-board")) return null;
    const ageMs = now - ddilLastCacheHit.cachedAt;
    return ageMs > STALE_THRESHOLD_MS ? ageMs : null;
  }, [ddilLastCacheHit, ddilMode, now]);

  // Held-drafts inline indicator. Without this, an operator who drafts an
  // action on an asset, scrolls past it, or returns the next day, gets no
  // hint on the row that there's already a held draft — and re-opens the
  // Draft Action modal, risking a duplicate. We refetch on the same nonce
  // the TopBar badge uses so create/dismiss propagate immediately.
  const [heldDrafts, setHeldDrafts] = useState<PulseDraft[]>([]);
  useEffect(() => {
    let cancelled = false;
    api.pulse
      .drafts("held")
      .then((r) => { if (!cancelled) setHeldDrafts(r.drafts); })
      // Pill is non-critical chrome — failing softly keeps the board
      // usable when /pulse/drafts is unreachable (DDIL, role w/o scope).
      // Surface the cause on the console so a silent empty-pill state
      // is still diagnosable in dev tools without UX disruption.
      .catch((e) => {
        if (cancelled) return;
        setHeldDrafts([]);
        // eslint-disable-next-line no-console
        console.warn("[risk-board] held-drafts fetch failed:", formatApiError(e));
      });
    return () => { cancelled = true; };
  }, [draftsRefreshTick, role]);
  const heldByAsset = useMemo(() => {
    const m = new Map<string, PulseDraft[]>();
    for (const d of heldDrafts) {
      const arr = m.get(d.asset_id);
      if (arr) arr.push(d);
      else m.set(d.asset_id, [d]);
    }
    return m;
  }, [heldDrafts]);

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
      .catch((e) => setError(formatApiError(e)))
      .finally(() => setDetailLoading(false));
  }, [selected]);

  if (error) {
    // F6 — chassis-consistent <ErrorState> with a real Retry button.
    // Bumping loadAttempt re-runs the cold-load path through withRetry
    // so the operator never has to refresh the whole page.
    return (
      <ErrorState
        variant="panel"
        title="Risk board unavailable"
        description="The PULSE risk-board API did not return. Network or backend may be cycling."
        detail={error}
        onRetry={() => setLoadAttempt((n) => n + 1)}
        retrying={retrying}
      />
    );
  }
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
              {/* F5 — dataset freshness stamp. Same formatAsOf helper
               * FleetOverviewTab uses, so both PULSE tabs read identical
               * "as of <date>" copy from the canonical last_snapshot
               * date instead of the operator inferring freshness from
               * wall-clock time. */}
              {board.as_of && (
                <span className="ml-3 font-mono text-[var(--color-text-muted)] tracking-wider">
                  · as of {formatAsOf(board.as_of)}
                </span>
              )}
            </h2>
            {cacheStaleMs != null && (
              <div
                role="status"
                className="mt-1 inline-flex items-center gap-2 rounded-sm border border-[var(--color-warning-muted)] bg-[color-mix(in_oklab,var(--color-warning-muted)_18%,var(--color-surface))] px-2 py-1 font-mono text-xs text-[var(--color-warning)] tracking-wider"
              >
                <span aria-hidden>▲</span>
                <span>
                  Cached {Math.floor(cacheStaleMs / 60000)} min ago — DDIL disconnected.
                  Verify before committing TMRs.
                </span>
              </div>
            )}
            <div className="spire-body-muted mt-0.5">
              Weighted: fault frequency 30% · days NMC 25% · hours 20% · severity trend 15% · age 7% · cost 3%.
              {/* W1 #30 — no cross-link to /admin/models/pulse-risk-scorer
               * is rendered here. The model supply-chain page is restricted
               * to security_manager (see VIEW_SCOPE in state/store.ts), and
               * security_manager is NOT in PULSE's scope, so any operator
               * who can see this surface cannot reach the model card. The
               * security_manager reaches the same card via
               * /admin → "Model supply chain →" instead. The reverse
               * direction (model card → in-app surface list) IS rendered
               * inside ModelDetailView. */}
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
              <Button
                onClick={clearFilter}
                variant="primary"
                size="sm"
                title={usingRoleDefault ? "Default scope from your role. Click to expand to all units." : "Clear filter"}
              >
                {usingRoleDefault ? "Role scope: " : "Filter: "}
                {unitFilter ?? ""} {equipFilter ? `· ${equipFilter}` : ""} ✕
              </Button>
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
              onJumpToDrafts={openDraftsPopover}
              isTop={i === 0}
              heldDrafts={heldByAsset.get(a.asset_id) ?? []}
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
                // Idempotent per (asset, verdict) so a triple-tap on the
                // thumbs row never double-records.
                fireIdempotent(
                  `pulse:feedback:${detail.asset.asset_id}:${correct ? "correct" : "incorrect"}`,
                  () => api.pulse.feedback(detail.asset.asset_id, correct),
                  500,
                ).catch(() => {});
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
          heldDrafts={heldByAsset.get(draftActionFor.asset_id) ?? []}
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
      <Button
        onClick={() => setOpen((v) => !v)}
        variant="secondary"
        size="sm"
        aria-expanded={open}
        title="Filter by unit"
        trailingIcon={<span className="text-[var(--color-text-muted)]">▾</span>}
      >
        Filter by unit
      </Button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 max-h-72 w-64 overflow-y-auto rounded-sm border border-[var(--color-border-active)] bg-[var(--color-surface)] py-1 shadow-2xl">
          <Pressable
            onClick={() => { onClear(); setOpen(false); }}
            className="px-3 py-1.5 font-mono text-xs uppercase text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] tracking-wider"
          >
            All units
          </Pressable>
          <div className="my-1 border-t border-[var(--color-border)]" />
          {units.map(([u, n]) => (
            <Pressable
              key={u}
              onClick={() => { onSelect(u); setOpen(false); }}
              className={
                "flex items-center justify-between px-3 py-1.5 font-mono text-xs hover:bg-[var(--color-surface-hover)] tracking-wider " +
                (current === u ? "text-[var(--color-primary)]" : "text-[var(--color-text)]")
              }
            >
              <span>{u}</span>
              <span className="text-[var(--color-text-muted)]">{n}</span>
            </Pressable>
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
            title={`${id} not flagged: risk score below the moderate band cutoff (26). Surfaced so the gap in the sequence is auditable.`}
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
  heldDrafts,
  onClose,
}: {
  asset: RiskBoardAsset;
  // Drafts already held against this asset. The modal uses this to
  // disable any recommended action whose KIND is already drafted —
  // closes the duplicate-draft loop the inline pill opens.
  heldDrafts: PulseDraft[];
  onClose: () => void;
}) {
  const pushToast = useSpireStore((s) => s.pushToast);
  const bumpDrafts = useSpireStore((s) => s.bumpDraftsRefresh);
  const [data, setData] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draftingKey, setDraftingKey] = useState<string | null>(null);
  const [draftedKeys, setDraftedKeys] = useState<Set<string>>(new Set());
  // Lowercased KINDs already held server-side for this asset. Compared
  // case-insensitively because /pulse/recommend-actions emits kinds in
  // mixed case while persisted PulseDraft.kind echoes whatever the
  // POST body sent in.
  const heldKinds = useMemo(
    () => new Set(heldDrafts.map((d) => (d.kind || "").toLowerCase())),
    [heldDrafts],
  );

  useEffect(() => {
    api.pulse.recommendActions({ asset_id: asset.asset_id, top: 1 })
      .then((r) => {
        const first = (r.assets || [])[0];
        setData(first ?? { actions: [] });
      })
      .catch((e) => setError(formatApiError(e)));
  }, [asset.asset_id]);

  async function draftAction(act: any, key: string) {
    if (draftingKey || draftedKeys.has(key)) return;
    setDraftingKey(key);
    try {
      const r = await api.pulse.draftAction({
        asset_id: asset.asset_id,
        kind: act.kind,
        title: act.title,
        unit_name: asset.unit_name,
        description: act.description,
        cost_usd: act.cost_usd ?? null,
        mc_delta_pct: act.mc_delta_pct ?? null,
        time_to_effect_hours: act.time_to_effect_hours ?? null,
        artifact: (act.artifact as Record<string, unknown>) ?? null,
      });
      setDraftedKeys((prev) => {
        const n = new Set(prev);
        n.add(key);
        return n;
      });
      bumpDrafts();
      pushToast({
        tone: "ok",
        // Held drafts now route to a real approver gate: the originator
        // queues, an approver-role operator (Maintenance Chief / G-4 /
        // MEF Commander, but never the originator) approves or rejects
        // from the Notifications popover. Approving a CANNIBALIZE draft
        // also drives the cross-level propose path so the audit chain
        // shows draft → approve → cannibalization_propose.
        text: `${(act.kind || "").toUpperCase()} drafted for ${asset.asset_id} · awaiting approver review (${r.draft.draft_id})`,
        ttlMs: 5000,
      });
    } catch (e) {
      pushToast({ tone: "error", text: `Draft failed: ${formatApiError(e)}` });
    } finally {
      setDraftingKey(null);
    }
  }

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
          <IconButton onClick={onClose} aria-label="Close" variant="ghost" size="sm">
            <span aria-hidden>✕</span>
          </IconButton>
        </div>
        {/* QA #54 — surface the risk score directly in the modal header so
         * the operator can see it matches the originating Risk Board row.
         * Prefer the originating row's risk_score (passed in via the asset
         * stub) so the value renders the moment the modal opens; fall back
         * to data.risk_score from /recommend-actions once it loads (this
         * covers the PredictedFailurePanel entry point where the asset
         * stub had risk_score=null). The "0" fallback the QA-Explorer hit
         * was the action description text — the backend now populates
         * that consistently — but rendering the canonical score here makes
         * any future regression visually obvious instead of buried in
         * description prose. */}
        <div className="mb-3 flex items-center gap-3 font-mono text-sm text-[var(--color-text-secondary)] tracking-wide">
          <span data-test="draft-modal-risk-score">
            Risk score{" "}
            <span className="text-[var(--color-text)] tabular-nums">
              {(() => {
                const rs = asset.risk_score ?? data?.risk_score ?? null;
                return rs == null ? "—" : Math.round(rs);
              })()}
            </span>
          </span>
          <span aria-hidden className="text-[var(--color-text-muted)]">·</span>
          <span>
            {asset.equipment_type.replace(/_/g, " ")} · {asset.unit_name} · {asset.primary_factor}
          </span>
        </div>
        {heldDrafts.length > 0 && (
          <div
            role="status"
            className="mb-3 rounded-sm border border-[var(--color-primary)] bg-[color-mix(in_oklab,var(--color-primary)_12%,var(--color-surface))] px-2 py-1.5 font-mono text-xs text-[var(--color-primary)] tracking-wider"
          >
            {heldDrafts.length} held draft{heldDrafts.length === 1 ? "" : "s"} on this asset
            {": "}
            {heldDrafts.map((d) => (d.kind || "").toUpperCase()).join(" · ")}
            {" — review via the Drafts badge in the top bar."}
          </div>
        )}
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
            {data.actions.map((act: any, i: number) => {
              const key = `${act.kind}:${act.title}:${i}`;
              const drafted = draftedKeys.has(key);
              const drafting = draftingKey === key;
              // Already held server-side from a prior session — block the
              // re-draft so we never write a duplicate held row against
              // the same (asset, kind) tuple.
              const alreadyHeld = !drafted && heldKinds.has((act.kind || "").toLowerCase());
              const lockOut = drafted || alreadyHeld;
              const label = drafted
                ? "✓ Held in Drafts"
                : alreadyHeld
                  ? "Already held"
                  : "Draft this";
              const tooltip = drafted
                ? "Draft persisted — open the Drafts badge in the top bar"
                : alreadyHeld
                  ? "A draft of this kind is already held for this asset · review via the Drafts badge before drafting another"
                  : "Persist this draft to the audit chain (no auto-approval)";
              return (
                <div key={i} className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
                  <div className="flex items-center justify-between">
                    <div className="font-mono text-sm font-semibold uppercase text-[var(--color-text)] tracking-widest">
                      {act.kind?.toUpperCase()}
                    </div>
                    <div className="font-mono text-xs tabular-nums text-[var(--color-text-muted)] tracking-wide">
                      {/* mc_delta_pct is 0..1; render as percentage points. */}
                      +{((act.mc_delta_pct ?? 0) * 100).toFixed(0)}% MC · ${act.cost_usd?.toLocaleString("en-US")} · {act.time_to_effect_hours}h
                    </div>
                  </div>
                  <div className="mt-1 font-mono text-sm text-[var(--color-text)] tracking-wide">
                    {act.title}
                  </div>
                  <div className="mt-1 font-mono text-xs text-[var(--color-text-secondary)] tracking-wide">
                    {act.description}
                  </div>
                  <div className="mt-2 flex items-center justify-end">
                    <Button
                      onClick={() => draftAction(act, key)}
                      disabled={lockOut || drafting || !!draftingKey}
                      pending={drafting}
                      variant={lockOut ? "secondary" : "primary"}
                      size="sm"
                      title={tooltip}
                    >
                      {label}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {/* Drafts now flow through a real approver gate. The originator
         * queues here; an approver-role operator (Maintenance Chief / G-4
         * / MEF Commander, never the originator) clears it via the
         * Notifications popover up top. CANNIBALIZE approvals also drive
         * the cross-level propose endpoint, so a single approval click
         * leaves draft → approve → cannibalization_propose on chain. */}
        <div className="mt-3 font-mono text-[10px] uppercase text-[var(--color-text-muted)] tracking-widest">
          Drafts are held with an audit row · approver clears it via the Notifications popover (top bar).
          Originator can also withdraw via Dismiss.
        </div>
        <div className="mt-3 flex items-center justify-end">
          <Button onClick={onClose} variant="secondary" size="sm">
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}

// Walkthrough audit: prior version synthesized the sparkline from a hash of
// asset_id. Real 30-day fault buckets ship on the risk-board response now;
// this helper just maps them into the shape Recharts wants. If the backend
// hasn't backfilled buckets yet, fall back to a flat zero series so the
// chart still renders without leaking a fake trend.
function sparklineFor(buckets: number[] | undefined): { v: number }[] {
  const src = buckets && buckets.length === 30 ? buckets : new Array(30).fill(0);
  return src.map((v) => ({ v }));
}

function RiskRow({
  asset,
  selected,
  onClick,
  onDraftAction,
  onJumpToDrafts,
  isTop,
  heldDrafts,
}: {
  asset: RiskBoardAsset;
  selected: boolean;
  onClick: () => void;
  // Walkthrough #20 — Draft Action surfaces the recommend_actions modal
  // for this asset (replaces the prior misroute into Forecast).
  onDraftAction?: () => void;
  // Click handler for the inline "N held" pill — opens the TopBar
  // drafts popover so the operator lands on the actual queue item
  // (not just a fresh modal).
  onJumpToDrafts?: () => void;
  // Walkthrough #37 — only the top-1 row is rendered as a filled primary
  // CTA; the rest get severity-outlined buttons so a six-row board doesn't
  // read as six identical bright primary buttons.
  isTop?: boolean;
  // Held drafts persisted against this asset_id. Drives the inline
  // "N held" pill so an operator scrolling past the row tomorrow knows
  // a draft is already in the queue and won't re-open the modal blind.
  heldDrafts?: PulseDraft[];
}) {
  const riskScore = asset.risk_score ?? 0;
  const spark = useMemo(() => sparklineFor(asset.fault_buckets_30d), [asset.fault_buckets_30d]);
  const totalFaults = asset.fault_count_30d ?? spark.reduce((a, b) => a + b.v, 0);
  // Compare last-7d vs prior-23d daily averages so a trend reads from the
  // most recent week, not an arbitrary first-vs-last comparison.
  const last7 = spark.slice(-7).reduce((a, b) => a + b.v, 0) / 7;
  const prior23 = spark.slice(0, 23).reduce((a, b) => a + b.v, 0) / 23;
  const trendUp = last7 > prior23;
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
      <Pressable onClick={onClick} className="flex-1">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-base font-semibold text-[var(--color-text)]">{asset.asset_id}</span>
          <span className="font-mono text-xs text-[var(--color-text-muted)] tracking-wide">
            {asset.equipment_type.replace(/_/g, " ")} · {asset.unit_name} · SN {asset.serial_number}
          </span>
          {/* Held-drafts pill. Only renders when there's at least one
            * held draft against this asset_id. Click jumps the operator
            * to the TopBar drafts popover (matches the task's "click-to-
            * jump-to-popover" wording — they get the actual queue item
            * with dismiss + audit context, not a fresh recommend-actions
            * modal). Rendered as a span with role="button" because the
            * parent row is itself a <button> via Pressable (nested
            * <button>s are invalid HTML). Keydown keeps it operable
            * from the keyboard. */}
          {heldDrafts && heldDrafts.length > 0 && onJumpToDrafts && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); onJumpToDrafts(); }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  onJumpToDrafts();
                }
              }}
              className="ml-auto cursor-pointer rounded-sm border border-[var(--color-primary)] bg-[color-mix(in_oklab,var(--color-primary)_14%,transparent)] px-1.5 py-[1px] font-mono text-xs uppercase text-[var(--color-primary)] tracking-wider hover:bg-[color-mix(in_oklab,var(--color-primary)_24%,transparent)]"
              title={`${heldDrafts.length} draft${heldDrafts.length === 1 ? "" : "s"} held: ${heldDrafts.map((d) => (d.kind || "").toUpperCase()).join(", ")} · click to open the Drafts queue`}
              aria-label={`${heldDrafts.length} held draft${heldDrafts.length === 1 ? "" : "s"} on ${asset.asset_id} — open Drafts queue`}
            >
              {heldDrafts.length} held
            </span>
          )}
          <span
            className={clsx(
              "rounded-sm border border-[var(--color-border)] px-1.5 py-[1px] font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-wider",
              heldDrafts && heldDrafts.length > 0 ? "" : "ml-auto",
            )}
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
      </Pressable>
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
          style={{ color: totalFaults > 0 ? (trendUp ? sparkColor : "var(--color-text-muted)") : "var(--color-text-muted)" }}
        >
          {totalFaults === 0 ? "—" : `${trendUp ? "↑" : "↓"} ${totalFaults} faults`}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3 text-right font-mono text-xs text-[var(--color-text-muted)] tracking-wide">
        <Stat label="Hours" value={asset.current_hours?.toFixed(0) ?? "—"} />
        <Stat label="Miles" value={asset.current_miles?.toLocaleString("en-US") ?? "—"} />
        <Stat label="Days Maint" value={asset.days_since_maintenance ?? "—"} />
      </div>
      {/* Walkthrough #20, #37 — Draft Action button. Top row gets filled
       * primary; others get severity-outlined. */}
      {onDraftAction && (
        <Button
          onClick={(e) => { e.stopPropagation(); onDraftAction(); }}
          variant={isTop ? "primary" : "secondary"}
          size="sm"
          style={isTop ? undefined : { borderColor: ctaBorder, color: ctaBorder }}
        >
          Draft Action
        </Button>
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
              {a.equipment_type.replace(/_/g, " ")} · {a.unit_name}
            </div>
            <div className="mt-1 text-sm text-[var(--color-text-muted)]">
              {a.nomenclature}
            </div>
          </div>
          <IconButton onClick={onClose} aria-label="Close panel" variant="ghost" size="sm">
            <span aria-hidden>✕</span>
          </IconButton>
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
          <Button
            onClick={() => onFeedback(true)}
            variant="secondary"
            size="sm"
            className="border-[var(--color-success-muted)] text-[var(--color-success)] hover:bg-[var(--color-success-muted)]"
          >
            ✓ Correct
          </Button>
          <Button
            onClick={() => onFeedback(false)}
            variant="secondary"
            size="sm"
            className="border-[var(--color-danger-muted)] text-[var(--color-danger)] hover:bg-[var(--color-danger-muted)]"
          >
            ✗ Incorrect
          </Button>
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

