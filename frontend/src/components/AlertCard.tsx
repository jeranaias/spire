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

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  } catch {
    return iso;
  }
}

export function AlertCard({ severity, source, title, body, timestamp, onClick, actionLabel }: Props) {
  const style = SEVERITY_STYLE[severity] || SEVERITY_STYLE.INFO;
  const dot = SEVERITY_DOT[severity] || SEVERITY_DOT.INFO;

  return (
    <div
      className={clsx(
        "rounded-sm border border-[var(--color-border)] border-l-4 p-3 transition-all",
        style,
        onClick && "cursor-pointer hover:border-[var(--color-border-active)]",
      )}
      onClick={onClick}
    >
      <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
        <span className={clsx("h-2 w-2 rounded-full", dot)} />
        <span className="font-semibold">{severity}</span>
        {source && <span>· {source}</span>}
        <span className="ml-auto font-mono tabular-nums">{formatTime(timestamp)}</span>
      </div>
      <div className="mb-1 text-sm font-medium text-[var(--color-text)]">{title}</div>
      <div className="text-xs leading-snug text-[var(--color-text-secondary)]">{body}</div>
      {actionLabel && (
        <div className="mt-2 text-[11px] font-medium text-[var(--color-primary)] hover:underline">
          {actionLabel} →
        </div>
      )}
    </div>
  );
}
