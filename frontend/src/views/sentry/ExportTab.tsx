import { useState } from "react";
import { api, type ExportResult } from "../../api";
import type { SentryContext } from "../SentryView";
import { SegmentedControl } from "../../components/SegmentedControl";
import { useSpireStore } from "../../state/store";
import { InsufficientPrivilege } from "../../components/InsufficientPrivilege";

const AUTHORITIES = [
  { value: "US_ONLY",  label: "U.S. Only" },
  { value: "FVEY",     label: "FVEY" },
  { value: "NATO",     label: "NATO" },
  { value: "SPECIFIC", label: "Partner" },
] as const;

const FORMATS = [
  { value: "xlsx", label: "XLSX" },
  { value: "csv",  label: "CSV" },
  { value: "json", label: "JSON" },
] as const;

type Authority = typeof AUTHORITIES[number]["value"];
type Format    = typeof FORMATS[number]["value"];

export function ExportTab({ ctx }: { ctx: SentryContext }) {
  const role = useSpireStore((s) => s.role);
  const [authority, setAuthority] = useState<Authority>("US_ONLY");
  const [format, setFormat] = useState<Format>("xlsx");
  const [includeAudit, setIncludeAudit] = useState(true);
  const [result, setResult] = useState<(ExportResult & { sample_diffs?: DiffSample[] }) | null>(null);
  const [loading, setLoading] = useState(false);
  const pushToast = useSpireStore((s) => s.pushToast);

  if (role !== "data_custodian" && role !== "security_manager") {
    return (
      <InsufficientPrivilege
        feature="Sanitized Export"
        requiredRoles={["data_custodian", "security_manager"]}
        description="Release packaging of sanitized records requires Data Custodian or Security Manager authorization."
      />
    );
  }

  async function doExport() {
    setLoading(true);
    try {
      // Walkthrough #6 — pass batchId so the export covers the same batch
      // the operator just processed.
      const r = await api.sentry.export(authority, format, ctx.batchId);
      setResult(r as any);
      // Toast carries a click-through link so the operator never wonders
      // "where did the file go?" after a successful export. Reviewer caught
      // the celebratory toast having no destination.
      pushToast({
        tone: "ok",
        text: `✓ Export ${r.export_id} · ${(r.records_exported ?? 0).toLocaleString("en-US")} records · ${((r.bytes ?? 0) / 1024).toFixed(1)} KB`,
        link: r.download_url ? { label: "Download", href: r.download_url } : undefined,
        ttlMs: 6000,
      });
    } catch (err) {
      pushToast({ tone: "error", text: "Export failed" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-6">
      <div className="mb-4">
        <h2
          className="font-mono text-base font-semibold uppercase text-[var(--color-text)] tracking-widest"
        >
          Export Sanitized Dataset
        </h2>
        <div className="mt-1 spire-body-muted">
          Release-authority selection adjusts sanitization rules. A NATO release, for example, further
          generalizes unit designators and strips REL TO USA-only markings.
        </div>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-6">
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <h4
            className="mb-3 font-mono text-xs font-semibold uppercase text-[var(--color-text-muted)] tracking-widest"
          >
            Release Authority
          </h4>
          <SegmentedControl
            value={authority}
            options={AUTHORITIES.map((a) => ({ value: a.value, label: a.label }))}
            onChange={setAuthority}
          />
          <div className="mt-3 font-mono text-xs text-[var(--color-text-muted)] tracking-wide">
            {DISTRIBUTION_BLURB[authority]}
          </div>
        </div>

        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <h4
            className="mb-3 font-mono text-xs font-semibold uppercase text-[var(--color-text-muted)] tracking-widest"
          >
            Format + Options
          </h4>
          <SegmentedControl
            value={format}
            options={FORMATS.map((f) => ({ value: f.value, label: f.label }))}
            onChange={setFormat}
          />
          <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={includeAudit}
              onChange={() => setIncludeAudit(!includeAudit)}
              className="accent-[var(--color-primary)]"
            />
            <span className="spire-body">Include append-only audit log (SHA-256 chained)</span>
          </label>
          <div className="mt-2 font-mono text-xs text-[var(--color-text-muted)] tracking-wide">
            Recommended on — lets the receiving partner verify provenance without re-inspecting every record.
          </div>
        </div>
      </div>

      <div>
        <button
          onClick={doExport}
          disabled={loading || !ctx.batchId}
          className="rounded-sm border border-[var(--color-success)] bg-[var(--color-success)] px-6 py-2 font-mono text-base font-semibold uppercase text-white hover:brightness-110 disabled:opacity-50 tracking-widest"
        >
          {loading ? "Building bundle …" : "Export Sanitized Bundle"}
        </button>
        {!ctx.batchId && (
          <span className="ml-3 font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
            Requires a processed batch.
          </span>
        )}
      </div>

      {result && (
        <div className="mt-6 rounded-md border border-[var(--color-success-muted)] bg-[color-mix(in_oklab,var(--color-success-muted)_15%,var(--color-surface))] p-4">
          <div className="mb-3 flex items-baseline justify-between">
            <h4
              className="font-mono text-base font-semibold uppercase text-[var(--color-success)] tracking-widest"
            >
              Export Prepared
            </h4>
            <span className="font-mono text-xs text-[var(--color-text-muted)] tracking-wide">
              {result.created_at}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {/* Walkthrough #6 — show input count next to exported count so
                the operator sees exactly which records the bundle covers. */}
            {result.records_input != null && (
              <Stat label="Records In Batch" value={result.records_input.toLocaleString("en-US")} />
            )}
            <Stat label="Records Exported" value={(result.records_exported ?? 0).toLocaleString("en-US")} />
            <Stat label="Rejected"          value={(result.records_rejected ?? 0).toLocaleString("en-US")} />
            <Stat label="Decisions Applied" value={`${result.decisions_applied ?? 0}`} />
            <Stat label="Redactions Applied" value={`${result.redactions_applied ?? 0}`} />
            {/* Walkthrough #5 — Distribution Statement and REL TO are
                independent fields. Render side-by-side. */}
            <div>
              <StatLabel>Distribution Authority</StatLabel>
              <div className="font-mono text-sm text-[var(--color-text)]">
                {result.distribution_authority ?? "—"}
              </div>
              <div className="text-xs text-[var(--color-text-secondary)]">
                Controls who can access (DoDI 5230.24).
              </div>
            </div>
            <div>
              <StatLabel>REL TO Caveat</StatLabel>
              <div className="font-mono text-sm text-[var(--color-text)]">
                {result.rel_to_caveat || "(no foreign release)"}
              </div>
              <div className="text-xs text-[var(--color-text-secondary)]">
                Controls which foreign nationals may receive.
              </div>
            </div>
            <div className="col-span-2">
              <StatLabel>Distribution Statement (full)</StatLabel>
              <div className="spire-body-muted">{result.distribution_statement}</div>
            </div>
            <div className="col-span-2">
              <StatLabel>Download</StatLabel>
              <a
                href={result.download_url}
                className="font-mono text-base text-[var(--color-primary)] hover:underline"
              >
                {result.download_url}
              </a>
              {result.bytes != null && (
                <span className="ml-2 font-mono text-xs text-[var(--color-text-muted)]">
                  ({(result.bytes / 1024).toFixed(1)} KB)
                </span>
              )}
            </div>
          </div>

          {result.sample_diffs && result.sample_diffs.length > 0 && (
            <SampleDiffPanel diffs={result.sample_diffs} />
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sample-record diff accordion — shows operators exactly what the sanitizer
// did rather than making them trust a single `redactions_applied: 875` number.
// ---------------------------------------------------------------------------

type DiffSample = {
  sr_number: string;
  unit_name: string;
  equipment_type: string;
  flags: string[];
  original: string;
  sanitized: string;
  // Walkthrough #1 — backend returns explicit per-span before/after so
  // the right pane renders the actual redacted output, not source-with-badge.
  removed_spans?: {
    start: number;
    end: number;
    before: string;
    after: string;
    category?: string;
    rule?: string;
  }[];
};

const FLAG_COLOR: Record<string, string> = {
  pii: "var(--color-info)",
  geo: "var(--color-primary)",
  comms: "var(--color-warning)",
  classified: "var(--color-danger)",
  controlled: "#fb923c",
};

function SampleDiffPanel({ diffs }: { diffs: DiffSample[] }) {
  const [expanded, setExpanded] = useState<string | null>(diffs[0]?.sr_number ?? null);
  return (
    <div className="mt-4 border-t border-[var(--color-border)] pt-4">
      <div
        className="mb-2 font-mono text-xs font-semibold uppercase text-[var(--color-text-muted)] tracking-widest"
      >
        Before / After · {diffs.length} Sample Records
      </div>
      <div className="flex flex-col gap-2">
        {diffs.map((d) => {
          const open = expanded === d.sr_number;
          return (
            <div
              key={d.sr_number}
              className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)]"
            >
              <button
                onClick={() => setExpanded(open ? null : d.sr_number)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left"
              >
                <span className="font-mono text-sm text-[var(--color-text)]">{d.sr_number}</span>
                <span className="font-mono text-xs text-[var(--color-text-muted)] tracking-wide">
                  {d.unit_name} · {d.equipment_type}
                </span>
                <div className="ml-auto flex items-center gap-1">
                  {d.flags.map((f) => (
                    <span
                      key={f}
                      className="rounded-sm border px-1 py-[1px] font-mono text-xs font-semibold uppercase tracking-wider"
                      style={{
                        color: FLAG_COLOR[f] || "var(--color-text-muted)",
                        borderColor: `color-mix(in oklab, ${FLAG_COLOR[f] || "#666"} 40%, var(--color-border))`,
                      }}
                    >
                      {f}
                    </span>
                  ))}
                  <span className="ml-1 font-mono text-[var(--color-text-muted)]">{open ? "▾" : "▸"}</span>
                </div>
              </button>
              {open && (
                <div className="grid grid-cols-2 gap-0 border-t border-[var(--color-border)]">
                  <div className="border-r border-[var(--color-border)] p-3">
                    <div
                      className="mb-1 font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest"
                    >
                      Original
                    </div>
                    <div className="font-mono text-base leading-relaxed text-[var(--color-text)]">
                      {/* Walkthrough #1 — annotate the original with strike-
                          through on the spans the redactor will remove. */}
                      <OriginalWithMarkedSpans
                        original={d.original}
                        spans={d.removed_spans ?? []}
                      />
                    </div>
                  </div>
                  <div className="p-3">
                    <div
                      className="mb-1 font-mono text-xs uppercase text-[var(--color-success)] tracking-widest"
                    >
                      Sanitized · Export Bundle
                    </div>
                    <div className="font-mono text-base leading-relaxed text-[var(--color-text)]">
                      {/* Walkthrough #1 — render the ACTUAL sanitized string
                          with replacement tokens highlighted. Never just the
                          source-with-badge fallback. */}
                      <SanitizedRendered sanitized={d.sanitized} />
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Walkthrough #1 — left pane (original) with strike-through on the spans
// the redactor will remove.
function OriginalWithMarkedSpans({
  original,
  spans,
}: {
  original: string;
  spans: NonNullable<DiffSample["removed_spans"]>;
}) {
  if (!spans || spans.length === 0) return <>{original}</>;
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const out: React.ReactNode[] = [];
  let cursor = 0;
  for (let i = 0; i < sorted.length; i++) {
    const sp = sorted[i];
    if (sp.start < cursor) continue;
    if (sp.start > cursor) out.push(<span key={`p${i}`}>{original.slice(cursor, sp.start)}</span>);
    out.push(
      <span
        key={`s${i}`}
        className="rounded-sm px-0.5 line-through decoration-2"
        style={{
          background: "color-mix(in oklab, var(--color-danger) 16%, transparent)",
          color: "var(--color-danger)",
        }}
        title={`Will be replaced with: ${sp.after}`}
      >
        {sp.before}
      </span>,
    );
    cursor = sp.end;
  }
  if (cursor < original.length) out.push(<span key="tail">{original.slice(cursor)}</span>);
  return <>{out}</>;
}

// Walkthrough #1 — sanitized pane: highlight every [REDACTED:...] token in
// place so it reads as a deliberate replacement, not as inert source text.
function SanitizedRendered({ sanitized }: { sanitized: string }) {
  const re = /(\[REDACTED:[A-Z_]+\]|\[[A-Z]+\s+REDACTED\])/g;
  const parts = sanitized.split(re);
  return (
    <>
      {parts.map((chunk, i) => {
        if (re.test(chunk)) {
          re.lastIndex = 0;
          let cat = "";
          const m1 = /^\[REDACTED:([A-Z_]+)\]$/.exec(chunk);
          const m2 = /^\[([A-Z]+)\s+REDACTED\]$/.exec(chunk);
          if (m1) cat = m1[1].toLowerCase().split("_")[0];
          else if (m2) cat = m2[1].toLowerCase();
          return (
            <span
              key={i}
              className="rounded-sm px-1 font-semibold"
              style={{
                background: `color-mix(in oklab, ${FLAG_COLOR[cat] || "var(--color-warning)"} 25%, transparent)`,
                color: FLAG_COLOR[cat] || "var(--color-warning)",
              }}
            >
              {chunk}
            </span>
          );
        }
        return <span key={i}>{chunk}</span>;
      })}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <StatLabel>{label}</StatLabel>
      <div className="font-mono text-lg font-semibold tabular-nums text-[var(--color-text)]">
        {value}
      </div>
    </div>
  );
}

function StatLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest"
    >
      {children}
    </div>
  );
}

// Walkthrough #5 — Distribution Statements (A-F) and REL TO caveats are
// independent. Earlier blurbs conflated them and were doctrinally wrong
// ("Distribution A · public release" for U.S.-only is the OPPOSITE meaning;
// Distribution E means DoD components only, not partner). Two-column posture
// per DoDI 5230.24 v1.
const DISTRIBUTION_BLURB: Record<Authority, string> = {
  US_ONLY:  "Distribution C · authorized to U.S. Government agencies and their contractors. (No foreign release.)",
  FVEY:     "Distribution C · authorized to U.S. Government agencies and their contractors · REL TO USA, AUS, CAN, GBR, NZL.",
  NATO:     "Distribution C · authorized to U.S. Government agencies and their contractors · REL TO NATO.",
  SPECIFIC: "Distribution C · authorized to U.S. Government agencies and their contractors · specific partner release, originator-controlled.",
};
