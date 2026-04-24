import { useEffect, useState } from "react";
import { api, type Cannibalization } from "../../api";
import { LoadingOverlay } from "./FleetOverviewTab";
import { useSpireStore } from "../../state/store";

export function CannibalizationTab() {
  const role = useSpireStore((s) => s.role);
  const [data, setData] = useState<Cannibalization | null>(null);

  useEffect(() => {
    setData(null);
    api.pulse.cannibalization().then(setData);
  }, [role]);

  if (!data) return <LoadingOverlay message="Matching needs with donors ..." />;

  return (
    <div className="flex h-full overflow-hidden">
      <section className="flex w-1/2 flex-col overflow-y-auto border-r border-[var(--color-border)] p-4">
        <div className="mb-3">
          <h3 className="text-sm font-semibold">Needs — open NMCS assets ({data.open_needs.length})</h3>
          <div className="text-xs text-[var(--color-text-muted)]">
            Deadlined assets with un-received parts. Source: canonical dataset.
          </div>
        </div>
        <div className="flex flex-col gap-2">
          {data.open_needs.map((n: any) => (
            <div key={n.sr_number} className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
              <div className="flex items-baseline justify-between">
                <div>
                  <div className="font-mono text-sm font-semibold">{n.asset_id}</div>
                  <div className="text-xs text-[var(--color-text-muted)]">
                    {n.equipment_type} · {n.unit} · open {n.days_open}d · fault: {n.fault_component}
                  </div>
                </div>
                <span className="rounded-sm bg-[var(--color-danger-muted)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-danger)]">
                  NMCS
                </span>
              </div>
              <div className="mt-2 flex items-center gap-3 text-xs">
                <span className="font-mono text-[var(--color-text)]">{n.needed_part.nsn}</span>
                <span className="text-[var(--color-text-secondary)]">{n.needed_part.nomenclature}</span>
                <span className="ml-auto text-[var(--color-text-muted)]">${n.needed_part.unit_cost}</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="flex w-1/2 flex-col overflow-y-auto p-4">
        <div className="mb-3">
          <h3 className="text-sm font-semibold">
            Completed matches ({data.total_events}) — engine-verified
          </h3>
          <div className="text-xs text-[var(--color-text-muted)]">
            Cross-unit cannibalizations executed by PULSE's matcher. Donor SR annotated with removal event.
          </div>
        </div>
        <div className="flex flex-col gap-2">
          {data.completed_matches.map((m: any) => (
            <div
              key={m.event_id}
              className="rounded-md border border-[var(--color-success-muted)] bg-[color-mix(in_oklab,var(--color-success-muted)_10%,var(--color-surface))] p-3"
            >
              <div className="flex items-baseline justify-between">
                <div className="font-mono text-sm font-semibold">{m.event_id}</div>
                <span className="font-mono text-xs text-[var(--color-text-muted)]">{m.event_date}</span>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">Recipient</div>
                  <div className="font-mono text-[var(--color-text)]">{m.recipient.asset_id}</div>
                  <div className="text-[var(--color-text-secondary)]">{m.recipient.unit}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">Donor</div>
                  <div className="font-mono text-[var(--color-text)]">{m.donor.asset_id}</div>
                  <div className="text-[var(--color-text-secondary)]">{m.donor.unit}</div>
                </div>
              </div>
              <div className="mt-2 text-xs text-[var(--color-text-secondary)]">
                <span className="font-mono">{m.nsn}</span> · {m.nomenclature}
              </div>
              <div className="mt-1 text-[11px] italic text-[var(--color-text-muted)]">{m.impact}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
