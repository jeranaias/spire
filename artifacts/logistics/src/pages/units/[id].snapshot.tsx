import { useState } from "react";
import { useRoute, Link } from "wouter";
import { useGetUnit, getGetUnitQueryKey } from "@workspace/api-client-react";
import { getTier } from "@/components/status-badge";
import { Printer, ArrowLeft, Link2, Check } from "lucide-react";
import { format } from "date-fns";

const CLASS_LABELS: Record<string, string> = {
  I: "Subsistence",
  III: "POL & Power",
  V: "Ammunition",
  VIII: "Medical",
  IX: "Repair Parts",
};

const STATUS_COLORS: Record<string, { bg: string; text: string; border: string; label: string }> = {
  green: { bg: "bg-green-500/10", text: "text-green-600", border: "border-green-500/40", label: "GREEN" },
  amber: { bg: "bg-yellow-500/10", text: "text-yellow-600", border: "border-yellow-500/40", label: "AMBER" },
  red:   { bg: "bg-red-500/10",    text: "text-red-600",    border: "border-red-500/40",    label: "RED"   },
};

function ReadinessBadge({ value }: { value: number }) {
  const tier = getTier(value);
  const colors: Record<string, string> = {
    green: "text-green-600 border-green-500/50 bg-green-500/10",
    amber: "text-yellow-600 border-yellow-500/50 bg-yellow-500/10",
    red:   "text-red-600 border-red-500/50 bg-red-500/10",
  };
  const labels: Record<string, string> = { green: "GREEN", amber: "AMBER", red: "RED" };
  return (
    <span className={`inline-flex items-center gap-1.5 font-mono text-sm border px-2.5 py-1 rounded-sm tabular-nums font-bold ${colors[tier]}`}>
      {value}% · {labels[tier]}
    </span>
  );
}

