import { useState } from "react";
import clsx from "clsx";
import { api, type ExportResult } from "../../api";
import type { SentryContext } from "../SentryView";

const AUTHORITIES = [
  { id: "US_ONLY", label: "U.S. Only" },
  { id: "FVEY",    label: "FVEY" },
  { id: "NATO",    label: "NATO" },
  { id: "SPECIFIC", label: "Specific Partner" },
];

const FORMATS = ["xlsx", "csv", "json"];

export function ExportTab({ ctx }: { ctx: SentryContext }) {
  const [authority, setAuthority] = useState("US_ONLY");
  const [format, setFormat] = useState("xlsx");
  const [includeAudit, setIncludeAudit] = useState(true);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [loading, setLoading] = useState(false);

  async function doExport() {
    setLoading(true);
    try {
      const r = await api.sentry.export(authority, format);
      setResult(r);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-6">
      <div className="mb-4">
        <h2 className="text-lg font-semibold">Export sanitized dataset</h2>
        <div className="text-xs text-[var(--color-text-muted)]">
          Release-authority selection adjusts sanitization rules. A NATO release, for example, further generalizes
          unit designators and strips REL TO USA-only markings.
        </div>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-6">
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            Release authority
          </h4>
          <div className="flex flex-col gap-2">
            {AUTHORITIES.map((a) => (
              <label key={a.id} className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="authority"
                  checked={authority === a.id}
                  onChange={() => setAuthority(a.id)}
                  className="accent-[var(--color-primary)]"
                />
                {a.label}
              </label>
            ))}
          </div>
        </div>

        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            Format + options
          </h4>
          <div className="mb-3 flex gap-2">
            {FORMATS.map((f) => (
              <button
                key={f}
                onClick={() => setFormat(f)}
                className={clsx(
                  "rounded border px-3 py-1 text-xs font-mono uppercase",
                  format === f
                    ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-white"
                    : "border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-border-active)]",
                )}
              >
                {f}
              </button>
            ))}
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={includeAudit}
              onChange={() => setIncludeAudit(!includeAudit)}
              className="accent-[var(--color-primary)]"
            />
            Include append-only audit log (SHA-256 chained)
          </label>
          <div className="mt-2 text-[11px] text-[var(--color-text-muted)]">
            Recommended on — lets the receiving partner verify provenance without re-inspecting every record.
          </div>
        </div>
      </div>

      <div>
        <button
          onClick={doExport}
          disabled={loading || !ctx.batchId}
          className="rounded border border-[var(--color-success)] bg-[var(--color-success)] px-6 py-2 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50"
        >
          {loading ? "Building bundle ..." : "Export sanitized bundle"}
        </button>
        {!ctx.batchId && <span className="ml-3 text-xs text-[var(--color-text-muted)]">Requires a processed batch.</span>}
      </div>

      {result && (
        <div className="mt-6 rounded-md border border-[var(--color-success-muted)] bg-[color-mix(in_oklab,var(--color-success-muted)_15%,var(--color-surface))] p-4">
          <div className="mb-2 flex items-baseline justify-between">
            <h4 className="font-semibold text-[var(--color-success)]">Export prepared</h4>
            <span className="font-mono text-xs text-[var(--color-text-muted)]">{result.created_at}</span>
          </div>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">Records exported</div>
              <div className="font-mono text-[var(--color-text)]">
                {(result.records_exported ?? 0).toLocaleString()}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">Rejected</div>
              <div className="font-mono text-[var(--color-text)]">
                {(result.records_rejected ?? 0).toLocaleString()}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">Decisions applied</div>
              <div className="font-mono text-[var(--color-text)]">{result.decisions_applied ?? 0}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">Redactions applied</div>
              <div className="font-mono text-[var(--color-text)]">{result.redactions_applied ?? 0}</div>
            </div>
            <div className="col-span-2">
              <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">Distribution statement</div>
              <div className="font-mono text-[var(--color-text-secondary)]">{result.distribution_statement}</div>
            </div>
            <div className="col-span-2">
              <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">Download</div>
              <a
                href={result.download_url}
                className="font-mono text-[var(--color-primary)] hover:underline"
              >
                {result.download_url}
              </a>
              {result.bytes != null && (
                <span className="ml-2 text-[var(--color-text-muted)]">({(result.bytes / 1024).toFixed(1)} KB)</span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
