import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, csrfHeaders, type Cannibalization, type StrippableDonor } from "../../api";
import { formatApiError } from "../../api-retry";
import { LoadingOverlay } from "./FleetOverviewTab";
import { useSpireStore } from "../../state/store";
import { Button, ErrorState, Pressable, fireIdempotent } from "../../components/ui";

type NeedRow = {
  sr_number: string;
  asset_id: string;
  unit: string;
  equipment_type: string;
  days_open: number;
  fault_component: string;
  // Walkthrough #9 — normalized fault class for cause-of-fault overlap.
  fault_class?: string;
  unit_mc_rate?: number;
  unit_mc_count?: number;
  unit_total?: number;
  needed_part: { nsn: string; nomenclature: string; unit_cost: number };
};

type MatchRow = {
  event_id: string;
  event_date: string;
  scope?: "self" | "cross_unit";
  recipient: { asset_id: string; unit: string };
  donor: { asset_id: string; unit: string };
  nsn: string;
  nomenclature: string;
  impact: string;
  // Task #41 — server-side commit status. `committed` means the propose POST
  // returned 2xx and the audit chain has the row. `pending_retry` means the
  // optimistic row is on screen but the backend rejected (or never saw) it,
  // so the operator must retry. Untagged = legacy / engine-verified rows.
  commit_status?: "committed" | "pending_retry";
  retry_reason?: string;
  // Walkthrough #42 — surface full work-order metadata.
  work_order?: {
    wo_number: string;
    approved_by: string;
    removed_by: string;
    installed_by: string;
    disposition: string;
  };
  // Task-42 — local-row lifecycle. `committed` = optimistic write that
  // succeeded live (or no DDIL routing was triggered). `queued` =
  // DDIL DISCONNECTED routed it to the local replay queue; once the
  // queue drains the badge flips to "Replayed". `localId` correlates
  // a queued row with its DdilQueuedWrite entry so we can detect the
  // drain reactively.
  localStatus?: "committed" | "queued";
  localId?: string;
};

// Task #40 -- DonorRow is a strippable asset record (not another open need).
// A donor is a hull where the part is installed and serviceable, sourced
// from the backend's strippable_donors surface.
type DonorRow = StrippableDonor;

type SortMode = "days_open" | "impact" | "unit";

// Task #41 — single source of truth for "did the propose POST land in the
// audit chain?". Returns a discriminated union so callers don't have to
// each re-implement the resp.ok / 401 / network-error branching that the
// previous swallow-everything implementation got wrong.
type ProposeOutcome =
  | { outcome: "committed" }
  | { outcome: "unauthorized" }
  | { outcome: "rejected"; reason: string };

async function postProposeAndClassify(body: {
  recipient_sr: string;
  donor_sr?: string;
  donor_asset_id?: string;
  nsn: string;
}): Promise<ProposeOutcome> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), 15_000);
  let resp: Response;
  try {
    resp = await fetch("/api/pulse/cannibalization/propose", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...csrfHeaders() },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    window.clearTimeout(timer);
    const msg = err instanceof Error && err.name === "AbortError"
      ? "Backend timed out (15s)."
      : "Network unreachable.";
    return { outcome: "rejected", reason: msg };
  }
  window.clearTimeout(timer);
  if (resp.status === 401) return { outcome: "unauthorized" };
  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const b = await resp.json();
      const d = b?.detail;
      if (typeof d === "string") detail = d;
      else if (d && typeof d === "object" && typeof d.error === "string") {
        detail = `${d.error} (${resp.status})`;
      }
    } catch { /* tolerant */ }
    return { outcome: "rejected", reason: detail };
  }
  return { outcome: "committed" };
}

