import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import type { HeatmapUnit } from "../api";

interface Props {
  units: HeatmapUnit[];
  equipmentTypes: string[];
  onCellClick?: (unit: string, equipment: string) => void;
}

function colorForRate(rate: number | null): string {
  if (rate == null) return "bg-[var(--color-bg)] text-[var(--color-text-muted)]";
  // Walkthrough #31, #32 — text colors set with high contrast against the
  // colored background. Previous mix used the same hue for both the
  // background and the text, leaving some cells effectively invisible.
  if (rate >= 0.90) return "bg-[color-mix(in_oklab,var(--color-success)_40%,var(--color-surface))] text-white";
  if (rate >= 0.75) return "bg-[color-mix(in_oklab,var(--color-warning)_40%,var(--color-surface))] text-black";
  if (rate >= 0.60) return "bg-[color-mix(in_oklab,#fb923c_40%,var(--color-surface))] text-black";
  return "bg-[color-mix(in_oklab,var(--color-danger)_45%,var(--color-surface))] text-white";
}

// Walkthrough #47 — color-blind affordance: a small glyph per severity band
// supplements the color so red/green-blind operators read the same severity.
function severityGlyph(rate: number | null): string {
  if (rate == null) return "";
  if (rate >= 0.90) return "●";    // good
  if (rate >= 0.75) return "▲";    // moderate
  if (rate >= 0.60) return "◆";    // warning
  return "■";                       // critical
}

export function Heatmap({ units, equipmentTypes, onCellClick }: Props) {
  // Walkthrough #15 — scroll-affordance: track scroll position so we can
  // render a fade-gradient on the right edge when more columns exist
  // off-screen.
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [hasOverflowRight, setHasOverflowRight] = useState(false);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    function update() {
      const elNow = scrollerRef.current;
      if (!elNow) return;
      const more = elNow.scrollWidth - elNow.clientWidth - elNow.scrollLeft > 8;
      setHasOverflowRight(more);
    }
    update();
    el.addEventListener("scroll", update);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [equipmentTypes.length]);

  return (
    // overflow-x-auto + always-visible scrollbar so the rightmost
    // equipment-type columns never disappear off-screen on narrow widths.
    <div className="relative">
      <div
        ref={scrollerRef}
        className="overflow-x-auto overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]"
        style={{ scrollbarGutter: "stable", maxHeight: "calc(100vh - 18rem)" }}
      >
        <table className="min-w-max border-collapse font-mono text-xs">
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
                  const glyph = severityGlyph(rate);
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
                      {/* Walkthrough #31 — every populated cell shows its number.
                       * Walkthrough #47 — glyph is a non-color severity carrier. */}
                      <div className="flex items-center justify-center gap-1 px-1 py-2 tabular-nums font-semibold">
                        {rate != null ? (
                          <>
                            <span aria-hidden style={{ opacity: 0.85 }}>{glyph}</span>
                            <span>{(rate * 100).toFixed(1)}</span>
                          </>
                        ) : (
                          "—"
                        )}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Walkthrough #15 — chevron + shadow gradient hint when more columns
       * exist off-screen to the right. Disappears once the user scrolls. */}
      {hasOverflowRight && (
        <div
          className="pointer-events-none absolute inset-y-0 right-0 flex w-12 items-center justify-end pr-2"
          style={{
            background: "linear-gradient(90deg, transparent 0%, color-mix(in oklab, var(--color-bg) 75%, transparent) 100%)",
          }}
          aria-hidden
        >
          <span className="font-mono text-lg text-[var(--color-text-muted)]">›</span>
        </div>
      )}
    </div>
  );
}
