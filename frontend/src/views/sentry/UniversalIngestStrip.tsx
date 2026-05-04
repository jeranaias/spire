import { Link } from "react-router-dom";
import clsx from "clsx";
import { isDemo } from "../../state/buildMode";

/**
 * Universal Ingest capability strip.
 *
 * Surfaces the breadth of the UIS layer at the SENTRY entry point so a
 * first-time operator sees what SPIRE actually accepts beyond the GCSS-MC
 * narrative the dropzone copy implies. Three rows:
 *
 *   formats   — every parser the pipeline supports (CSV → EDI X12)
 *   sources   — every channel kind that can pull data on its own
 *   adapters  — pre-built canonical mappings + the LLM-assisted custom path
 *
 * Quiet in operational mode (small chips, muted borders, single line of
 * tooltip-only context). Slightly more prominent in demo with hint text.
 *
 * The chips themselves are non-interactive — click targets are limited
 * to (a) channel chips and the resilience footer linking to the admin
 * surfaces, and (b) the "Custom mapping →" CTA. Everything else is
 * informational only; the dropzone below remains the primary action.
 */

type ChipTone = "neutral" | "muted" | "accent";

const FORMATS: { label: string; hint: string }[] = [
  { label: "CSV",         hint: "Auto-detected delimiter, quote rules, encoding (UTF-8 / UTF-16 / latin-1)." },
  { label: "TSV",         hint: "Tab-separated; commented headers + 2-column shapes recognised." },
  { label: "XLSX",        hint: "Excel workbooks; multi-sheet (each sheet runs as its own row stream)." },
  { label: "JSON",        hint: "Single-document or array-of-objects; arbitrary nesting flattened." },
  { label: "JSONL",       hint: "One JSON object per line; keys unioned across rows." },
  { label: "XML",         hint: "Generic XML — XPath-style row selector + attribute / element extraction." },
  { label: "Fixed-width", hint: "Legacy AIS exports; column widths declared per adapter." },
  { label: "EDI X12",     hint: "DLA supply-chain transactions (850 / 856 / 940 / 945)." },
];

type ChannelChip = {
  label: string;
  hint: string;
  to?: string; // /admin/channels deep-link target
};

const CHANNELS: ChannelChip[] = [
  {
    label: "Drop",
    hint: "Drag-drop here, or watch a local directory for new files.",
  },
  {
    label: "SFTP",
    hint: "Pull from a remote SFTP share on a schedule. Vault-backed credentials supported.",
    to: "/admin/channels?kind=sftp",
  },
  {
    label: "IMAP",
    hint: "Watch an inbox; attachments matching configured filters are ingested automatically.",
    to: "/admin/channels?kind=imap",
  },
  {
    label: "HTTP",
    hint: "REST / SOAP polling for systems without a file export. ETag + Last-Modified aware.",
    to: "/admin/channels?kind=http_poll",
  },
  {
    label: "DB CDC",
    hint: "Watermark-polling change-data-capture against a source database (Oracle, PostgreSQL, MSSQL).",
    to: "/admin/channels?kind=db_cdc",
  },
  {
    label: "Kafka",
    hint: "Streaming consumer for Kafka topics; offsets persisted, replay-safe.",
    to: "/admin/channels?kind=kafka_stream",
  },
];

const ADAPTERS: { label: string; hint: string }[] = [
  {
    label: "GCSS-MC ECP",
    hint: "Equipment Custody Program roster — asset master, owning unit, custodian chain.",
  },
  {
    label: "GCSS-MC UTIL",
    hint: "Utilisation extract — operating hours, mileage, fuel burn per asset per period.",
  },
  {
    label: "GCSS-MC SR Header",
    hint: "Service-request header export — open / closed maintenance work, defect codes, downtime.",
  },
  {
    label: "DRRS-MC C-Rating",
    hint: "Defense Readiness Reporting System unit-level readiness ratings (C1 / C2 / C3 / C4).",
  },
];

function Chip({
  label,
  hint,
  tone = "neutral",
  to,
}: {
  label: string;
  hint: string;
  tone?: ChipTone;
  to?: string;
}) {
  const className = clsx(
    "inline-flex items-center rounded-sm border px-2 py-0.5 font-mono text-[11px] tabular-nums leading-tight",
    tone === "neutral" &&
      "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)]",
    tone === "muted" &&
      "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-muted)]",
    tone === "accent" &&
      "border-[color-mix(in_oklab,var(--color-primary)_45%,var(--color-border))] bg-[color-mix(in_oklab,var(--color-primary)_10%,var(--color-surface))] text-[var(--color-text)]",
    to && "hover:border-[var(--color-border-active)] hover:text-[var(--color-text)]",
  );
  if (to) {
    return (
      <Link to={to} title={hint} className={className}>
        {label}
      </Link>
    );
  }
  return (
    <span title={hint} className={className}>
      {label}
    </span>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="w-20 shrink-0 font-mono text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

export function UniversalIngestStrip() {
  const demo = isDemo();
  return (
    <section
      aria-label="Universal Ingest capabilities"
      className="mb-4 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
    >
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
            Universal Ingest
          </span>
          {demo && (
            <span className="text-[11px] text-[var(--color-text-secondary)]">
              SPIRE accepts more than GCSS-MC. Anything below the dotted line of
              "tabular DoD data" lands here.
            </span>
          )}
        </div>
        <Link
          to="/admin/ingest/mapper"
          className="font-mono text-[11px] text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
          title="Auto + LLM-assisted column mapping; save reusable profiles per unit / source."
        >
          Custom mapping →
        </Link>
      </div>

      <div className="flex flex-col gap-1.5">
        <Row label="Formats">
          {FORMATS.map((f) => (
            <Chip key={f.label} label={f.label} hint={f.hint} tone="neutral" />
          ))}
        </Row>
        <Row label="Sources">
          {CHANNELS.map((c) => (
            <Chip
              key={c.label}
              label={c.label}
              hint={c.hint}
              tone={c.to ? "accent" : "neutral"}
              to={c.to}
            />
          ))}
        </Row>
        <Row label="Adapters">
          {ADAPTERS.map((a) => (
            <Chip key={a.label} label={a.label} hint={a.hint} tone="muted" />
          ))}
        </Row>
      </div>

      <div className="mt-2 border-t border-[var(--color-border)] pt-1.5 font-mono text-[10px] text-[var(--color-text-muted)]">
        DLQ + retry / backoff + circuit breaker · audit-chained · byte-bounded ·{" "}
        <Link
          to="/admin/channels"
          className="text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
        >
          channel health →
        </Link>
      </div>
    </section>
  );
}
