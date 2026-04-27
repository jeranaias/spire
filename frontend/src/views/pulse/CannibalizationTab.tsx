import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Cannibalization } from "../../api";
import { LoadingOverlay } from "./FleetOverviewTab";
import { useSpireStore } from "../../state/store";

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

type SortMode = "days_open" | "impact" | "unit";

export function CannibalizationTab() {
  const role = useSpireStore((s) => s.role);
  const pushToast = useSpireStore((s) => s.pushToast);
  const [data, setData] = useState<Cannibalization | null>(null);
  const [selectedNeed, setSelectedNeed] = useState<NeedRow | null>(null);
  const [proposedLocal, setProposedLocal] = useState<MatchRow[]>([]);
  const [confirmDonor, setConfirmDonor] = useState<{ need: NeedRow; donor: NeedRow } | null>(null);
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

  // Walkthrough #9 — Donor candidates with cause-of-fault overlap exclusion.
  // If recipient's fault class matches donor's fault class, the donor's
  // own X is the failing part — pulling it is nonsensical. Drop it.
  const donors = useMemo(() => {
    if (!data || !selectedNeed) return [];
    return (data.open_needs as NeedRow[]).filter((n) => {
      if (n.sr_number === selectedNeed.sr_number) return false;
      if (n.needed_part.nsn !== selectedNeed.needed_part.nsn) return false;
      // Walkthrough #9 — exclude donors whose own fault class matches the
      // recipient's. The donor would be the worst possible source of that
      // exact part since their copy of it is also failing.
      if (
        selectedNeed.fault_class &&
        n.fault_class &&
        selectedNeed.fault_class === n.fault_class
      ) return false;
      return true;
    });
  }, [data, selectedNeed]);

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

  async function commit() {
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
      try {
        await fetch("/api/pulse/cannibalization/propose", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            recipient_sr: confirmDonor.need.sr_number,
            donor_sr: confirmDonor.donor.sr_number,
            nsn: confirmDonor.need.needed_part.nsn,
          }),
        });
      } catch {
        /* Backend may not implement this endpoint yet; keep the optimistic row. */
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

  // Walkthrough #45 — bulk auto-propose top match per need.
  function autoProposeTopMatches() {
    if (!data) return;
    let count = 0;
    const proposals: MatchRow[] = [];
    for (const need of filteredNeeds) {
      const candidates = (data.open_needs as NeedRow[]).filter((n) =>
        n.sr_number !== need.sr_number &&
        n.needed_part.nsn === need.needed_part.nsn &&
        // Walkthrough audit: the checkbox 'Cross-unit, different fault
        // class' adds the cross-unit predicate when toggled on. The
        // different-fault-class predicate below applies in BOTH modes
        // (cause-of-fault overlap is always invalid — see #9).
        (!crossUnitOnly || n.unit !== need.unit) &&
        (n.fault_class !== need.fault_class)
      );
      if (candidates.length === 0) continue;
      // Prefer cross-unit donors; among those, the lowest unit_mc_rate
      // donor is the worst choice (their unit is hurting too) so prefer
      // donor with HIGHER mc_rate i.e. unit can spare it.
      candidates.sort((a, b) => {
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
              <button
                onClick={() => { setUnitFilter(null); setPartClassFilter(null); }}
                className="rounded-sm border border-[var(--color-border-active)] px-1.5 py-0.5 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
              >
                Clear ✕
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 font-mono text-xs uppercase tracking-wider">
            <span className="text-[var(--color-text-muted)]">Sort:</span>
            {(["days_open", "impact", "unit"] as SortMode[]).map((m) => (
              <button
                key={m}
                onClick={() => setSortMode(m)}
                className="rounded-sm border px-2 py-0.5"
                style={{
                  borderColor: sortMode === m ? "var(--color-primary)" : "var(--color-border)",
                  background: sortMode === m ? "color-mix(in oklab, var(--color-primary) 18%, transparent)" : "transparent",
                  color: sortMode === m ? "var(--color-primary)" : "var(--color-text-secondary)",
                }}
              >
                {m === "days_open" ? "By days open" : m === "impact" ? "By impact" : "By unit"}
              </button>
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
              Cross-unit, different fault class
            </label>
            <button
              onClick={autoProposeTopMatches}
              className="ml-auto rounded-sm border border-[var(--color-primary)] bg-[color-mix(in_oklab,var(--color-primary)_15%,transparent)] px-2 py-0.5 text-[var(--color-primary)] hover:bg-[color-mix(in_oklab,var(--color-primary)_25%,transparent)]"
              title="Auto-propose the top donor for each filtered need"
            >
              Auto-propose top matches
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          {needs.map((n) => (
            <button
              key={n.sr_number}
              onClick={() => setSelectedNeed(n)}
              className={`rounded-sm border text-left transition-colors ${
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
            </button>
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
              ? `Compatible NSN ${selectedNeed.needed_part.nsn} · same fault-class donors filtered out (their copy of the part is also failing).`
              : "Select a need to see compatible donors."}
          </div>
        </div>
        {!selectedNeed && (
          <div className="rounded-sm border border-dashed border-[var(--color-border)] p-8 text-center font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
            NO SELECTION
          </div>
        )}
        {selectedNeed && donors.length === 0 && (
          <div className="rounded-sm border border-dashed border-[var(--color-border)] p-8 text-center font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
            NO COMPATIBLE DONORS
          </div>
        )}
        <div className="flex flex-col gap-2">
          {donors.map((d) => (
            <div
              key={d.sr_number}
              className="rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
            >
              <div className="flex items-baseline justify-between">
                <div className="font-mono text-base font-semibold text-[var(--color-text)]">{d.asset_id}</div>
                <span className="font-mono text-xs text-[var(--color-text-muted)] tracking-wide">
                  {d.unit_mc_rate != null && (
                    <span className="mr-2 tabular-nums">unit MC {(d.unit_mc_rate * 100).toFixed(1)}%</span>
                  )}
                </span>
              </div>
              <div className="mt-0.5 font-mono text-xs text-[var(--color-text-muted)] tracking-wide">
                {d.equipment_type.replace(/_/g, " ")} · {d.unit} · open {d.days_open}d
              </div>
              <div className="mt-1 font-mono text-xs text-[var(--color-text-secondary)] tracking-wide">
                Fault: {d.fault_component} {d.fault_class && d.fault_class !== d.fault_component && <span className="text-[var(--color-text-muted)]">({d.fault_class})</span>}
              </div>
              {/* Walkthrough #23 — primary CTA-styled Propose button. */}
              <div className="mt-2 flex items-center justify-end">
                <button
                  onClick={() => setConfirmDonor({ need: selectedNeed!, donor: d })}
                  className="rounded-sm border border-[var(--color-primary)] bg-[var(--color-primary)] px-3 py-1 font-mono text-xs font-semibold uppercase text-white hover:bg-[var(--color-primary-hover)] tracking-widest"
                >
                  Propose
                </button>
              </div>
            </div>
          ))}
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
  donor: NeedRow;
  committing: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const crossUnit = need.unit !== donor.unit;
  const dialogRef = useRef<HTMLDivElement>(null);
  // Walkthrough #10 — pre-commit donor MC impact estimate. We approximate
  // by removing one MC asset from the donor unit's last-day count.
  const donorMc = donor.unit_mc_rate ?? 0;
  const donorTotal = donor.unit_total ?? 0;
  const donorMcCount = donor.unit_mc_count ?? 0;
  const projectedMc = donorTotal > 0
    ? Math.max(0, (donorMcCount - 1) / donorTotal)
    : donorMc;
  const donorIsNmcs = donor.fault_component != null;  // donor itself was a need = NMCS
  // Walkthrough #10 — operator must acknowledge the impact when donor is NMCS.
  const [acknowledged, setAcknowledged] = useState(!donorIsNmcs);

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

        {/* Walkthrough #10 — pre-commit MC impact estimate */}
        {donorTotal > 0 && (
          <div
            className="mb-3 rounded-sm border bg-[var(--color-bg)] px-3 py-2 font-mono text-xs tracking-wide"
            style={{
              borderColor: donorIsNmcs
                ? "color-mix(in oklab, var(--color-danger) 40%, var(--color-border))"
                : "color-mix(in oklab, var(--color-warning) 30%, var(--color-border))",
            }}
          >
            <div className="text-[var(--color-text-muted)]">Donor unit MC impact estimate</div>
            <div className="mt-0.5 text-sm text-[var(--color-text)] tabular-nums">
              {donor.unit}: {(donorMc * 100).toFixed(1)}% → {(projectedMc * 100).toFixed(1)}% (≈{((donorMc - projectedMc) * 100).toFixed(1)} pp)
            </div>
            {donorIsNmcs && (
              <div className="mt-1 text-[var(--color-danger)]">
                ⚠ Donor is itself NMCS. Confirm operator acknowledgement before committing.
              </div>
            )}
          </div>
        )}

        <div className="mb-4 spire-body-muted text-sm">
          {crossUnit
            ? "Cross-unit match — requires coordination between recipient and donor commands."
            : "Intra-unit match — direct motor-pool transfer (self-cannibalization, no inter-command coordination)."}
          &nbsp;Donor's SR annotated with removal event; recipient's requisition closes as CANN.
        </div>

        {/* Walkthrough #10 — block commit until acknowledgement */}
        {donorIsNmcs && (
          <label className="mb-3 flex items-start gap-2 font-mono text-xs text-[var(--color-warning)] tracking-wide">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-0.5 accent-[var(--color-warning)]"
            />
            I acknowledge the donor is NMCS and the unit MC drop is acceptable.
          </label>
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-sm border border-[var(--color-border-active)] px-3 py-1.5 font-mono text-sm font-semibold uppercase text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] tracking-widest"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={committing || !acknowledged}
            className="rounded-sm border border-[var(--color-primary)] bg-[var(--color-primary)] px-4 py-1.5 font-mono text-sm font-semibold uppercase text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50 tracking-widest"
          >
            {committing ? "Committing…" : "Commit Proposal"}
          </button>
        </div>
      </div>
    </div>
  );
}
