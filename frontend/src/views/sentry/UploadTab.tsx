import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import clsx from "clsx";
import { api, type SentryBatch } from "../../api";
import type { SentryContext } from "../SentryView";

export function UploadTab({ ctx }: { ctx: SentryContext }) {
  const nav = useNavigate();
  const [batch, setBatch] = useState<SentryBatch | null>(null);
  const [hovering, setHovering] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadCanonical() {
    setLoading(true);
    setError(null);
    try {
      const b = await api.sentry.demoBatch(500);
      setBatch(b);
      ctx.setBatch(b.batch_id);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Auto-seed with canonical dataset on first mount for demo flow.
    // Toggleable via `VITE_AUTO_SEED=false` or `?seed=off` so the production
    // narrative (drop-zone first, manual ingest) can be shown on command.
    const autoSeedEnv = import.meta.env.VITE_AUTO_SEED;
    const hashSearch = typeof window !== "undefined" ? window.location.hash : "";
    const seedOff = hashSearch.includes("seed=off") || autoSeedEnv === "false";
    if (ctx.batchId) {
      // Batch already in-flight via the Zustand store — don't re-seed.
      return;
    }
    if (!batch && !loading && !seedOff) loadCanonical();
  }, [ctx.batchId]);

  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setHovering(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    setLoading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const resp = await fetch("/api/sentry/upload", { method: "POST", body: form });
      if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
      const b = await resp.json();
      setBatch(b);
      ctx.setBatch(b.batch_id);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-6">
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
          "mb-6 flex h-44 flex-col items-center justify-center rounded-md border-2 border-dashed transition-colors",
          hovering
            ? "border-[var(--color-primary)] bg-[color-mix(in_oklab,var(--color-primary)_15%,var(--color-surface))]"
            : "border-[var(--color-border-active)] bg-[var(--color-surface)]",
        )}
      >
        <div className="text-sm font-medium text-[var(--color-text)]">
          Drop a file, or use the canonical dataset →
        </div>
        <div className="mt-1 text-xs text-[var(--color-text-muted)]">
          Accepted: .csv, .xlsx, .json, .txt
        </div>
        <button
          onClick={loadCanonical}
          disabled={loading}
          className="mt-3 rounded border border-[var(--color-primary)] bg-[var(--color-primary)] px-4 py-1.5 text-xs font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
        >
          {loading ? "Loading ..." : "Load canonical dataset"}
        </button>
        {error && <div className="mt-2 text-xs text-[var(--color-danger)]">{error}</div>}
      </div>

      {batch && (
        <div className="flex flex-col gap-4">
          <section className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
              Batch
            </div>
            <div className="flex flex-wrap gap-6 text-xs">
              <KV label="Batch ID" value={batch.batch_id} mono />
              <KV label="Source" value={batch.source} />
              <KV label="Records" value={batch.record_count} />
              <KV label="Status" value={batch.status} />
              <KV label="Created" value={batch.created_at} mono />
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
                  className="flex items-center gap-2 rounded-sm border border-[var(--color-warning-muted)] bg-[color-mix(in_oklab,var(--color-warning-muted)_20%,var(--color-surface))] px-2 py-1 text-[11px]"
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
              <table className="w-full border-collapse font-mono text-[11px]">
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
            <button
              onClick={async () => {
                setLoading(true);
                try {
                  const job = await api.sentry.process(batch.batch_id);
                  ctx.setJob(job.job_id);
                  nav("/sentry/processing");
                } catch (e) {
                  setError(String(e));
                } finally {
                  setLoading(false);
                }
              }}
              disabled={loading}
              className="rounded border border-[var(--color-primary)] bg-[var(--color-primary)] px-6 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
            >
              {loading ? "Starting ..." : "Process batch"}
            </button>
            <span className="text-xs text-[var(--color-text-muted)]">
              Tier-1 pattern engine runs first; ambiguous records escalate to the language-model gate.
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
      <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">{label}</div>
      <div className={clsx(mono && "font-mono", "text-[var(--color-text)]")}>{String(value)}</div>
    </div>
  );
}
