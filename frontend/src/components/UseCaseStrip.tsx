/**
 * UseCaseStrip — MDM 2026 stage-pivot.
 *
 * A thin (h-9) banner that appears at the top of a top-level view body
 * ONLY when the Zustand store is in `stageMode`. The strip orients the
 * audience inside the use-case story arc (01 SENTRY → 02 PULSE → 03
 * BASTION → 04 DHA RESCUE) without disturbing operator chrome.
 *
 * The component is render-noop outside stage mode so individual views
 * can include it unconditionally — no `if (stageMode)` ceremony in each
 * view file. Accent colour matches the StageGrid tile rail in
 * `DecisionBridge.tsx` so the visual language is consistent end-to-end.
 */
import { useSpireStore } from "../state/store";

interface UseCaseStripProps {
  number: string;     // "01"
  title: string;      // "SENTRY"
  subtitle: string;   // "Classification & coalition release"
  accent: string;     // CSS var, e.g. "var(--color-info)"
}

export function UseCaseStrip({ number, title, subtitle, accent }: UseCaseStripProps) {
  const stageMode = useSpireStore((s) => s.stageMode);
  if (!stageMode) return null;
  return (
    <div
      role="region"
      aria-label={`Stage use-case ${number} · ${title}`}
      className="relative flex h-9 shrink-0 items-center gap-3 border-b px-4"
      style={{
        borderBottomColor: "color-mix(in oklab, " + accent + " 35%, var(--color-border))",
        background:
          "linear-gradient(90deg, color-mix(in oklab, " + accent + " 12%, var(--color-surface)) 0%, var(--color-surface) 70%)",
      }}
    >
      <span
        className="font-mono text-sm font-semibold tabular-nums"
        style={{ color: accent }}
        aria-hidden
      >
        {number}
      </span>
      <span className="font-mono text-[11px] uppercase tracking-[0.22em] text-[var(--color-text)]">
        USE CASE {number} · {title}
      </span>
      <span className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-text-muted)]">
        {subtitle}
      </span>
    </div>
  );
}
