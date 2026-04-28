/**
 * DatasetBadge — frozen-snapshot honesty pill.
 *
 * When a tile/section renders rows derived from a `dataset_day` (the
 * snapshot date frozen in the dataset), we owe the operator an explicit
 * "AS OF" pill instead of letting the live DTG ticker imply the readout
 * is real-time. Tone scales with how stale the dataset is relative to
 * wall-clock now:
 *   < 24h        → muted    (fresh enough to read at face value)
 *   24h ≤ Δ < 72h → warning (stale; trust but verify)
 *   ≥ 72h        → danger  (do not act on this without a sync)
 *
 * Originally lived in DecisionBridge.tsx alongside the FPCON/MC% tiles
 * (Task #47). Task #127 extracts it to a shared component so BASTION
 * and the PULSE surfaces can stamp the same badge in their own
 * tile/section headers — a judge drilling from the bridge into PULSE
 * Risk Board or BASTION should not lose the freshness cue.
 */

/** Parse `YYYY-MM-DD` (or an ISO datetime starting with one) to UTC midnight; null if unparseable. */
export function parseDatasetDay(s: string | null | undefined): Date | null {
  if (!s) return null;
  // ISO yyyy-mm-dd; parse as UTC midnight so tone math doesn't drift across TZs.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Render `2026-04-26` as `26APR26` matching the BASTION DTG style. */
export function formatDatasetDay(s: string | null | undefined): string | null {
  const d = parseDatasetDay(s);
  if (!d) return null;
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase();
  const yy = String(d.getUTCFullYear()).slice(2);
  return `${dd}${month}${yy}`;
}

/** Tone for the AS-OF badge given the dataset day. */
export function datasetBadgeTone(s: string | null | undefined): { fg: string; border: string } {
  const d = parseDatasetDay(s);
  if (!d) return { fg: "var(--color-text-muted)", border: "var(--color-border)" };
  const ageHours = (Date.now() - d.getTime()) / 3_600_000;
  if (ageHours >= 72) {
    return { fg: "var(--color-danger)", border: "var(--color-danger)" };
  }
  if (ageHours >= 24) {
    return { fg: "var(--color-warning)", border: "var(--color-warning)" };
  }
  return { fg: "var(--color-text-muted)", border: "var(--color-border)" };
}

/**
 * Inline pill for tile/section headers: "AS OF 26APR26", colored by
 * staleness. Renders nothing if the source has no dataset_day (tolerant:
 * better to omit than to lie about how fresh the data is).
 */
export function DatasetBadge({ day }: { day: string | null | undefined }) {
  const label = formatDatasetDay(day);
  if (!label) return null;
  const tone = datasetBadgeTone(day);
  return (
    <span
      className="rounded-sm border px-1.5 py-[1px] font-mono text-[9px] font-semibold tracking-widest"
      style={{ color: tone.fg, borderColor: tone.border }}
      title={`Snapshot date: ${day} — rows are computed from this dataset, not live telemetry`}
    >
      AS OF {label}
    </span>
  );
}