export function CannibalizationTab() {
  const role = useSpireStore((s) => s.role);
  const pushToast = useSpireStore((s) => s.pushToast);
  // Task-42 — subscribe to the DDIL queue so we can flip a queued
  // local match's badge from "Queued" → "Replayed" the moment the
  // CommsControl drain removes its id from the store.
  const ddilQueue = useSpireStore((s) => s.ddilQueue);
  const queuedIds = useMemo(() => new Set(ddilQueue.map((q) => q.id)), [ddilQueue]);
  // Task #41 — security_manager is read-only on this surface; they review
  // the audit chain after the fact, they don't add to it.
  const canPropose = role !== "security_manager";
  const [data, setData] = useState<Cannibalization | null>(null);
  // Task-42 — distinguish "200 with empty list" from "5xx / network
  // failure / DDIL no-cache". Prior code .catch'd silently and left
  // the LoadingOverlay spinning forever with no retry path.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedNeed, setSelectedNeed] = useState<NeedRow | null>(null);
  const [proposedLocal, setProposedLocal] = useState<MatchRow[]>([]);
  const [confirmDonor, setConfirmDonor] = useState<{ need: NeedRow; donor: DonorRow } | null>(null);
  const [committing, setCommitting] = useState(false);
  // Task #41 — auto-propose now POSTs each draft to the backend after a
  // single confirm-all dialog. This holds the staged drafts between the
  // dialog opening and the operator pressing Submit.
  const [autoConfirm, setAutoConfirm] = useState<
    | { drafts: { need: NeedRow; donor: DonorRow }[] }
    | null
  >(null);
  const [autoSubmitting, setAutoSubmitting] = useState(false);
  // Walkthrough #43 — filter chips
  const [unitFilter, setUnitFilter] = useState<string | null>(null);
  const [partClassFilter, setPartClassFilter] = useState<string | null>(null);
  // Walkthrough #44 — sort control
  const [sortMode, setSortMode] = useState<SortMode>("days_open");
  // Walkthrough #45 — same-fault-class only mode
  const [crossUnitOnly, setSameClassOnly] = useState(false);

  const loadCannibalization = useCallback(() => {
    setLoadError(null);
    api.pulse.cannibalization()
      .then((payload) => setData(payload))
      .catch((err) => {
        // Task-42 — surface the failure instead of swallowing it.
        // ApiError preserves DDIL discriminators ({ ddil: "disconnected" })
        // so we can render a tailored message rather than a raw 500.
        const ddilTag = err instanceof ApiError ? (err.body as any)?.ddil : null;
        if (ddilTag === "disconnected") {
          setLoadError("Comms denied (DDIL DISCONNECTED) and no cached snapshot is available for this view.");
        } else {
          setLoadError(formatApiError(err));
        }
      });
  }, []);

  useEffect(() => {
    setData(null);
    setLoadError(null);
    setSelectedNeed(null);
    setProposedLocal([]);
    loadCannibalization();
  }, [role, loadCannibalization]);

  // Task #40 -- Strippable donor pool from the backend. The previous
  // derivation built donors from OTHER OPEN NMCS NEEDS sharing the same
  // backordered NSN -- every "donor" was itself a deadlined asset waiting
  // for that exact part. The backend now surfaces real strippable hulls
  // (long-term-NMC for an unrelated cause, PMC, or MC at a high-readiness
  // unit) where the part is installed and serviceable, with a strip_reason
  // string for the operator. The "different fault class" predicate is
  // already enforced server-side; the cross-unit-only chip below applies
  // here as a UI filter.
  const donors = useMemo<DonorRow[]>(() => {
    if (!data || !selectedNeed) return [];
    const pool = data.strippable_donors?.[selectedNeed.sr_number] ?? [];
    return crossUnitOnly
      ? pool.filter((d) => d.unit !== selectedNeed.unit)
      : pool;
  }, [data, selectedNeed, crossUnitOnly]);

  // Task-42 — render an actionable error state instead of an infinite
  // spinner when the cold-load 5xx'd or comms are denied.
  if (loadError) {
    return (
      <ErrorState
        title="Cannibalization data unavailable"
        description="The Pulse cannibalization feed did not return. Backend may be cycling or comms are denied."
        detail={loadError}
        onRetry={loadCannibalization}
        retryLabel="Retry"
      />
    );
  }
  if (!data) return <LoadingOverlay message="Matching needs with donors …" />;

  const allNeeds = data.open_needs as NeedRow[];
  const matches = [...proposedLocal, ...(data.completed_matches as MatchRow[])];

  const partClasses = Array.from(new Set(allNeeds.map((n) => n.needed_part.nomenclature.split(",")[0].split(" ").slice(0, 2).join(" ")))).sort();
  const unitsList = Array.from(new Set(allNeeds.map((n) => n.unit))).sort();

  // Walkthrough #43, #44 — filter then sort.
  const filteredNeeds = allNeeds.filter((n) => {
    if (unitFilter && n.unit !== unitFilter) return false;
    if (partClassFilter && !n.needed_part.nomenclature.startsWith(partClassFilter)) return false;
    return true;
  });
  const needs = [...filteredNeeds].sort((a, b) => {
    if (sortMode === "days_open") return b.days_open - a.days_open;
    if (sortMode === "unit") return a.unit.localeCompare(b.unit);
    // impact — donor-impact heuristic: prioritize lowest unit_mc_rate as
    // most-impactful (recipient unit closest to collapse).
    return (a.unit_mc_rate ?? 1) - (b.unit_mc_rate ?? 1);
  });

  function commit() {
    if (!confirmDonor) return;
    const key = `cannib-commit:${confirmDonor.need.sr_number}:${confirmDonor.donor.asset_id}`;
    fireIdempotent(key, () => commitInner());
  }

  async function commitInner() {
    if (!confirmDonor) return;
    setCommitting(true);
    const need = confirmDonor.need;
    const donor = confirmDonor.donor;
    const isSelf = need.unit === donor.unit;
    const optimisticId = `CAN-LOCAL-${Date.now()}`;
    const optimistic: MatchRow = {
      event_id: optimisticId,
      event_date: new Date().toISOString().slice(0, 10),
      scope: isSelf ? "self" : "cross_unit",
      recipient: { asset_id: need.asset_id, unit: need.unit },
      donor: { asset_id: donor.asset_id, unit: donor.unit },
      nsn: need.needed_part.nsn,
      nomenclature: need.needed_part.nomenclature,
      impact: `Proposed by operator · recipient ${need.unit} gains ${need.needed_part.nomenclature} from ${donor.unit}.`,
      localStatus: "committed",
    };
    setProposedLocal((prev) => [optimistic, ...prev]);
    // Task-42 — route through the DDIL-aware client. The interceptor
    // applies LIMITED latency, INTERMITTENT drops, and DISCONNECTED
    // queue-for-replay automatically; we branch on the structured
    // ApiError it raises so the optimistic row's badge + the toast
    // copy match the actual transport outcome (rather than always
    // saying "Match proposed" the way the raw fetch did).
    //
    // Task #41 — for non-DDIL backend rejections (4xx validation, 401
    // expired, 5xx audit-write failure) we mark the optimistic row
    // pending_retry instead of dropping it, so the operator never
    // walks away believing a row landed in the audit chain when it
    // didn't.
    //
    // We still keep a 15s client-side timeout: even the interceptor
    // won't save us from a Fly cold-start sitting on the wire.
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), 15_000);
    try {
      // Task #40 — donors are strippable hulls (asset-keyed); they may be
      // MC and have no SR, so the backend accepts donor_asset_id as the
      // canonical donor reference. Pass donor_sr too when available.
      await api.pulse.cannibalizationPropose(
        {
          recipient_sr: need.sr_number,
          donor_sr: (donor as any).sr_number,
          donor_asset_id: donor.asset_id,
          nsn: need.needed_part.nsn,
        },
        { signal: ctrl.signal },
      );
      pushToast({
        tone: "ok",
        text: `Match proposed · ${need.asset_id} ← ${donor.asset_id}`,
      });
      markRowCommitted(optimisticId);
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : null;
      const ddilTag = apiErr ? ((apiErr.body as any)?.ddil ?? null) : null;
      const status = apiErr ? apiErr.status : 0;
      if (ddilTag === "queued") {
        // DDIL DISCONNECTED — interceptor pushed the write into the
        // local replay queue. Keep the optimistic row, tag it so the
        // Completed Matches badge reads "Queued · DDIL" until the
        // queue drains on reconnect, then auto-flips to "Replayed".
        const ddilLocalId = apiErr ? ((apiErr.body as any)?.local_id as string | undefined) : undefined;
        setProposedLocal((prev) =>
          prev.map((r) =>
            r.event_id === optimisticId
              ? { ...r, localStatus: "queued", localId: ddilLocalId }
              : r,
          ),
        );
        pushToast({
          tone: "warn",
          text: `Comms denied — proposal queued for replay${ddilLocalId ? ` (${ddilLocalId})` : ""}.`,
          ttlMs: 5000,
        });
      } else if (ddilTag === "intermittent") {
        // INTERMITTENT — wire dropped the request. Pull the optimistic
        // row so the Completed Matches list doesn't carry a phantom
        // success; the operator re-issues the proposal to retry, which
        // is the demo beat the DDIL spec asks for.
        setProposedLocal((prev) => prev.filter((r) => r.event_id !== optimisticId));
        pushToast({
          tone: "warn",
          text: "Comms intermittent — packet dropped on the wire. Re-issue the proposal.",
          ttlMs: 5000,
        });
      } else if (status === 401) {
        // Task #41 — session expired mid-commit. Mark the row
        // pending_retry so it stays on screen for context, then
        // bounce out to /auth via the store's signOut bridge.
        markRowPendingRetry(optimisticId, "Session expired before commit landed.");
        pushToast({
          tone: "warn",
          text: "Session expired · sign in again to recommit the proposal.",
        });
        useSpireStore.getState().signOut();
      } else {
        // Real backend rejection (4xx validation, 5xx audit failure)
        // or transport/abort. Task #41 invariant: keep the row visible
        // and yellow so the operator can't mistake a failed write for
        // an audit-chain entry; surface the underlying detail in the
        // row's badge AND in a warn toast.
        const reason = formatApiError(err);
        markRowPendingRetry(optimisticId, reason);
        pushToast({
          tone: "warn",
          text: `Commit pending retry · ${reason}`,
          ttlMs: 5500,
        });
      }
    } finally {
      window.clearTimeout(timer);
      setConfirmDonor(null);
      setSelectedNeed(null);
      setCommitting(false);
    }
  }

  function markRowPendingRetry(localId: string, reason: string) {
    setProposedLocal((prev) =>
      prev.map((m) =>
        m.event_id === localId
          ? { ...m, commit_status: "pending_retry", retry_reason: reason }
          : m,
      ),
    );
  }
  function markRowCommitted(localId: string) {
    setProposedLocal((prev) =>
      prev.map((m) =>
        m.event_id === localId ? { ...m, commit_status: "committed" } : m,
      ),
    );
  }

  // Walkthrough #45 / Task #40 / Task #41 -- bulk auto-propose top match per need.
  // This used to silently fabricate frontend-only rows that the toast called
  // "queued" while actually never POSTing anything. Now it builds a draft list,
  // opens a single confirm-all dialog showing the count, and on confirm POSTs
  // each one individually so every row that shows up in the matches column
  // corresponds to an audit-chain entry (or a clearly flagged pending_retry).
  // Sources from the backend's strippable_donors pool so we never auto-propose
  // another deadlined hull as a "donor".
  function autoProposeTopMatches() {
    if (!data) return;
    const drafts: { need: NeedRow; donor: DonorRow }[] = [];
    for (const need of filteredNeeds) {
      const pool = data.strippable_donors?.[need.sr_number] ?? [];
      const candidates = pool.filter((d) => !crossUnitOnly || d.unit !== need.unit);
      if (candidates.length === 0) continue;
      // Pool is already priority-sorted by the backend (long-term-NMC,
      // then PMC, then MC at high-MC unit). Prefer cross-unit ties so
      // intra-unit moves don't shadow easier cross-level transfers.
      const sorted = [...candidates].sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        const aCross = a.unit !== need.unit ? 1 : 0;
        const bCross = b.unit !== need.unit ? 1 : 0;
        if (aCross !== bCross) return bCross - aCross;
        return (b.unit_mc_rate ?? 0) - (a.unit_mc_rate ?? 0);
      });
      drafts.push({ need, donor: sorted[0] });
    }
    if (drafts.length === 0) {
      pushToast({ tone: "warn", text: "No auto-match candidates available." });
      return;
    }
    setAutoConfirm({ drafts });
  }

  async function submitAutoDrafts() {
    if (!autoConfirm) return;
    setAutoSubmitting(true);
    try {
      const startedAt = Date.now();
      let committed = 0;
      let pending = 0;
      let unauthorized = false;
      const newRows: MatchRow[] = [];
      for (let i = 0; i < autoConfirm.drafts.length; i++) {
        const { need, donor } = autoConfirm.drafts[i];
        const isSelf = need.unit === donor.unit;
        const localId = `CAN-LOCAL-${startedAt}-${i}`;
        const result = await postProposeAndClassify({
          recipient_sr: need.sr_number,
          donor_sr: (donor as any).sr_number,
          donor_asset_id: (donor as any).asset_id,
          nsn: need.needed_part.nsn,
        });
        const baseRow: MatchRow = {
          event_id: localId,
          event_date: new Date().toISOString().slice(0, 10),
          scope: isSelf ? "self" : "cross_unit",
          recipient: { asset_id: need.asset_id, unit: need.unit },
          donor: { asset_id: donor.asset_id, unit: donor.unit },
          nsn: need.needed_part.nsn,
          nomenclature: need.needed_part.nomenclature,
          impact: `Auto-proposed top match · ${need.asset_id} ← ${donor.asset_id}.`,
        };
        if (result.outcome === "committed") {
          newRows.push({ ...baseRow, commit_status: "committed" });
          committed++;
        } else if (result.outcome === "unauthorized") {
          newRows.push({
            ...baseRow,
            commit_status: "pending_retry",
            retry_reason: "Session expired mid-batch.",
          });
          pending++;
          unauthorized = true;
          // Stop iterating: subsequent calls would also 401.
          for (let j = i + 1; j < autoConfirm.drafts.length; j++) {
            const skipped = autoConfirm.drafts[j];
            newRows.push({
              event_id: `CAN-LOCAL-${startedAt}-${j}`,
              event_date: new Date().toISOString().slice(0, 10),
              scope: skipped.need.unit === skipped.donor.unit ? "self" : "cross_unit",
              recipient: { asset_id: skipped.need.asset_id, unit: skipped.need.unit },
              donor: { asset_id: skipped.donor.asset_id, unit: skipped.donor.unit },
              nsn: skipped.need.needed_part.nsn,
              nomenclature: skipped.need.needed_part.nomenclature,
              impact: `Auto-proposed top match · ${skipped.need.asset_id} ← ${skipped.donor.asset_id}.`,
              commit_status: "pending_retry",
              retry_reason: "Session expired before this draft was sent.",
            });
            pending++;
          }
          break;
        } else {
          newRows.push({
            ...baseRow,
            commit_status: "pending_retry",
            retry_reason: result.reason,
          });
          pending++;
        }
      }
      setProposedLocal((prev) => [...newRows, ...prev]);
      if (unauthorized) {
        pushToast({
          tone: "warn",
          text: `Session expired · ${committed} committed, ${pending} pending retry. Sign in to resubmit.`,
        });
        setAutoConfirm(null);
        useSpireStore.getState().signOut();
        return;
      }
      if (pending === 0) {
        pushToast({
          tone: "ok",
          text: `${committed} auto-proposals committed to the audit chain.`,
        });
      } else {
        pushToast({
          tone: "warn",
          text: `${committed} committed · ${pending} pending retry (yellow rows below).`,
        });
      }
      setAutoConfirm(null);
    } finally {
      setAutoSubmitting(false);
    }
  }

  return (
    // Cannibalization three-column flow stacks vertically below lg so each
    // pane (Needs / Donors / Completed Matches) gets full width on mobile
    // and small laptops. Above lg the original 5/3/4 split returns.
    <div className="flex h-full flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
      <section className="flex w-full min-h-[24rem] flex-col overflow-y-auto border-b border-[var(--color-border)] p-4 lg:w-5/12 lg:min-h-0 lg:border-b-0 lg:border-r">
        <div className="mb-3">
          <h3
            className="font-mono text-base font-semibold uppercase text-[var(--color-text)] tracking-widest"
          >
            Needs · Open NMCS Assets ({needs.length}{filteredNeeds.length !== allNeeds.length ? ` of ${allNeeds.length}` : ""})
          </h3>
          <div className="mt-0.5 spire-body-muted">
            Deadlined assets with un-received parts. Click a need to find compatible donors.
          </div>
        </div>

        {/* Walkthrough #43, #44, #45 — filter / sort / bulk controls */}
        <div className="mb-3 flex flex-col gap-2 rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] p-2">
          <div className="flex flex-wrap items-center gap-2 font-mono text-xs uppercase tracking-wider">
            <span className="text-[var(--color-text-muted)]">Filter:</span>
            <select
              value={unitFilter ?? ""}
              onChange={(e) => setUnitFilter(e.target.value || null)}
              className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-0.5 text-[var(--color-text)]"
            >
              <option value="">All units</option>
              {unitsList.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
            <select
              value={partClassFilter ?? ""}
              onChange={(e) => setPartClassFilter(e.target.value || null)}
              className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-0.5 text-[var(--color-text)]"
            >
              <option value="">All part classes</option>
              {partClasses.slice(0, 12).map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            {(unitFilter || partClassFilter) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setUnitFilter(null); setPartClassFilter(null); }}
              >
                Clear ✕
              </Button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 font-mono text-xs uppercase tracking-wider">
            <span className="text-[var(--color-text-muted)]">Sort:</span>
            {(["days_open", "impact", "unit"] as SortMode[]).map((m) => (
              <Button
                key={m}
                onClick={() => setSortMode(m)}
                variant={sortMode === m ? "primary" : "ghost"}
                size="sm"
              >
                {m === "days_open" ? "By days open" : m === "impact" ? "By impact" : "By unit"}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 font-mono text-xs uppercase tracking-wider">
            <label className="flex items-center gap-1 text-[var(--color-text-muted)]">
              <input
                type="checkbox"
                checked={crossUnitOnly}
                onChange={(e) => setSameClassOnly(e.target.checked)}
                className="accent-[var(--color-primary)]"
              />
              Cross-unit only
            </label>
            {/* Task #41 — security_manager has read-only access. They review
                the audit chain after the fact, so all write affordances on
                this page are hidden for that role. */}
            {canPropose && (
              <Button
                onClick={autoProposeTopMatches}
                variant="primary"
                size="sm"
                className="ml-auto"
                title="Auto-propose the top donor for each filtered need"
              >
                Auto-propose top matches
              </Button>
            )}
          </div>
          {!canPropose && (
            <div className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
              Read-only · security_manager reviews proposals; cannot author them.
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2">
          {needs.map((n) => (
            <Pressable
              key={n.sr_number}
              onClick={() => setSelectedNeed(n)}
              className={`rounded-sm border ${
                selectedNeed?.sr_number === n.sr_number
                  ? "border-[var(--color-primary)] bg-[var(--color-surface-hover)]"
                  : "border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-border-active)] hover:bg-[var(--color-surface-hover)]"
              } p-3`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <div>
                  <div className="font-mono text-base font-semibold text-[var(--color-text)]">{n.asset_id}</div>
                  <div className="mt-0.5 font-mono text-xs text-[var(--color-text-muted)] tracking-wide">
                    {n.equipment_type.replace(/_/g, " ")} · {n.unit} · open {n.days_open}d · fault: {n.fault_component}
                    {/* Walkthrough audit: fault_class often equals
                     * fault_component (e.g. both 'brake'), and the
                     * uppercase-styled badge then read 'BRAKE' next to
                     * the lowercase 'brake' as a noisy duplicate.
                     * Suppress the badge when they match. */}
                    {n.fault_class && n.fault_class !== n.fault_component && (
                      <span className="ml-1 rounded-sm border border-[var(--color-border)] px-1 text-[10px] uppercase">
                        class: {n.fault_class}
                      </span>
                    )}
                  </div>
                </div>
                <span
                  className="rounded-sm border border-[var(--color-danger)] px-1.5 py-[1px] font-mono text-xs font-semibold uppercase text-[var(--color-danger)] tracking-wider"
                  style={{ background: "color-mix(in oklab, var(--color-danger-muted) 20%, transparent)" }}
                >
                  NMCS
                </span>
              </div>
              <div className="mt-2 flex items-center gap-3 font-mono text-sm">
                <span className="text-[var(--color-text)]">{n.needed_part.nsn}</span>
                <span className="text-[var(--color-text-secondary)]">{n.needed_part.nomenclature}</span>
                <span className="ml-auto text-[var(--color-text-muted)]">${n.needed_part.unit_cost}</span>
              </div>
            </Pressable>
          ))}
        </div>
      </section>

      <section className="flex w-full min-h-[24rem] flex-col overflow-y-auto border-b border-[var(--color-border)] p-4 lg:w-3/12 lg:min-h-0 lg:border-b-0 lg:border-r">
        <div className="mb-3">
          <h3
            className="font-mono text-base font-semibold uppercase text-[var(--color-text)] tracking-widest"
          >
            Candidate Donors {selectedNeed && `(${donors.length})`}
          </h3>
          <div className="mt-0.5 spire-body-muted">
            {selectedNeed
              ? `Strippable ${selectedNeed.equipment_type.replace(/_/g, " ")} hulls · same fault-class donors filtered out (their copy of the part is also failing).`
              : "Select a need to see compatible donors."}
          </div>
        </div>
        {!selectedNeed && (
          <div className="rounded-sm border border-dashed border-[var(--color-border)] p-8 text-center font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
            NO SELECTION
          </div>
        )}
        {selectedNeed && donors.length === 0 && (
          <div className="rounded-sm border border-dashed border-[var(--color-border)] p-6 font-mono text-xs text-[var(--color-text-muted)] tracking-wide">
            <div className="text-center uppercase tracking-wider">No strippable hulls in scope</div>
            <div className="mt-2 normal-case text-[var(--color-text-secondary)]">
              No same-platform asset in the scoped units has the recipient&apos;s
              part installed and serviceable. Recommend Risk Board to expedite
              the requisition or initiate a cross-level transfer of a
              like-platform donor from outside this scope.
            </div>
          </div>
        )}
        <div className="flex flex-col gap-2">
          {donors.map((d) => {
            const statusTone = d.current_status === "MC"
              ? "var(--color-success-muted)"
              : d.current_status === "PMC"
                ? "var(--color-warning)"
                : "var(--color-danger)";
            return (
              <div
                key={d.asset_id}
                className="rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <div className="font-mono text-base font-semibold text-[var(--color-text)]">{d.asset_id}</div>
                  <span
                    className="rounded-sm border px-1.5 py-[1px] font-mono text-xs font-semibold uppercase tracking-wider"
                    style={{ borderColor: statusTone, color: statusTone }}
                  >
                    {d.current_status}
                  </span>
                </div>
                <div className="mt-0.5 font-mono text-xs text-[var(--color-text-muted)] tracking-wide">
                  {d.equipment_type.replace(/_/g, " ")} · {d.unit}
                  {d.unit_mc_rate != null && (
                    <span className="ml-2 tabular-nums">unit MC {(d.unit_mc_rate * 100).toFixed(1)}%</span>
                  )}
                </div>
                {/* Task #40 -- strip_reason explains why this hull qualifies
                   as a donor (long-term-NMC / PMC / MC at high-MC unit). */}
                <div className="mt-1 font-mono text-xs text-[var(--color-text-secondary)] tracking-wide">
                  {d.strip_reason}
                </div>
                {d.donor_fault_classes.length > 0 && (
                  <div className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
                    other open faults: {d.donor_fault_classes.join(", ")}
                  </div>
                )}
                {/* Walkthrough #23 — primary CTA-styled Propose button.
                    Task #41 — hidden for security_manager (read-only role). */}
                {canPropose && (
                  <div className="mt-2 flex items-center justify-end">
                    <Button
                      onClick={() => setConfirmDonor({ need: selectedNeed!, donor: d })}
                      variant="primary"
                      size="sm"
                    >
                      Propose
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="flex w-full min-h-[24rem] flex-col overflow-y-auto p-4 lg:w-4/12 lg:min-h-0">
        <div className="mb-3">
          <h3
            className="font-mono text-base font-semibold uppercase text-[var(--color-text)] tracking-widest"
          >
            Completed Matches ({matches.length}) · Engine-Verified
          </h3>
          <div className="mt-0.5 spire-body-muted">
            Cross-unit cannibalizations executed by PULSE's matcher and operator proposals.
          </div>
        </div>
        <div className="flex flex-col gap-2">
          {matches.map((m) => {
            const isLocal = m.event_id.startsWith("CAN-LOCAL");
            const isSelf = m.scope === "self" || m.recipient.unit === m.donor.unit;
            // Task-42 — derive the local-row badge state from the live
            // DDIL queue: if this row was queued and its local id is
            // still in the store, render "Queued · DDIL"; once the
            // CommsControl drain removes the id, the badge auto-flips
            // to "Replayed". A row that committed live keeps "New".
            const isQueuedLocal = isLocal && m.localStatus === "queued";
            const stillQueued = isQueuedLocal && m.localId != null && queuedIds.has(m.localId);
            const wasReplayed = isQueuedLocal && !stillQueued;
            // Task #41 — pending_retry rows render yellow so the operator
            // can't mistake an unconfirmed commit for an audit-chain entry.
            // pending_retry takes precedence over queued/replayed because
            // it's the result of a backend rejection, not a transport hold.
            const isPending = m.commit_status === "pending_retry";
            const localBorder = isPending
              ? "color-mix(in oklab, var(--color-warning) 50%, var(--color-border))"
              : stillQueued
                ? "color-mix(in oklab, var(--color-warning) 50%, var(--color-border))"
                : wasReplayed
                  ? "color-mix(in oklab, var(--color-success) 45%, var(--color-border))"
                  : "color-mix(in oklab, var(--color-primary) 40%, var(--color-border))";
            const localBackground = isPending
              ? "color-mix(in oklab, var(--color-warning) 10%, var(--color-surface))"
              : stillQueued
                ? "color-mix(in oklab, var(--color-warning) 8%, var(--color-surface))"
                : wasReplayed
                  ? "color-mix(in oklab, var(--color-success) 8%, var(--color-surface))"
                  : "color-mix(in oklab, var(--color-primary) 6%, var(--color-surface))";
            return (
              <div
                key={m.event_id}
                className="rounded-sm border p-3"
                style={{
                  borderColor: isLocal ? localBorder : "var(--color-success-muted)",
                  background: isLocal
                    ? localBackground
                    : "color-mix(in oklab, var(--color-success-muted) 10%, var(--color-surface))",
                }}
              >
                <div className="flex items-baseline justify-between">
                  <div className="flex items-center gap-2">
                    <div className="font-mono text-base font-semibold text-[var(--color-text)]">{m.event_id}</div>
                    {/* Walkthrough #11 — self badge for unit-internal moves */}
                    {isSelf && (
                      <span className="rounded-sm border border-[var(--color-text-muted)] px-1 font-mono text-[10px] uppercase text-[var(--color-text-muted)]">
                        self
                      </span>
                    )}
                    {isPending && (
                      <span className="rounded-sm border border-[var(--color-warning)] px-1 font-mono text-[10px] uppercase text-[var(--color-warning)]">
                        pending retry
                      </span>
                    )}
                  </div>
                  <span className="font-mono text-xs text-[var(--color-text-muted)] tracking-wide">
                    {m.event_date}
                    {isLocal && stillQueued && (
                      <span
                        className="ml-2 rounded-sm border px-1 text-xs uppercase tracking-wider"
                        style={{
                          borderColor: "var(--color-warning)",
                          color: "var(--color-warning)",
                          background: "color-mix(in oklab, var(--color-warning) 14%, transparent)",
                        }}
                        title="DDIL DISCONNECTED · queued for replay on reconnect"
                      >
                        Queued · DDIL
                      </span>
                    )}
                    {isLocal && wasReplayed && (
                      <span
                        className="ml-2 rounded-sm border px-1 text-xs uppercase tracking-wider"
                        style={{
                          borderColor: "var(--color-success)",
                          color: "var(--color-success)",
                          background: "color-mix(in oklab, var(--color-success) 14%, transparent)",
                        }}
                        title="Queued write replayed on reconnect"
                      >
                        Replayed
                      </span>
                    )}
                    {isLocal && !isQueuedLocal && !isPending && (
                      <span className="ml-2 rounded-sm border border-[var(--color-primary)] px-1 text-xs uppercase text-[var(--color-primary)]">
                        New
                      </span>
                    )}
                  </span>
                </div>
                {isPending && m.retry_reason && (
                  <div className="mt-1 font-mono text-xs text-[var(--color-warning)]">
                    Not in audit chain · {m.retry_reason}
                  </div>
                )}
                <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <div className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
                      Recipient
                    </div>
                    <div className="font-mono text-[var(--color-text)]">{m.recipient.asset_id}</div>
                    <div className="font-mono text-[var(--color-text-secondary)] tracking-wide">
                      {m.recipient.unit}
                    </div>
                  </div>
                  <div>
                    <div className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
                      Donor
                    </div>
                    <div className="font-mono text-[var(--color-text)]">{m.donor.asset_id}</div>
                    <div className="font-mono text-[var(--color-text-secondary)] tracking-wide">
                      {m.donor.unit}
                    </div>
                  </div>
                </div>
                <div className="mt-2 font-mono text-sm text-[var(--color-text-secondary)]">
                  <span>{m.nsn}</span>
                  <span className="mx-1 text-[var(--color-border-active)]">·</span>
                  <span>{m.nomenclature}</span>
                </div>
                {/* Walkthrough #25 — system-summary tone (no marketing copy). */}
                <div className="mt-1 spire-body-muted text-sm">
                  {/^Mission saved/i.test(m.impact)
                    ? `Donor evac scheduled · recipient SR closed · audit ${m.event_id}.`
                    : m.impact}
                </div>
                {/* Walkthrough #42 — work-order details */}
                {m.work_order && (
                  <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 font-mono text-xs">
                    <div className="text-[var(--color-text-muted)]">Work order</div>
                    <div className="text-[var(--color-text)] tabular-nums">{m.work_order.wo_number}</div>
                    <div className="text-[var(--color-text-muted)]">Approved by</div>
                    <div className="text-[var(--color-text)]">{m.work_order.approved_by}</div>
                    <div className="text-[var(--color-text-muted)]">Removed by</div>
                    <div className="text-[var(--color-text)]">{m.work_order.removed_by}</div>
                    <div className="text-[var(--color-text-muted)]">Installed by</div>
                    <div className="text-[var(--color-text)]">{m.work_order.installed_by}</div>
                    <div className="text-[var(--color-text-muted)]">Disposition</div>
                    <div className="text-[var(--color-text)]">{m.work_order.disposition}</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {confirmDonor && (
        <ConfirmProposeModal
          need={confirmDonor.need}
          donor={confirmDonor.donor}
          committing={committing}
          onCancel={() => setConfirmDonor(null)}
          onConfirm={commit}
        />
      )}
      {autoConfirm && (
        <ConfirmAutoProposeModal
          drafts={autoConfirm.drafts}
          submitting={autoSubmitting}
          onCancel={() => setAutoConfirm(null)}
          onConfirm={submitAutoDrafts}
        />
      )}
    </div>
  );
}

// Task #41 — single confirm-all dialog for the bulk auto-propose flow.
// Shows the count and a preview list so the operator sees exactly what they
// are about to submit to the audit chain. Replaces the prior implementation
// where the button silently invented frontend rows the backend never saw.
function ConfirmAutoProposeModal({
  drafts,
  submitting,
  onCancel,
  onConfirm,
}: {
  drafts: { need: NeedRow; donor: DonorRow }[];
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) onCancel();
    }
    window.addEventListener("keydown", onKey);
    const t = setTimeout(
      () => dialogRef.current?.querySelector<HTMLElement>("button")?.focus(),
      0,
    );
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(t);
    };
  }, [onCancel, submitting]);
  return (
    <div
      className="fixed inset-0 z-[8000] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={submitting ? undefined : onCancel}
      role="dialog"
      aria-modal="true"
      aria-labelledby="auto-propose-title"
    >
      <div
        ref={dialogRef}
        className="w-[40rem] max-w-[92vw] rounded-sm border border-[var(--color-primary)] bg-[var(--color-surface)] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          id="auto-propose-title"
          className="mb-2 font-mono text-xs uppercase text-[var(--color-primary)] tracking-widest"
        >
          Confirm Auto-Propose Batch
        </div>
        <div className="mb-3 font-mono text-lg font-semibold text-[var(--color-text)] tracking-wide">
          Submit {drafts.length} proposal{drafts.length === 1 ? "" : "s"} to the audit chain
        </div>
        <div className="mb-3 spire-body-muted text-sm">
          Each row below will be POSTed individually. Rows that the backend
          rejects come back as <span className="text-[var(--color-warning)]">pending retry</span> in
          the matches column — they are NOT in the audit chain until the
          server confirms.
        </div>
        <div className="mb-4 max-h-64 overflow-y-auto rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono text-xs">
          {drafts.map((d, i) => (
            <div
              key={`${d.need.sr_number}-${d.donor.asset_id}-${i}`}
              className="flex items-baseline justify-between border-b border-[var(--color-border)] py-1 last:border-b-0"
            >
              <div>
                <span className="text-[var(--color-text)]">{d.need.asset_id}</span>
                <span className="mx-1 text-[var(--color-text-muted)]">←</span>
                <span className="text-[var(--color-text)]">{d.donor.asset_id}</span>
                <span className="ml-2 text-[var(--color-text-muted)]">
                  ({d.need.unit} ← {d.donor.unit})
                </span>
              </div>
              <div className="text-[var(--color-text-muted)]">{d.need.needed_part.nsn}</div>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-end gap-2">
          <Button onClick={onCancel} variant="secondary" size="sm" disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={onConfirm} pending={submitting} variant="primary" size="sm">
            {submitting ? "Submitting" : `Submit ${drafts.length}`}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ConfirmProposeModal({
  need,
  donor,
  committing,
  onCancel,
  onConfirm,
}: {
  need: NeedRow;
  donor: DonorRow;
  committing: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const crossUnit = need.unit !== donor.unit;
  const dialogRef = useRef<HTMLDivElement>(null);
  // Task #40 -- pre-commit donor MC impact estimate.
  //
  // Pre-fix bug: the prior math always subtracted 1 from MC count because
  // every "donor" was an NMCS need (so removing the part inflated the
  // displayed impact -- the donor was already not in the MC tally).
  // With strippable donors, removing the part only decrements the MC
  // count when the donor was MC to begin with. PMC/NMCM/NMCS donors do
  // not change the MC count (they were never counted as MC).
  const donorMc = donor.unit_mc_rate ?? 0;
  const donorTotal = donor.unit_total ?? 0;
  const donorMcCount = donor.unit_mc_count ?? 0;
  const willDropMc = donor.current_status === "MC" ? 1 : 0;
  const projectedMc = donorTotal > 0
    ? Math.max(0, (donorMcCount - willDropMc) / donorTotal)
    : donorMc;
  // A donor is "high-impact" only when stripping it actually drops a MC
  // hull. A long-term-NMC strippable hull is a free cannibalization from
  // the unit's MC perspective.
  const donorIsHighImpact = willDropMc === 1;
  // Walkthrough #10 -- operator must acknowledge the impact when stripping
  // an MC hull. NMC/PMC strippables don't gate.
  const [acknowledged, setAcknowledged] = useState(!donorIsHighImpact);

  // Walkthrough #24 — Esc dismiss + click-outside + focus-trap.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
      if (e.key === "Tab") {
        const f = dialogRef.current?.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (!f || f.length === 0) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    // Move focus into dialog
    const t = setTimeout(() => dialogRef.current?.querySelector<HTMLElement>("button")?.focus(), 0);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(t);
    };
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-[8000] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-labelledby="propose-title"
    >
      <div
        ref={dialogRef}
        className="w-[34rem] max-w-[92vw] rounded-sm border border-[var(--color-primary)] bg-[var(--color-surface)] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          id="propose-title"
          className="mb-2 font-mono text-xs uppercase text-[var(--color-primary)] tracking-widest"
        >
          Propose Cannibalization Match
        </div>
        <div className="mb-3 font-mono text-lg font-semibold text-[var(--color-text)] tracking-wide">
          Cross-level {need.needed_part.nomenclature}
        </div>
        <div className="mb-3 grid grid-cols-1 gap-3 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-3 sm:grid-cols-2">
          <div>
            <div className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
              Recipient
            </div>
            <div className="mt-0.5 font-mono text-base font-semibold text-[var(--color-text)]">{need.asset_id}</div>
            <div className="font-mono text-xs text-[var(--color-text-secondary)] tracking-wide">
              {need.unit} · {need.equipment_type.replace(/_/g, " ")}
            </div>
          </div>
          <div>
            <div className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
              Donor
            </div>
            <div className="mt-0.5 font-mono text-base font-semibold text-[var(--color-text)]">{donor.asset_id}</div>
            <div className="font-mono text-xs text-[var(--color-text-secondary)] tracking-wide">
              {donor.unit} · {donor.equipment_type.replace(/_/g, " ")}
            </div>
          </div>
          <div className="col-span-2">
            <div className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
              NSN
            </div>
            <div className="mt-0.5 font-mono text-base text-[var(--color-text)]">
              {need.needed_part.nsn} · {need.needed_part.nomenclature}
            </div>
          </div>
        </div>

        {/* Task #40 -- pre-commit MC impact estimate; only "warn" tone when
            the donor was itself MC (stripping it drops a hull from the MC
            tally). Long-term-NMC and PMC strippables show the math but
            don't gate the commit. */}
        {donorTotal > 0 && (
          <div
            className="mb-3 rounded-sm border bg-[var(--color-bg)] px-3 py-2 font-mono text-xs tracking-wide"
            style={{
              borderColor: donorIsHighImpact
                ? "color-mix(in oklab, var(--color-warning) 40%, var(--color-border))"
                : "color-mix(in oklab, var(--color-success-muted) 60%, var(--color-border))",
            }}
          >
            <div className="text-[var(--color-text-muted)]">
              Donor unit MC impact estimate · donor status {donor.current_status}
            </div>
            <div className="mt-0.5 text-sm text-[var(--color-text)] tabular-nums">
              {donor.unit}: {(donorMc * 100).toFixed(1)}% → {(projectedMc * 100).toFixed(1)}% (≈{((donorMc - projectedMc) * 100).toFixed(1)} pp)
            </div>
            {!donorIsHighImpact && (
              <div className="mt-1 text-[var(--color-text-secondary)]">
                Donor was not in the MC tally; strip does not change unit MC rate.
              </div>
            )}
            {donorIsHighImpact && (
              <div className="mt-1 text-[var(--color-warning)]">
                ⚠ Donor was MC. Strip will deadline this hull until the
                donated part is replaced. Confirm acknowledgement before committing.
              </div>
            )}
            <div className="mt-1 text-[var(--color-text-muted)]">
              Why this hull is strippable: {donor.strip_reason}
            </div>
          </div>
        )}

        <div className="mb-4 spire-body-muted text-sm">
          {crossUnit
            ? "Cross-unit match — requires coordination between recipient and donor commands."
            : "Intra-unit match — direct motor-pool transfer (self-cannibalization, no inter-command coordination)."}
          &nbsp;Donor's SR annotated with removal event; recipient's requisition closes as CANN.
        </div>

        {/* Task #40 -- gate commit only when stripping the donor would
            drop a MC hull from the unit tally. */}
        {donorIsHighImpact && (
          <label className="mb-3 flex items-start gap-2 font-mono text-xs text-[var(--color-warning)] tracking-wide">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-0.5 accent-[var(--color-warning)]"
            />
            I acknowledge stripping this MC hull will drop the donor unit MC rate.
          </label>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button onClick={onCancel} variant="secondary" size="sm">
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            disabled={!acknowledged}
            pending={committing}
            variant="primary"
            size="sm"
          >
            {committing ? "Committing" : "Commit Proposal"}
          </Button>
        </div>
      </div>
    </div>
  );
}
