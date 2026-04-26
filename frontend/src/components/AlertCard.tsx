import clsx from "clsx";

interface Props {
  severity: string;
  source?: string;
  title: string;
  body: string;
  timestamp: string;
  onClick?: () => void;
  actionLabel?: string;
}

const SEVERITY_STYLE: Record<string, string> = {
  CRITICAL: "border-l-[var(--color-danger)] bg-[color-mix(in_oklab,var(--color-danger-muted)_10%,var(--color-surface))]",
  HIGH:     "border-l-[var(--color-danger)] bg-[var(--color-surface)]",
  MODERATE: "border-l-[var(--color-warning)] bg-[var(--color-surface)]",
  LOW:      "border-l-[var(--color-success)] bg-[var(--color-surface)]",
  INFO:     "border-l-[var(--color-primary)] bg-[var(--color-surface)]",
};

const SEVERITY_DOT: Record<string, string> = {
  CRITICAL: "bg-[var(--color-danger)] animate-pulse",
  HIGH:     "bg-[var(--color-danger)]",
  MODERATE: "bg-[var(--color-warning)]",
  LOW:      "bg-[var(--color-success)]",
  INFO:     "bg-[var(--color-primary)]",
};

function formatTime(iso: string): { text: string; synthetic: boolean } {
  try {
    const d = new Date(iso);
    const now = Date.now();
    const diffSec = Math.floor((now - d.getTime()) / 1000);
    // Dataset is synthetic; timestamps can live in the future relative to the
    // real wall clock. Surface a SYNTH chip on those rows so operators don't
    // see "MAY 30" next to a Mission Clock reading "26 APR 26" and lose
    // trust. Reviewer caught the date drift and asked for explicit labelling
    // (alternative was rebasing synthetic, which we keep as future work).
    if (diffSec < 0) {
      // Walkthrough audit: locale was [] (browser default), which on
      // an Arabic-locale workstation rendered '٢٧ أبريل' next to the
      // English UI. SPIRE is a US military product — pin to en-US.
      return {
        text: d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }),
        synthetic: true,
      };
    }
    if (diffSec < 60)    return { text: `${diffSec}s ago`, synthetic: false };
    if (diffSec < 3600)  return { text: `${Math.floor(diffSec / 60)}m ago`, synthetic: false };
    if (diffSec < 86400) return { text: `${Math.floor(diffSec / 3600)}h ago`, synthetic: false };
    if (diffSec < 604800) return { text: `${Math.floor(diffSec / 86400)}d ago`, synthetic: false };
    return { text: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }), synthetic: false };
  } catch {
    return { text: iso, synthetic: false };
  }
}

export function AlertCard({ severity, source, title, body, timestamp, onClick, actionLabel }: Props) {
  const style = SEVERITY_STYLE[severity] || SEVERITY_STYLE.INFO;
  const dot = SEVERITY_DOT[severity] || SEVERITY_DOT.INFO;
  const ts = formatTime(timestamp);

  return (
    <div
      className={clsx(
        "rounded-sm border border-[var(--color-border)] border-l-4 p-3 transition-all",
        style,
        onClick && "cursor-pointer hover:border-[var(--color-border-active)]",
      )}
      onClick={onClick}
    >
      <div className="mb-1 flex items-center gap-2 text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
        <span className={clsx("h-2 w-2 rounded-full", dot)} />
        <span className="font-semibold">{severity}</span>
        {source && <span>· {source}</span>}
        <span className="ml-auto flex items-center gap-1.5">
          {ts.synthetic && (
            <span
              className="rounded-sm border border-[var(--color-warning-muted)] px-1 py-[1px] font-mono text-[10px] uppercase text-[var(--color-warning)] tracking-widest"
              title="Synthetic dataset · timestamp ahead of live wall clock"
            >
              SYNTH
            </span>
          )}
          <span className="font-mono tabular-nums">{ts.text}</span>
        </span>
      </div>
      <div className="mb-1 text-sm font-medium text-[var(--color-text)]">{title}</div>
      <div className="text-xs leading-snug text-[var(--color-text-secondary)]">{body}</div>
      {actionLabel && (
        <div className="mt-2 text-sm font-medium text-[var(--color-primary)] hover:underline">
          {actionLabel} →
        </div>
      )}
    </div>
  );
}
