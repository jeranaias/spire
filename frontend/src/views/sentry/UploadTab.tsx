import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import clsx from "clsx";
import { api, type SentryBatch } from "../../api";
import { formatApiError } from "../../api-retry";
import type { SentryContext } from "../SentryView";
import { Button, fireIdempotent } from "../../components/ui";

export function UploadTab({ ctx }: { ctx: SentryContext }) {
  const nav = useNavigate();
  const [batch, setBatch] = useState<SentryBatch | null>(null);
  const [hovering, setHovering] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // WP-6 DDIL UX: per-byte upload progress for the SENTRY GCSS-MC ingest
  // path. The 103,686-row real sanitized SR header file is ~46 MB; on a
  // contested-link laptop the operator must see streaming feedback rather
  // than a frozen "loading" spinner. `progress` is a 0..1 fraction of
  // bytes uploaded; `progressLabel` carries the human-readable transferred /
  // total + filename for the bar's accessible label.
  const [progress, setProgress] = useState<number>(0);
  const [progressLabel, setProgressLabel] = useState<string>("");

  async function loadCanonical() {
    setLoading(true);
    setError(null);
    try {
      const b = await api.sentry.demoBatch(500);
      setBatch(b);
      ctx.setBatch(b.batch_id);
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Auto-seed with canonical dataset on first mount for demo flow.
    // Toggleable via `VITE_AUTO_SEED=false` or `?seed=off` so the production
    // narrative (drop-zone first, manual ingest) can be shown on command.
    //
    // Reviewer caught the canonical batch getting wiped on role switch. The
    // real bug is upstream (something else clearing sentryBatchId), but we
    // belt-and-suspenders here by:
    //   1. Treating ANY truthy ctx.batchId as authoritative — never re-seed.
    //   2. Honouring `?seed=off` whether it lives in the URL search OR the
    //      hash route (HashRouter puts it after `#/sentry/upload`).
    if (ctx.batchId) return;
    const autoSeedEnv = import.meta.env.VITE_AUTO_SEED;
    const url = typeof window !== "undefined" ? window.location : null;
    const seedOff =
      autoSeedEnv === "false" ||
      (!!url && (url.search.includes("seed=off") || url.hash.includes("seed=off")));
    if (!batch && !loading && !seedOff) loadCanonical();
  }, [ctx.batchId]);

  // 1 GB hard cap matches the backend (sentry.py UPLOAD_MAX_BYTES,
  // stage_ingest STAGE_INGEST_FILE_MAX_BYTES, nginx client_max_body_size).
  // Real GCSS-MC exports run hundreds of MB; the prior 100 MB cap was
  // bouncing real headers at the edge before they reached SENTRY.
  const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

  // Auto-route a file to its bundle role by filename. Mirrors the
  // server-side _detect_bundle_role() in backend/routes/sentry.py so
  // the operator sees the same routing decision the backend makes.
  type BundleRole = "header" | "sr_parts" | "due_in";
  type FileRouting = {
    file: File;
    role: BundleRole | "skipped";
    reason?: string;
  };
  function detectRole(filename: string): BundleRole | "skipped" {
    const name = filename.toLowerCase();
    // Data dictionaries (the *_dict.csv ridealongs from the GCSS export
    // tarball) describe schema, not records — quietly skip.
    if (/(_dict|data_dict)/i.test(name) || name.endsWith("dict.csv")) {
      return "skipped";
    }
    if (name.includes("sr_parts") || name.includes("repair_part")) return "sr_parts";
    if (name.includes("due_in") || name.includes("due-in")) return "due_in";
    if (name.includes("header") || name.includes("sr_header")) return "header";
    return "skipped";
  }
  function reasonForSkip(filename: string): string {
    const name = filename.toLowerCase();
    if (/_dict|data_dict|dict\.csv$/i.test(name)) {
      return "data dictionary — describes columns, not records";
    }
    return "filename did not match header / sr_parts / due_in";
  }

  // Routing preview lives in component state so the operator sees what
  // was sorted into which slot before they hit "Process Bundle".
  const [routed, setRouted] = useState<FileRouting[]>([]);

  // Single-file legacy path — keeps generic CSV/XLSX/JSON uploads
  // working through the original /api/sentry/upload endpoint.
  async function uploadSingle(file: File) {
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      const mb = (file.size / (1024 * 1024)).toFixed(1);
      setError(
        `${file.name} is ${mb} MB — over the 1 GB SENTRY ingest cap.`,
      );
      return;
    }
    setLoading(true);
    setError(null);
    setProgress(0);
    setProgressLabel(`${file.name} · 0%`);
    try {
      const b = await uploadWithProgress(file, (loaded, total) => {
        const frac = total > 0 ? loaded / total : 0;
        setProgress(frac);
        setProgressLabel(
          `${file.name} · ${formatMb(loaded)} / ${formatMb(total)} (${Math.round(
            frac * 100,
          )}%)`,
        );
      });
      setBatch(b);
      ctx.setBatch(b.batch_id);
      setProgress(1);
      setProgressLabel(`${file.name} · upload complete`);
      setRouted([]);
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setLoading(false);
    }
  }

  // Multi-file bundle path — fires the new /api/sentry/upload-bundle
  // endpoint. Operator can ctrl+click the whole GCSS-MC pull folder; we
  // sort into header / sr_parts / due_in and skip the data dictionaries.
  async function uploadBundle(routing: FileRouting[]) {
    setLoading(true);
    setError(null);
    setProgress(0);
    setProgressLabel("");
    try {
      const ingestible = routing.filter(
        (r) => r.role !== "skipped",
      ) as { file: File; role: BundleRole }[];
      if (ingestible.length === 0) {
        setError("No ingestible files found. Drop the GCSS-MC SR header CSV.");
        return;
      }
      const totalBytes = ingestible.reduce((acc, r) => acc + r.file.size, 0);
      if (totalBytes > MAX_UPLOAD_BYTES * 3) {
        setError(`Bundle total ${formatMb(totalBytes)} exceeds the 3 GB ingest budget.`);
        return;
      }
      setProgressLabel(
        `Uploading bundle · ${ingestible
          .map((r) => `${r.role}=${r.file.name}`)
          .join(" · ")}`,
      );
      const b = await uploadBundleWithProgress(
        ingestible.map((r) => r.file),
        (loaded, total) => {
          const frac = total > 0 ? loaded / total : 0;
          setProgress(frac);
        },
      );
      setBatch(b);
      ctx.setBatch(b.batch_id);
      setProgress(1);
      setProgressLabel(`Bundle ingested · batch ${b.batch_id}`);
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setLoading(false);
    }
  }

  // Operator dropped or picked one or more files. Sort into routing
  // preview; if exactly one file *and* it doesn't look like a GCSS
  // bundle file, fall through to the single-file path.
  function ingestFiles(fileList: FileList | File[] | null) {
    if (!fileList) return;
    const arr = Array.from(fileList);
    if (arr.length === 0) return;

    // Single non-bundle file → legacy single-file path. Lets operators
    // drop a generic CSV / XLSX without seeing a bundle preview.
    if (arr.length === 1) {
      const role = detectRole(arr[0].name);
      if (role === "skipped") {
        // Could be a generic non-GCSS file — defer to legacy path.
        void uploadSingle(arr[0]);
        return;
      }
    }

    const routing: FileRouting[] = arr.map((f) => {
      const role = detectRole(f.name);
      return role === "skipped"
        ? { file: f, role, reason: reasonForSkip(f.name) }
        : { file: f, role };
    });
    // De-dup roles: if two files claim the same role, keep the larger.
    const byRole = new Map<BundleRole, FileRouting>();
    const skipped: FileRouting[] = [];
    for (const r of routing) {
      if (r.role === "skipped") {
        skipped.push(r);
        continue;
      }
      const prev = byRole.get(r.role);
      if (!prev || r.file.size > prev.file.size) {
        if (prev) {
          skipped.push({
            file: prev.file,
            role: "skipped",
            reason: `superseded by larger ${r.role} file`,
          });
        }
        byRole.set(r.role, r);
      } else {
        skipped.push({
          file: r.file,
          role: "skipped",
          reason: `superseded by larger ${r.role} file`,
        });
      }
    }
    const final: FileRouting[] = [
      ...Array.from(byRole.values()),
      ...skipped,
    ];
    setRouted(final);
    setError(null);
  }

  async function processBundle() {
    if (routed.length === 0) return;
    if (!routed.some((r) => r.role === "header")) {
      setError("Bundle needs a SR header CSV (filename containing 'header').");
      return;
    }
    await uploadBundle(routed);
  }

  function clearRouting() {
    setRouted([]);
    setError(null);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setHovering(false);
    ingestFiles(e.dataTransfer.files);
  }

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    ingestFiles(e.target.files);
    // Reset so picking the same files again still fires onChange.
    e.target.value = "";
  }

  return (
    // Walkthrough #17 — vertical scroll bottomed out at Process Batch on
    // shorter viewports. min-h-0 + pb-12 gutter keeps the action row
    // reachable; outer is the explicit scroll container.
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-6 pb-12">
      <div className="mb-4">
        <h2 className="text-lg font-semibold">Data ingestion</h2>
        <div className="text-xs text-[var(--color-text-muted)]">
          Upload CSV / XLSX / JSON from GCSS-MC or DRRS-MC exports. For the live demo the canonical synthetic dataset seeds automatically.
        </div>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setHovering(true);
        }}
        onDragLeave={() => setHovering(false)}
        onDrop={onDrop}
        className={clsx(
          "mb-6 flex flex-col items-center justify-center rounded-md border-2 border-dashed p-6 transition-colors",
          hovering
            ? "border-[var(--color-primary)] bg-[color-mix(in_oklab,var(--color-primary)_15%,var(--color-surface))]"
            : "border-[var(--color-border-active)] bg-[var(--color-surface)]",
        )}
      >
        <div className="text-sm font-medium text-[var(--color-text)]">
          Drop the GCSS-MC export folder, or ctrl+click to pick all files at once
        </div>
        <div className="mt-1 max-w-2xl text-center text-xs text-[var(--color-text-muted)]">
          SR header + repair-parts + due-in route into one review batch.
          Data dictionaries (<code className="font-mono">*_dict.csv</code>)
          skip automatically. Single-file ingest still works for non-GCSS exports.
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
          <Button onClick={loadCanonical} disabled={loading} pending={loading} size="sm">
            Load canonical dataset
          </Button>
          <label
            className={clsx(
              "inline-flex cursor-pointer items-center rounded-sm border border-[var(--color-border-active)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-medium text-[var(--color-text)] transition-colors",
              loading && "pointer-events-none opacity-50",
            )}
          >
            Pick files…
            <input
              type="file"
              accept=".csv,.xlsx,.xls,.json,.txt,.tsv"
              className="hidden"
              onChange={onPickFile}
              disabled={loading}
              multiple
            />
          </label>
        </div>
        {error && (
          <div className="mt-2 max-w-xl text-center text-xs text-[var(--color-danger)]">
            {error}
          </div>
        )}
      </div>

      {routed.length > 0 && !batch && (
        <section
          data-testid="bundle-routing-preview"
          className="mb-6 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        >
          <div className="mb-3 flex items-baseline justify-between">
            <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
              Bundle routing · {routed.filter((r) => r.role !== "skipped").length} of {routed.length} files will ingest
            </div>
            <button
              type="button"
              onClick={clearRouting}
              disabled={loading}
              className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:opacity-40"
            >
              Clear
            </button>
          </div>
          <ul className="flex flex-col gap-1.5">
            {(["header", "sr_parts", "due_in"] as const).map((role) => {
              const r = routed.find((x) => x.role === role);
              return (
                <li
                  key={role}
                  className={clsx(
                    "flex items-center gap-3 rounded-sm border px-3 py-2 font-mono text-xs",
                    r
                      ? "border-[var(--color-success-muted)] bg-[color-mix(in_oklab,var(--color-success-muted)_18%,var(--color-surface))] text-[var(--color-text)]"
                      : "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-muted)]",
                  )}
                >
                  <span className="w-24 shrink-0 uppercase tracking-widest">
                    {role === "sr_parts" ? "SR PARTS" : role === "due_in" ? "DUE-IN" : "SR HEADER"}
                  </span>
                  {r ? (
                    <>
                      <span className="flex-1 truncate">{r.file.name}</span>
                      <span className="shrink-0 tabular-nums text-[var(--color-text-muted)]">
                        {formatMb(r.file.size)}
                      </span>
                      <span className="shrink-0 text-[var(--color-success)]">✓ ready</span>
                    </>
                  ) : (
                    <span className="flex-1 italic">
                      {role === "header" ? "required — drop a file with 'header' in its name" : "optional context"}
                    </span>
                  )}
                </li>
              );
            })}
            {routed.filter((r) => r.role === "skipped").length > 0 && (
              <li className="mt-1 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-[11px] text-[var(--color-text-muted)]">
                <div className="mb-1 uppercase tracking-widest">Skipped</div>
                <ul className="flex flex-col gap-0.5">
                  {routed
                    .filter((r) => r.role === "skipped")
                    .map((r) => (
                      <li key={r.file.name} className="flex items-center gap-2">
                        <span className="truncate">{r.file.name}</span>
                        <span className="text-[var(--color-text-muted)]">·</span>
                        <span className="italic">{r.reason}</span>
                      </li>
                    ))}
                </ul>
              </li>
            )}
          </ul>
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
            <Button
              onClick={processBundle}
              disabled={loading || !routed.some((r) => r.role === "header")}
              pending={loading}
              size="sm"
            >
              Process Bundle
            </Button>
          </div>
        </section>
      )}

      {progressLabel && (
        <div
          className="mb-4 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
          data-testid="upload-progress"
        >
          <div className="mb-1 flex items-center justify-between font-mono text-[11px] uppercase tracking-wider text-[var(--color-text-secondary)]">
            <span>Streaming to SENTRY ingest</span>
            <span>{Math.round(progress * 100)}%</span>
          </div>
          <div
            className="h-2 w-full overflow-hidden rounded-sm bg-[color-mix(in_oklab,var(--color-primary)_8%,var(--color-bg))]"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            aria-label={progressLabel}
          >
            <div
              className="h-full bg-[var(--color-primary)] transition-[width] duration-150 ease-linear"
              style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }}
            />
          </div>
          <div className="mt-1 truncate font-mono text-[11px] text-[var(--color-text-muted)]">
            {progressLabel}
          </div>
        </div>
      )}

      {batch && (
        <div className="flex flex-col gap-4">
          {batch.gcss_ingest_report && (
            <section className="rounded-md border border-[var(--color-success-muted)] bg-[color-mix(in_oklab,var(--color-success-muted)_20%,var(--color-surface))] p-4">
              <div className="mb-2 flex items-baseline justify-between">
                <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-success)]">
                  GCSS-MC schema detected
                </div>
                <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
                  {batch.gcss_ingest_report.adapter}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
                <KV
                  label="Rows total"
                  value={batch.gcss_ingest_report.rows_total.toLocaleString()}
                  mono
                />
                <KV
                  label="Rows kept (CM)"
                  value={batch.gcss_ingest_report.rows_kept.toLocaleString()}
                  mono
                />
                <KV
                  label="Unique SRs"
                  value={batch.gcss_ingest_report.unique_sr_numbers.toLocaleString()}
                  mono
                />
                <KV
                  label="Filtered (PMCS)"
                  value={batch.gcss_ingest_report.rows_filtered_pmcs.toLocaleString()}
                  mono
                />
                <KV
                  label="Trailing-period defects normalized"
                  value={batch.gcss_ingest_report.defect_code_trailing_period_normalized.toLocaleString()}
                  mono
                />
                <KV
                  label="Date parse failures"
                  value={batch.gcss_ingest_report.date_parse_failures.toLocaleString()}
                  mono
                />
                <KV
                  label="Rows with warnings"
                  value={batch.gcss_ingest_report.rows_with_warnings.toLocaleString()}
                  mono
                />
                <KV
                  label="Sanitization gate"
                  value={batch.gcss_ingest_report.sanitization_gate}
                  mono
                />
              </div>
              {batch.gcss_ingest_report.schema_warnings.length > 0 && (
                <div className="mt-3 rounded-sm border border-[var(--color-warning-muted)] bg-[var(--color-surface)] p-2 text-xs">
                  <div className="mb-1 font-semibold text-[var(--color-warning)]">
                    Schema warnings
                  </div>
                  <ul className="ml-3 list-disc font-mono text-[var(--color-text-muted)]">
                    {batch.gcss_ingest_report.schema_warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="mt-3 text-xs text-[var(--color-text-muted)]">
                Hashing-gate PASS: <code className="font-mono">SR_NUMBER</code>,{" "}
                <code className="font-mono">SERIAL_NUMBER</code>, <code className="font-mono">TAMCN</code>, and{" "}
                <code className="font-mono">OWNER_UNIT_ADDRESS_CODE</code> all arrived in canonical pre-hashed form;
                clear values would have been rejected at upload. Trailing-period defect codes (e.g.{" "}
                <code className="font-mono">FCON.</code>) are normalized to their primary form. Oracle{" "}
                <code className="font-mono">DD-MON-YY</code> dates parse with the same sliding window the live
                export uses.
              </div>
            </section>
          )}
          <section className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
              Batch
            </div>
            <div className="flex flex-wrap gap-6 text-xs">
              <KV label="Batch ID" value={batch.batch_id} mono />
              <KV label="Source" value={batch.source} />
              <KV label="Records" value={batch.record_count} />
              <KV label="Status" value={batch.status} />
              {/* Walkthrough audit: raw ISO bled into the batch header. Render
               * audit-grade DD MMM YYYY · HHMMz so the Created stamp reads as
               * prose, not a debug timestamp. */}
              <KV label="Created" value={fmtBatchTimestamp(batch.created_at)} mono />
            </div>
          </section>

          <section className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <div className="mb-2 flex items-baseline justify-between">
              <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                Data quality gate
              </div>
              <div className="font-mono text-xs tabular-nums text-[var(--color-text-muted)]">
                {((batch.data_quality.passed / batch.record_count) * 100).toFixed(1)}% pass
              </div>
            </div>
            <div className="mb-3 flex items-center gap-3">
              <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-[var(--color-bg)]">
                <div
                  className="absolute inset-y-0 left-0 bg-[var(--color-success)]"
                  style={{ width: `${(batch.data_quality.passed / batch.record_count) * 100}%` }}
                />
              </div>
              <span className="font-mono text-sm tabular-nums text-[var(--color-success)]">
                {batch.data_quality.passed}
              </span>
              <span className="text-xs text-[var(--color-text-muted)]">/ {batch.record_count}</span>
            </div>
            <div className="flex flex-wrap gap-3">
              {batch.data_quality.flags.map((f) => (
                <div
                  key={f.type}
                  className="flex items-center gap-2 rounded-sm border border-[var(--color-warning-muted)] bg-[color-mix(in_oklab,var(--color-warning-muted)_20%,var(--color-surface))] px-2 py-1 text-sm"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-warning)]" />
                  <span className="font-mono">{f.type.replace(/_/g, " ")}</span>
                  <span className="font-mono text-[var(--color-text-muted)]">× {f.count}</span>
                </div>
              ))}
            </div>
            <div className="mt-3 text-xs text-[var(--color-text-muted)]">
              Records with data-quality flags still process, but predictions derived from them carry a caveat
              through PULSE's views.
            </div>
          </section>

          <section className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
              Preview (first {batch.preview.length})
            </div>
            <div className="overflow-hidden rounded-sm border border-[var(--color-border)]">
              <table className="w-full border-collapse font-mono text-sm">
                <thead>
                  <tr className="bg-[var(--color-bg)] text-[var(--color-text-muted)]">
                    <th className="p-2 text-left">SR</th>
                    <th className="p-2 text-left">Unit</th>
                    <th className="p-2 text-left">Equipment</th>
                    <th className="p-2 text-left">Mark</th>
                    <th className="p-2 text-left">Remark</th>
                  </tr>
                </thead>
                <tbody>
                  {batch.preview.map((p) => (
                    <tr key={p.sr_number} className="border-t border-[var(--color-border)]">
                      <td className="p-2">{p.sr_number}</td>
                      <td className="p-2">{p.unit_name}</td>
                      <td className="p-2">{p.equipment_type}</td>
                      <td className="p-2">{p.source_classification}</td>
                      <td className="p-2 font-sans text-[var(--color-text-secondary)]">
                        {p.remark_preview}...
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <div className="flex items-center gap-3">
            <Button
              onClick={async () => {
                setLoading(true);
                try {
                  // Idempotent per batch id so a triple-tap on Process never
                  // launches the engine twice.
                  const job = await fireIdempotent(
                    `sentry:process:${batch.batch_id}`,
                    () => api.sentry.process(batch.batch_id),
                    500,
                  );
                  if (!job) return;
                  ctx.setJob(job.job_id);
                  nav("/sentry/processing");
                } catch (e) {
                  setError(formatApiError(e));
                } finally {
                  setLoading(false);
                }
              }}
              disabled={loading}
              pending={loading}
            >
              Process batch
            </Button>
            <span className="text-xs text-[var(--color-text-muted)]">
              Rule-based pattern engine runs every record. LLM gate is wired but unloaded in this build (rule-based fallback labelled honestly in the footer).
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function KV({ label, value, mono }: { label: string; value: any; mono?: boolean }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-[var(--color-text-muted)]">{label}</div>
      <div className={clsx(mono && "font-mono", "text-[var(--color-text)]")}>{String(value)}</div>
    </div>
  );
}

function formatMb(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Upload via XHR so we get per-byte progress events. fetch() in browsers
 * does not surface upload-side progress (the streams API is request-side
 * and not yet broadly supported), so the SENTRY upload tab uses XHR for
 * the multipart POST. This preserves the FastAPI route contract — the
 * server still sees a standard multipart/form-data body — while giving
 * the operator a streaming progress bar instead of a frozen spinner on
 * the 46-MB real GCSS-MC sanitized SR header file.
 */
function uploadWithProgress(
  file: File,
  onProgress: (loaded: number, total: number) => void,
): Promise<SentryBatch> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/sentry/upload", true);
    xhr.responseType = "text";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      const status = xhr.status;
      const text = typeof xhr.response === "string" ? xhr.response : "";
      if (status >= 200 && status < 300) {
        try {
          resolve(JSON.parse(text) as SentryBatch);
        } catch (e) {
          reject(new Error(`Malformed upload response: ${(e as Error).message}`));
        }
        return;
      }
      let detail = `${status} ${xhr.statusText}`;
      try {
        const body = JSON.parse(text);
        if (body && body.detail) detail = body.detail;
      } catch {
        /* keep status text */
      }
      reject(new Error(detail));
    };
    xhr.onerror = () =>
      reject(new Error("Network error during upload — check the link to SPIRE backend."));
    xhr.onabort = () => reject(new Error("Upload aborted."));
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}

/**
 * Multi-file bundle variant — POSTs every file under the same `files`
 * field name so FastAPI's `list[UploadFile]` parameter binds them as
 * an array. Progress is reported as a single aggregate transfer; the
 * UI surfaces filename × role mapping in the routing-preview card.
 */
function uploadBundleWithProgress(
  files: File[],
  onProgress: (loaded: number, total: number) => void,
): Promise<SentryBatch> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/sentry/upload-bundle", true);
    xhr.responseType = "text";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      const status = xhr.status;
      const text = typeof xhr.response === "string" ? xhr.response : "";
      if (status >= 200 && status < 300) {
        try {
          resolve(JSON.parse(text) as SentryBatch);
        } catch (e) {
          reject(new Error(`Malformed bundle response: ${(e as Error).message}`));
        }
        return;
      }
      let detail = `${status} ${xhr.statusText}`;
      try {
        const body = JSON.parse(text);
        if (body && body.detail) detail = body.detail;
      } catch {
        /* keep status text */
      }
      reject(new Error(detail));
    };
    xhr.onerror = () =>
      reject(new Error("Network error during bundle upload — check the link to SPIRE backend."));
    xhr.onabort = () => reject(new Error("Upload aborted."));
    const form = new FormData();
    for (const f of files) {
      form.append("files", f, f.name);
    }
    xhr.send(form);
  });
}

function fmtBatchTimestamp(iso: string | undefined | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  const z = (n: number) => String(n).padStart(2, "0");
  return `${z(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} · ${z(d.getUTCHours())}${z(d.getUTCMinutes())}z`;
}
