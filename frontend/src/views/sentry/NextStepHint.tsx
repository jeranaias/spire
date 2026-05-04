import { Link } from "react-router-dom";
import clsx from "clsx";

/**
 * Compact "where does this tab feed?" footer chip strip.
 *
 * The SENTRY pipeline's tabs are independently functional, but the
 * cross-tab narrative was weak — finishing Review Queue or Mark Draft
 * left the operator with no signal about whether to head to Export or
 * Coalition next, and downstream tabs had no signal about whether the
 * artifact they produced was the end of the line or a hand-off into
 * another stage.
 *
 * NextStepHint paints a single muted line at the bottom of a tab with
 * one or more "→ next: X" links. The link target is a NavLink-style
 * route; the trailing arrow is decorative. External hand-offs (e.g.
 * "→ hand bundle to receiving partner") render as plain text in the
 * same line.
 */

export type NextStep =
  | { kind: "tab"; to: string; label: string; hint?: string }
  | { kind: "external"; label: string; hint?: string };

export function NextStepHint({
  steps,
  className,
}: {
  steps: NextStep[];
  className?: string;
}) {
  if (steps.length === 0) return null;
  return (
    <div
      className={clsx(
        "mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] pt-2 font-mono text-[11px] text-[var(--color-text-muted)]",
        className,
      )}
    >
      <span className="uppercase tracking-widest">Next</span>
      {steps.map((s, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <span aria-hidden>·</span>}
          {s.kind === "tab" ? (
            <Link
              to={s.to}
              className="text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
              title={s.hint}
            >
              {s.label} →
            </Link>
          ) : (
            <span title={s.hint}>{s.label}</span>
          )}
        </span>
      ))}
    </div>
  );
}