export default function UnitSnapshot() {
  const [, params] = useRoute("/units/:id/snapshot");
  const unitId = params?.id ?? "";
  const generatedAt = new Date();
  const [copied, setCopied] = useState(false);

  const handleCopyLink = async () => {
    const url = window.location.href;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = url;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard write failed; leave state unchanged
    }
  };

  const { data: unitDetail, isLoading } = useGetUnit(unitId, {
    query: { enabled: !!unitId, queryKey: getGetUnitQueryKey(unitId) },
  });

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center font-mono text-xs tracking-widest text-gray-500">
        Loading…
      </div>
    );
  }

  if (!unitDetail) {
    return (
      <div className="min-h-screen flex items-center justify-center font-mono text-xs text-red-600">
        Unit not found.
      </div>
    );
  }

  const { unit, supplyByClass, entries, upcomingResupply } = unitDetail;

  const dosEntries = (entries ?? []).filter((e) => e.item.supplyClass !== "IX");
  const classIXEntries = (entries ?? [])
    .filter((e) => e.item.supplyClass === "IX")
    .sort((a, b) => a.item.name.localeCompare(b.item.name));

  const topDeficiencies = [...dosEntries]
    .filter((e) => e.shortfall > 0 || e.daysOfSupply < 5)
    .sort((a, b) => a.daysOfSupply - b.daysOfSupply)
    .slice(0, 10);

  const nextResupply = (upcomingResupply ?? [])
    .filter((r) => r.status !== "cancelled" && r.status !== "delivered")
    .sort((a, b) => new Date(a.scheduledFor).getTime() - new Date(b.scheduledFor).getTime())[0];

  return (
    <>
      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { background: white !important; }
          @page { margin: 0.75in; size: Letter; }
        }
      `}</style>

      <div className="min-h-screen bg-white text-gray-900 font-mono">
        {/* Toolbar — hidden on print */}
        <div className="no-print fixed top-0 left-0 right-0 z-10 bg-white border-b border-gray-200 px-6 py-2.5 flex items-center justify-between">
          <Link href={`/units/${unitId}`} className="inline-flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-900 transition-colors tracking-widest uppercase">
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to Unit
          </Link>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopyLink}
              aria-label="Copy report link"
              className={`inline-flex items-center gap-1.5 text-xs font-bold tracking-widest uppercase px-3 py-1.5 border rounded-sm transition-colors ${
                copied
                  ? "border-green-500/50 bg-green-500/10 text-green-700"
                  : "border-gray-300 bg-white text-gray-700 hover:bg-gray-100"
              }`}
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5" />
                  Copied!
                </>
              ) : (
                <>
                  <Link2 className="w-3.5 h-3.5" />
                  Copy Link
                </>
              )}
            </button>
            <button
              onClick={() => window.print()}
              className="inline-flex items-center gap-1.5 text-xs font-bold tracking-widest uppercase px-3 py-1.5 bg-gray-900 text-white rounded-sm hover:bg-gray-700 transition-colors"
            >
              <Printer className="w-3.5 h-3.5" />
              Print / Save PDF
            </button>
          </div>
        </div>

        {/* Report body */}
        <div className="no-print pt-14" />
        <div className="max-w-[820px] mx-auto px-8 py-10 print:px-0 print:py-0">

          {/* ── Header ── */}
          <div className="border-b-2 border-gray-900 pb-4 mb-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-[10px] tracking-[0.3em] uppercase text-gray-400 mb-1">MARLOG · Unit Snapshot Report</div>
                <h1 className="text-2xl font-bold uppercase tracking-[0.12em] leading-tight">{unit.name}</h1>
                {unit.callsign && (
                  <span className="inline-block mt-1 text-[10px] px-2 py-0.5 bg-gray-100 border border-gray-300 rounded-sm tracking-widest">
                    {unit.callsign}
                  </span>
                )}
              </div>
              <div className="text-right shrink-0">
                <div className="text-[10px] text-gray-400 tracking-widest uppercase mb-0.5">Generated</div>
                <div className="text-xs font-bold tabular-nums">{format(generatedAt, "ddHHmm'Z' MMM yy").toUpperCase()}</div>
                <div className="text-[10px] text-gray-400 mt-0.5 tabular-nums">{format(generatedAt, "yyyy-MM-dd HH:mm")}</div>
              </div>
            </div>

            {/* Identity strip */}
            <div className="mt-4 grid grid-cols-4 gap-2 text-[10px]">
              {[
                { label: "Echelon",      value: unit.echelon },
                { label: "Personnel",    value: `${unit.personnel} PAX` },
                { label: "Commander",    value: unit.commander || "—" },
                { label: "Location",     value: unit.location  || "—" },
                { label: "Climate",      value: unit.climate },
                { label: "Op Tempo",     value: unit.opTempo },
                { label: "Mission",      value: `${unit.missionDays}d` },
                { label: "Ammo Posture", value: (unit.ammoPosture ?? "sustain").replace("_", " ") },
                { label: "Unit Type",    value: unit.isGce === false ? "Non-GCE" : "GCE" },
              ].map((f) => (
                <div key={f.label} className="bg-gray-50 border border-gray-200 rounded-sm px-2.5 py-2">
                  <div className="text-gray-400 uppercase tracking-widest mb-0.5">{f.label}</div>
                  <div className="font-bold uppercase text-gray-800">{f.value}</div>
                </div>
              ))}
            </div>
          </div>

          {/* ── Readiness Summary ── */}
          <div className="grid grid-cols-2 gap-4 mb-6">
            <div className="border border-gray-200 rounded-sm p-4">
              <div className="text-[10px] tracking-widest uppercase text-gray-400 mb-2">Combat Readiness</div>
              <div className="mb-2">
                <ReadinessBadge value={unit.readiness} />
              </div>
              {/* Progress bar */}
              <div className="h-2 bg-gray-100 rounded-full overflow-hidden mt-3">
                <div
                  className={`h-full rounded-full ${
                    unit.readiness >= 90 ? "bg-green-500" :
                    unit.readiness >= 60 ? "bg-yellow-500" : "bg-red-500"
                  }`}
                  style={{ width: `${unit.readiness}%` }}
                />
              </div>
            </div>
            <div className="border border-gray-200 rounded-sm p-4 flex flex-col items-center justify-center">
              <div className="text-[10px] tracking-widest uppercase text-gray-400 mb-1">Total Deficiencies</div>
              <div className={`text-5xl font-bold tabular-nums ${unit.deficiencyCount > 0 ? "text-red-600" : "text-green-600"}`}>
                {unit.deficiencyCount}
              </div>
            </div>
          </div>

          {/* ── Days-of-Supply by Class ── */}
          <div className="mb-6">
            <div className="text-[10px] tracking-[0.25em] uppercase text-gray-400 mb-2 font-bold">Days-of-Supply by Class</div>
            <div className="grid grid-cols-5 gap-2">
              {(supplyByClass ?? []).map((cls) => {
                const isRefOnly = cls.supplyClass === "IX";
                const s = isRefOnly
                  ? { bg: "bg-gray-50", text: "text-gray-500", border: "border-gray-200", label: "REF" }
                  : STATUS_COLORS[cls.status] ?? STATUS_COLORS.green;
                const dosDisplay = isRefOnly ? "—" : cls.worstDaysOfSupply >= 999 ? "∞" : cls.worstDaysOfSupply.toFixed(1);
                return (
                  <div key={cls.supplyClass} className={`rounded-sm border p-3 text-center ${s.bg} ${s.border}`}>
                    <div className={`text-[10px] font-bold tracking-widest ${s.text}`}>CL {cls.supplyClass}</div>
                    <div className="text-[9px] text-gray-500 leading-tight mb-1.5">{CLASS_LABELS[cls.supplyClass]}</div>
                    <div className={`text-xl font-bold tabular-nums leading-none ${s.text}`}>{dosDisplay}{!isRefOnly && "d"}</div>
                    <div className={`text-[9px] font-bold tracking-widest mt-1.5 ${s.text}`}>{s.label}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── Top Deficiencies ── */}
          <div className="mb-6">
            <div className="text-[10px] tracking-[0.25em] uppercase text-gray-400 mb-2 font-bold">
              Top Deficiencies {topDeficiencies.length > 0 ? `(${topDeficiencies.length})` : ""}
            </div>
            {topDeficiencies.length === 0 ? (
              <div className="border border-gray-200 rounded-sm px-4 py-6 text-center text-xs text-green-600 font-bold tracking-widest uppercase">
                ■ No Deficiencies — All Classes Adequate
              </div>
            ) : (
              <div className="border border-gray-200 rounded-sm overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="px-3 py-2 text-left text-[10px] tracking-widest uppercase text-gray-400 font-bold">Item</th>
                      <th className="px-3 py-2 text-left text-[10px] tracking-widest uppercase text-gray-400 font-bold">CL</th>
                      <th className="px-3 py-2 text-right text-[10px] tracking-widest uppercase text-gray-400 font-bold">On Hand</th>
                      <th className="px-3 py-2 text-right text-[10px] tracking-widest uppercase text-gray-400 font-bold">Daily Burn</th>
                      <th className="px-3 py-2 text-right text-[10px] tracking-widest uppercase text-gray-400 font-bold">DOS</th>
                      <th className="px-3 py-2 text-right text-[10px] tracking-widest uppercase text-gray-400 font-bold">Shortfall</th>
                      <th className="px-3 py-2 text-center text-[10px] tracking-widest uppercase text-gray-400 font-bold">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {topDeficiencies.map((e) => {
                      const s = STATUS_COLORS[e.status] ?? STATUS_COLORS.green;
                      return (
                        <tr key={e.id}>
                          <td className="px-3 py-2 font-bold">{e.item.name}</td>
                          <td className="px-3 py-2 text-gray-500">{e.item.supplyClass}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{e.onHand} {e.item.unit}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-gray-500">{e.dailyConsumption.toFixed(2)}</td>
                          <td className="px-3 py-2 text-right tabular-nums font-bold">
                            {e.daysOfSupply >= 999 ? "∞" : e.daysOfSupply.toFixed(1)}d
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-red-600 font-bold">
                            {e.shortfall > 0 ? e.shortfall.toFixed(1) : "—"}
                          </td>
                          <td className="px-3 py-2 text-center">
                            <span className={`inline-block px-1.5 py-0.5 rounded-sm text-[9px] font-bold tracking-widest border ${s.bg} ${s.text} ${s.border}`}>
                              {s.label}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ── Next Resupply ── */}
          <div className="mb-6">
            <div className="text-[10px] tracking-[0.25em] uppercase text-gray-400 mb-2 font-bold">Next Scheduled Resupply</div>
            {nextResupply ? (
              <div className="border border-gray-200 rounded-sm p-4 grid grid-cols-4 gap-3 text-[10px]">
                <div>
                  <div className="text-gray-400 uppercase tracking-widest mb-0.5">DTG</div>
                  <div className="font-bold text-sm tabular-nums">
                    {format(new Date(nextResupply.scheduledFor), "ddHHmm'Z' MMM yy").toUpperCase()}
                  </div>
                </div>
                <div>
                  <div className="text-gray-400 uppercase tracking-widest mb-0.5">Class</div>
                  <div className="font-bold uppercase">Class {nextResupply.supplyClass}</div>
                </div>
                <div>
                  <div className="text-gray-400 uppercase tracking-widest mb-0.5">Quantity</div>
                  <div className="font-bold tabular-nums">{nextResupply.quantity} {nextResupply.unit}</div>
                </div>
                <div>
                  <div className="text-gray-400 uppercase tracking-widest mb-0.5">Status</div>
                  <div className="font-bold uppercase">{nextResupply.status.replace("_", " ")}</div>
                </div>
                {nextResupply.assignedTo && (
                  <div className="col-span-2">
                    <div className="text-gray-400 uppercase tracking-widest mb-0.5">Assigned To</div>
                    <div className="font-bold">{nextResupply.assignedTo}</div>
                  </div>
                )}
                {nextResupply.itemName && (
                  <div className="col-span-2">
                    <div className="text-gray-400 uppercase tracking-widest mb-0.5">Item</div>
                    <div className="font-bold">{nextResupply.itemName}</div>
                  </div>
                )}
              </div>
            ) : (
              <div className="border border-gray-200 rounded-sm px-4 py-4 text-xs text-gray-400 font-mono tracking-widest uppercase">
                No resupply scheduled.
              </div>
            )}
          </div>

          {/* ── Class IX (Repair Parts) — Reference Only ── */}
          <div className="mb-6">
            <div className="flex items-baseline justify-between mb-2">
              <div className="text-[10px] tracking-[0.25em] uppercase text-gray-400 font-bold">
                Class IX — Repair Parts (Reference)
              </div>
              <div className="text-[9px] tracking-widest uppercase text-gray-400">
                Reference only · not included in DOS scoring
              </div>
            </div>
            {classIXEntries.length === 0 ? (
              <div className="border border-gray-200 rounded-sm px-4 py-4 text-xs text-gray-400 font-mono tracking-widest uppercase">
                No Class IX items recorded.
              </div>
            ) : (
              <div className="border border-gray-200 rounded-sm overflow-hidden bg-gray-50/40">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="px-3 py-2 text-left text-[10px] tracking-widest uppercase text-gray-400 font-bold">Item</th>
                      <th className="px-3 py-2 text-left text-[10px] tracking-widest uppercase text-gray-400 font-bold">NSN</th>
                      <th className="px-3 py-2 text-right text-[10px] tracking-widest uppercase text-gray-400 font-bold">On Hand</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {classIXEntries.map((e) => (
                      <tr key={e.id}>
                        <td className="px-3 py-2 font-bold text-gray-700">{e.item.name}</td>
                        <td className="px-3 py-2 text-gray-500 tabular-nums">{e.item.nsn || "—"}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-gray-700">
                          {Number.isInteger(e.onHand) ? e.onHand : Number(e.onHand.toFixed(2))}{" "}
                          <span className="text-gray-400">{e.item.unit}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="px-3 py-2 border-t border-gray-200 text-[9px] tracking-widest uppercase text-gray-400 italic">
                  Repair parts are consumed per-failure, not per-day. They do not affect the readiness badge or deficiency count.
                </div>
              </div>
            )}
          </div>

          {/* ── Footer ── */}
          <div className="border-t border-gray-200 pt-3 flex items-center justify-between text-[9px] text-gray-400 tracking-widest uppercase">
            <span>MARLOG · Marine Logistics Calculator</span>
            <span>Generated {format(generatedAt, "yyyy-MM-dd HH:mm:ss")}</span>
            <span>Read-only snapshot — do not use as an authoritative record</span>
          </div>
        </div>
      </div>
    </>
  );
}
