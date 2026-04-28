import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Cannibalization, type StrippableDonor } from "../../api";
import { LoadingOverlay } from "./FleetOverviewTab";
import { useSpireStore } from "../../state/store";
import { Button, Pressable, fireIdempotent } from "../../components/ui";

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
  // Walkthrough #42 — surface full work-order metadata.
  work_order?: {
    wo_number: string;
    approved_by: string;
    removed_by: string;
    installed_by: string;
    disposition: string;
  };
};

// Task #40 -- DonorRow is a strippable asset record (not another open need).
// A donor is a hull where the part is installed and serviceable, sourced
// from the backend's strippable_donors surface.
type DonorRow = StrippableDonor;

type SortMode = "days_open" | "impact" | "unit";

export function CannibalizationTab() {
  const role = useSpireStore((s) => s.role);
  const pushToast = useSpireStore((s) => s.pushToast);
  const [data, setData] = useState<Cannibalization | null>(null);
  const [selectedNeed, setSelectedNeed] = useState<NeedRow | null>(null);
  const [proposedLocal, setProposedLocal] = useState<MatchRow[]>([]);
  const [confirmDonor, setConfirmDonor] = useState<{ need: NeedRow; donor: DonorRow } | null>(null);
  const [committing, setCommitting] = useState(false);
  // Walkthrough #43 — filter chips
  const [unitFilter, setUnitFilter] = useState<string | null>(null);
  const [partClassFilter, setPartClassFilter] = useState<string | null>(null);
  // Walkthrough #44 — sort control
  const [sortMode, setSortMode] = useState<SortMode>("days_open");
  // Walkthrough #45 — same-fault-class only mode
  const [crossUnitOnly, setSameClassOnly] = useState(false);

  useEffect(() => {
    setData(null);
    setSelectedNeed(null);
    setProposedLocal([]);
    // Walkthrough audit: prior code had no .catch — transient 502s
    // logged 'Uncaught (in promise)' instead of letting the empty
    // state render naturally.
    api.pulse.cannibalization()
      .then(setData)
      .catch(() => { /* tolerate; empty-state copy explains 'no needs' */ });
  }, [role]);

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
    try {
      const isSelf = confirmDonor.need.unit === confirmDonor.donor.unit;
      const optimistic: MatchRow = {
        event_id: `CAN-LOCAL-${Date.now()}`,
        event_date: new Date().toISOString().slice(0, 10),
        scope: isSelf ? "self" : "cross_unit",
        recipient: { asset_id: confirmDonor.need.asset_id, unit: confirmDonor.need.unit },
        donor: { asset_id: confirmDonor.donor.asset_id, unit: confirmDonor.donor.unit },
        nsn: confirmDonor.need.needed_part.nsn,
        nomenclature: confirmDonor.need.needed_part.nomenclature,
        impact: `Proposed by operator · recipient ${confirmDonor.need.unit} gains ${confirmDonor.need.needed_part.nomenclature} from ${confirmDonor.donor.unit}.`,
      };
      setProposedLocal((prev) => [optimistic, ...prev]);
      // Walkthrough audit (CRITICAL): prior code had no client-side timeout
      // on the POST. When the backend cold-started, the request sat for
      // ~30s before nginx returned 502, freezing the modal in 'Committing…'
      // with no operator feedback. 15s AbortController gives a definitive
      // ceiling — the optimistic row is already on screen so the operator
      // never blocks on the network.
      const ctrl = new AbortController();
      const timer = window.setTimeout(() => ctrl.abort(), 15_000);
      try {
        await fetch("/api/pulse/cannibalization/propose", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            recipient_sr: confirmDonor.need.sr_number,
            // Task #40 -- strippable donors are asset-keyed; donor may be MC
            // and have no SR. Backend accepts donor_asset_id as canonical.
            donor_asset_id: confirmDonor.donor.asset_id,
            nsn: confirmDonor.need.needed_part.nsn,
          }),
          signal: ctrl.signal,
        });
      } catch {
        /* Backend may not implement this endpoint yet OR cold-start
         * timeout — keep the optimistic row visible so the operator's
         * action isn't lost. The next poll resolves ground truth. */
      } finally {
        window.clearTimeout(timer);
      }
      pushToast({
        tone: "ok",
        text: `Match proposed · ${confirmDonor.need.asset_id} ← ${confirmDonor.donor.asset_id}`,
      });
      setConfirmDonor(null);
      setSelectedNeed(null);
    } finally {
      setCommitting(false);
    }
  }

  // Walkthrough #45 / Task #40 -- bulk auto-propose top strippable donor
  // for each filtered need. Sources from the backend's strippable_donors
  // pool so we never auto-propose another deadlined hull as a "donor".
  function autoProposeTopMatches() {
    if (!data) return;
    let count = 0;
    const proposals: MatchRow[] = [];
    for (const need of filteredNeeds) {
      const pool = data.strippable_donors?.[need.sr_number] ?? [];
      const candidates = pool.filter((d) => !crossUnitOnly || d.unit !== need.unit);
      if (candidates.length === 0) continue;
      // Pool is already priority-sorted by the backend (long-term-NMC,
      // then PMC, then MC at high-MC unit). Prefer cross-unit ties so
      // intra-unit moves don't shadow easier cross-level transfers.
      candidates.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        const aCross = a.unit !== need.unit ? 1 : 0;
        const bCross = b.unit !== need.unit ? 1 : 0;
        if (aCross !== bCross) return bCross - aCross;
        return (b.unit_mc_rate ?? 0) - (a.unit_mc_rate ?? 0);
      });
      const isSelf = candidates[0].unit === need.unit;
      proposals.push({
        event_id: `CAN-LOCAL-${Date.now()}-${count}`,
        event_date: new Date().toISOString().slice(0, 10),
        scope: isSelf ? "self" : "cross_unit",
        recipient: { asset_id: need.asset_id, unit: need.unit },
        donor: { asset_id: candidates[0].asset_id, unit: candidates[0].unit },
        nsn: need.needed_part.nsn,
        nomenclature: need.needed_part.nomenclature,
        impact: `Auto-proposed top match · ${need.asset_id} ← ${candidates[0].asset_id}.`,
      });
      count++;
    }
    if (count === 0) {
      pushToast({ tone: "warn", text: "No auto-match candidates available." });
      return;
    }
    setProposedLocal((prev) => [...proposals, ...prev]);
    pushToast({ tone: "ok", text: `${count} auto-proposals queued · operator review required.` });
  }

  return (
    <div className="flex h-full overflow-hidden">
      <section className="flex w-5/12 flex-col overflow-y-auto border-r border-[var(--color-border)] p-4">
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
            <Button
              onClick={autoProposeTopMatches}
              variant="primary"
              size="sm"
              className="ml-auto"
              title="Auto-propose the top donor for each filtered need"
            >
              Auto-propose top matches
            </Button>
          </div>
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

      <section className="flex w-3/12 flex-col overflow-y-auto border-r border-[var(--color-border)] p-4">
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
                <div className="mt-2 flex items-center justify-end">
                  <Button
                    onClick={() => setConfirmDonor({ need: selectedNeed!, donor: d })}
                    variant="primary"
                    size="sm"
                  >
                    Propose
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="flex w-4/12 flex-col overflow-y-auto p-4">
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
            return (
              <div
                key={m.event_id}
                className="rounded-sm border p-3"
                style={{
                  borderColor: isLocal
                    ? "color-mix(in oklab, var(--color-primary) 40%, var(--color-border))"
                    : "var(--color-success-muted)",
                  background: isLocal
                    ? "color-mix(in oklab, var(--color-primary) 6%, var(--color-surface))"
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
                  </div>
                  <span className="font-mono text-xs text-[var(--color-text-muted)] tracking-wide">
                    {m.event_date}
                    {isLocal && (
                      <span className="ml-2 rounded-sm border border-[var(--color-primary)] px-1 text-xs uppercase text-[var(--color-primary)]">
                        New
                      </span>
                    )}
                  </span>
                </div>
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
        <div className="mb-3 grid grid-cols-2 gap-3 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
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
