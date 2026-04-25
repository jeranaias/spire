import clsx from "clsx";
import type { HeatmapUnit } from "../api";

interface Props {
  units: HeatmapUnit[];
  equipmentTypes: string[];
  onCellClick?: (unit: string, equipment: string) => void;
}

function colorForRate(rate: number | null): string {
  if (rate == null) return "bg-[var(--color-bg)] text-[var(--color-text-muted)]";
  if (rate >= 0.90) return "bg-[color-mix(in_oklab,var(--color-success)_35%,var(--color-surface))] text-[var(--color-success)]";
  if (rate >= 0.75) return "bg-[color-mix(in_oklab,var(--color-warning)_30%,var(--color-surface))] text-[var(--color-warning)]";
  if (rate >= 0.60) return "bg-[color-mix(in_oklab,#fb923c_30%,var(--color-surface))] text-[#fb923c]";
  return "bg-[color-mix(in_oklab,var(--color-danger)_35%,var(--color-surface))] text-[var(--color-danger)]";
}

export function Heatmap({ units, equipmentTypes, onCellClick }: Props) {
  return (
    <div className="overflow-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
      <table className="w-full border-collapse font-mono text-xs">
        <thead>
          <tr className="sticky top-0 bg-[var(--color-surface)] text-[var(--color-text-muted)]">
            <th className="sticky left-0 z-10 border-b border-r border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-left font-medium">
              Unit
            </th>
            {equipmentTypes.map((eq) => (
              <th
                key={eq}
                className="border-b border-[var(--color-border)] px-2 py-2 text-center font-medium"
                title={eq}
              >
                {eq.replace("_", " ")}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {units.map((u) => (
            <tr key={u.uic} className="hover:bg-[var(--color-surface-hover)]">
              <td className="sticky left-0 z-10 border-r border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
                <div className="font-sans font-medium text-[var(--color-text)]">{u.unit}</div>
                <div className="text-xs text-[var(--color-text-muted)]">
                  {u.location}
                </div>
              </td>
              {equipmentTypes.map((eq) => {
                const rate = u.rates[eq];
                const count = u.equipment_breakdown[eq] || 0;
                return (
                  <td
                    key={eq}
                    className={clsx(
                      "border border-[var(--color-border)] text-center",
                      colorForRate(rate),
                      rate != null && onCellClick && "cursor-pointer transition-all hover:brightness-125",
                    )}
                    onClick={() => rate != null && onCellClick?.(u.unit, eq)}
                    title={rate != null ? `${u.unit} / ${eq}: ${(rate * 100).toFixed(1)}% MC (${count} assets)` : `${u.unit} has no ${eq}`}
                  >
                    <div className="px-1 py-2 tabular-nums">
                      {rate != null ? `${Math.round(rate * 100)}` : "—"}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
