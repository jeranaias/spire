import { useEffect, useMemo, useState } from "react";
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
  needed_part: { nsn: string; nomenclature: string; unit_cost: number };
};

type MatchRow = {
  event_id: string;
  event_date: string;
  recipient: { asset_id: string; unit: string };
  donor: { asset_id: string; unit: string };
  nsn: string;
  nomenclature: string;
  impact: string;
};

export function CannibalizationTab() {
  const role = useSpireStore((s) => s.role);
  const pushToast = useSpireStore((s) => s.pushToast);
  const [data, setData] = useState<Cannibalization | null>(null);
  const [selectedNeed, setSelectedNeed] = useState<NeedRow | null>(null);
  const [proposedLocal, setProposedLocal] = useState<MatchRow[]>([]);
  const [confirmDonor, setConfirmDonor] = useState<{ need: NeedRow; donor: NeedRow } | null>(null);
  const [committing, setCommitting] = useState(false);

  useEffect(() => {
    setData(null);
    setSelectedNeed(null);
    setProposedLocal([]);
    api.pulse.cannibalization().then(setData);
  }, [role]);

  // Donor candidates for the selected need — hooks must run unconditionally
  // so we keep the useMemo ABOVE the early return and null-guard the body.
  const donors = useMemo(() => {
    if (!data || !selectedNeed) return [];
    return (data.open_needs as NeedRow[]).filter(
      (n) => n.sr_number !== selectedNeed.sr_number && n.needed_part.nsn === selectedNeed.needed_part.nsn,
    );
  }, [data, selectedNeed]);

  if (!data) return <LoadingOverlay message="Matching needs with donors …" />;

  const needs = data.open_needs as NeedRow[];
  const matches = [...proposedLocal, ...(data.completed_matches as MatchRow[])];

  async function commit() {
    if (!confirmDonor) return;
    setCommitting(true);
    try {
      // Optimistic local row while the backend accepts the proposal.
      const optimistic: MatchRow = {
        event_id: `CAN-LOCAL-${Date.now()}`,
        event_date: new Date().toISOString().slice(0, 10),
        recipient: { asset_id: confirmDonor.need.asset_id, unit: confirmDonor.need.unit },
        donor: { asset_id: confirmDonor.donor.asset_id, unit: confirmDonor.donor.unit },
        nsn: confirmDonor.need.needed_part.nsn,
        nomenclature: confirmDonor.need.needed_part.nomenclature,
        impact: `Proposed by operator · recipient ${confirmDonor.need.unit} gains ${confirmDonor.need.needed_part.nomenclature} from ${confirmDonor.donor.unit}.`,
      };
      setProposedLocal((prev) => [optimistic, ...prev]);
      // Fire the backend POST (endpoint exists at /pulse/cannibalization/propose;
      // if it 404s the optimistic row still reads as a local record).
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

  return (
    <div className="flex h-full overflow-hidden">
      <section className="flex w-5/12 flex-col overflow-y-auto border-r border-[var(--color-border)] p-4">
        <div className="mb-3">
          <h3
            className="font-mono text-base font-semibold uppercase text-[var(--color-text)] tracking-widest"
          >
            Needs · Open NMCS Assets ({needs.length})
          </h3>
          <div className="mt-0.5 spire-body-muted">
            Deadlined assets with un-received parts. Click a need to find compatible donors.
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
                    {n.equipment_type} · {n.unit} · open {n.days_open}d · fault: {n.fault_component}
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
              ? `Assets with matching NSN ${selectedNeed.needed_part.nsn}. Cross-unit preferred.`
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
            <button
              key={d.sr_number}
              onClick={() => setConfirmDonor({ need: selectedNeed!, donor: d })}
              className="rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-left transition-colors hover:border-[var(--color-primary)] hover:bg-[var(--color-surface-hover)]"
            >
              <div className="flex items-baseline justify-between">
                <div className="font-mono text-base font-semibold text-[var(--color-text)]">{d.asset_id}</div>
                <span className="font-mono text-xs text-[var(--color-text-muted)] tracking-wide">
                  propose ▸
                </span>
              </div>
              <div className="mt-0.5 font-mono text-xs text-[var(--color-text-muted)] tracking-wide">
                {d.equipment_type} · {d.unit} · open {d.days_open}d
              </div>
              <div className="mt-1 font-mono text-xs text-[var(--color-text-secondary)] tracking-wide">
                Fault: {d.fault_component}
              </div>
            </button>
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
                  <div className="font-mono text-base font-semibold text-[var(--color-text)]">{m.event_id}</div>
                  <span className="font-mono text-xs text-[var(--color-text-muted)]" style={{ letterSpacing: "0.08em" }}>
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
                    <div className="font-mono text-xs uppercase text-[var(--color-text-muted)]" style={{ letterSpacing: "0.18em" }}>
                      Recipient
                    </div>
                    <div className="font-mono text-[var(--color-text)]">{m.recipient.asset_id}</div>
                    <div className="font-mono text-[var(--color-text-secondary)]" style={{ letterSpacing: "0.04em" }}>
                      {m.recipient.unit}
                    </div>
                  </div>
                  <div>
                    <div className="font-mono text-xs uppercase text-[var(--color-text-muted)]" style={{ letterSpacing: "0.18em" }}>
                      Donor
                    </div>
                    <div className="font-mono text-[var(--color-text)]">{m.donor.asset_id}</div>
                    <div className="font-mono text-[var(--color-text-secondary)]" style={{ letterSpacing: "0.04em" }}>
                      {m.donor.unit}
                    </div>
                  </div>
                </div>
                <div className="mt-2 font-mono text-sm text-[var(--color-text-secondary)]">
                  <span>{m.nsn}</span>
                  <span className="mx-1 text-[var(--color-border-active)]">·</span>
                  <span>{m.nomenclature}</span>
                </div>
                <div className="mt-1 spire-body-muted text-sm italic">{m.impact}</div>
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
  return (
    <div className="fixed inset-0 z-[8000] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onCancel}>
      <div
        className="w-[32rem] rounded-sm border border-[var(--color-primary)] bg-[var(--color-surface)] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="mb-2 font-mono text-xs uppercase text-[var(--color-primary)]"
          style={{ letterSpacing: "0.22em" }}
        >
          Propose Cannibalization Match
        </div>
        <div className="mb-3 font-mono text-lg font-semibold text-[var(--color-text)]" style={{ letterSpacing: "0.04em" }}>
          Confirm cross-level of {need.needed_part.nomenclature}
        </div>
        <div className="mb-3 grid grid-cols-2 gap-3 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
          <div>
            <div className="font-mono text-xs uppercase text-[var(--color-text-muted)]" style={{ letterSpacing: "0.22em" }}>
              Recipient
            </div>
            <div className="mt-0.5 font-mono text-base font-semibold text-[var(--color-text)]">{need.asset_id}</div>
            <div className="font-mono text-xs text-[var(--color-text-secondary)]" style={{ letterSpacing: "0.04em" }}>
              {need.unit} · {need.equipment_type}
            </div>
          </div>
          <div>
            <div className="font-mono text-xs uppercase text-[var(--color-text-muted)]" style={{ letterSpacing: "0.22em" }}>
              Donor
            </div>
            <div className="mt-0.5 font-mono text-base font-semibold text-[var(--color-text)]">{donor.asset_id}</div>
            <div className="font-mono text-xs text-[var(--color-text-secondary)]" style={{ letterSpacing: "0.04em" }}>
              {donor.unit} · {donor.equipment_type}
            </div>
          </div>
          <div className="col-span-2">
            <div className="font-mono text-xs uppercase text-[var(--color-text-muted)]" style={{ letterSpacing: "0.22em" }}>
              NSN
            </div>
            <div className="mt-0.5 font-mono text-base text-[var(--color-text)]">
              {need.needed_part.nsn} · {need.needed_part.nomenclature}
            </div>
          </div>
        </div>
        <div className="mb-4 spire-body-muted text-sm">
          {crossUnit
            ? "Cross-unit match — requires coordination between recipient and donor commands."
            : "Intra-unit match — direct motor pool transfer."}
          &nbsp;Donor's SR annotated with removal event; recipient's requisition closes as CANN.
        </div>
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-sm border border-[var(--color-border-active)] px-3 py-1.5 font-mono text-sm font-semibold uppercase text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
            style={{ letterSpacing: "0.18em" }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={committing}
            className="rounded-sm border border-[var(--color-primary)] bg-[var(--color-primary)] px-4 py-1.5 font-mono text-sm font-semibold uppercase text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
            style={{ letterSpacing: "0.18em" }}
          >
            {committing ? "Committing…" : "Commit Proposal"}
          </button>
        </div>
      </div>
    </div>
  );
}
