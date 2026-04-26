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
      const r = await api.sentry.export(authority, format);
      setResult(r as any);
      // Toast carries a click-through link so the operator never wonders
      // "where did the file go?" after a successful export. Reviewer caught
      // the celebratory toast having no destination.
      pushToast({
        tone: "ok",
        text: `✓ Export ${r.export_id} · ${(r.records_exported ?? 0).toLocaleString()} records · ${((r.bytes ?? 0) / 1024).toFixed(1)} KB`,
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
            <Stat label="Records Exported" value={(result.records_exported ?? 0).toLocaleString()} />
            <Stat label="Rejected"          value={(result.records_rejected ?? 0).toLocaleString()} />
            <Stat label="Decisions Applied" value={`${result.decisions_applied ?? 0}`} />
            <Stat label="Redactions Applied" value={`${result.redactions_applied ?? 0}`} />
            <div className="col-span-2">
              <StatLabel>Distribution Statement</StatLabel>
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
                      {d.original}
                    </div>
                  </div>
                  <div className="p-3">
                    <div
                      className="mb-1 font-mono text-xs uppercase text-[var(--color-success)] tracking-widest"
                    >
                      Sanitized · Export Bundle
                    </div>
                    <div className="font-mono text-base leading-relaxed text-[var(--color-text)]">
                      {d.sanitized.split(/(\[[A-Z]+\s+REDACTED\])/g).map((chunk, i) => {
                        const match = /^\[([A-Z]+)\s+REDACTED\]$/.exec(chunk);
                        if (match) {
                          const cat = match[1].toLowerCase();
                          return (
                            <span
                              key={i}
                              className="rounded-sm px-1 font-semibold"
                              style={{
                                background: `color-mix(in oklab, ${FLAG_COLOR[cat] || "#666"} 25%, transparent)`,
                                color: FLAG_COLOR[cat] || "inherit",
                              }}
                            >
                              {chunk}
                            </span>
                          );
                        }
                        return <span key={i}>{chunk}</span>;
                      })}
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

const DISTRIBUTION_BLURB: Record<Authority, string> = {
  US_ONLY:  "Distribution A · public release · no foreign disclosure restrictions.",
  FVEY:     "Distribution D · REL TO FVEY (USA, AUS, CAN, GBR, NZL).",
  NATO:     "Distribution D · REL TO NATO. Further dissemination requires originator approval.",
  SPECIFIC: "Distribution E · case-by-case partner release, originator-controlled.",
};
