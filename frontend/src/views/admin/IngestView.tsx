/**
 * IngestView — RD9 operator-side real-data ingest dropzone.
 *
 * Three sub-panels matching the three /api/ingest adapters:
 *   - GCSS-MC ECP        (asset roster)
 *   - GCSS-MC UTIL       (current_hours / current_miles / current_status)
 *   - GCSS-MC SR-header  (dry-run analyzer; full bundle apply lives in
 *                         /api/system/stage-ingest)
 *
 * Each panel runs the same dry-run → preview → confirm → apply flow:
 *   1. Operator drops a CSV.
 *   2. POST without ?apply= returns the IngestReport + structural diff +
 *      a `preview_token` (SHA-256 of the file body).
 *   3. UI renders the diff as a count summary + sample rows per bucket.
 *   4. Operator clicks "Apply" → POST with ?apply=1&confirm=<token>.
 *   5. Audit chain logs the apply; downstream dashboards re-fetch.
 *
 * The view is scope-gated to data_custodian + security_manager via
 * VIEW_SCOPE so /admin/ingest 403s for everyone else (no teaser).
 */
import { useEffect, useState } from "react";
import { api, type EcpUploadResult, type StaleAsset, type UtilUploadResult, type SrHeaderUploadResult } from "../../api";
import { formatApiError } from "../../api-retry";
import { useSpireStore } from "../../state/store";
import { Button, ErrorState, LoadingState, Pressable } from "../../components/ui";

type AdapterId = "ecp" | "util" | "sr-header";

const ADAPTER_META: Record<AdapterId, { label: string; route: string; writes: string }> = {
  "ecp": {
    label: "Equipment Custodian Report",
    route: "/api/ingest/gcss-mc/ecp",
    writes: "asset roster (TAMCN, NSN, serial, allowance, on-hand, last inventory date)",
  },
  "util": {
    label: "Utilization Extract",
    route: "/api/ingest/gcss-mc/util",
    writes: "asset current_hours / current_miles / current_status",
  },
  "sr-header": {
    label: "SR Header Export",
    route: "/api/ingest/gcss-mc/sr-header",
    writes: "dry-run analyzer only (full bundle apply: /api/system/stage-ingest)",
  },
};

export function IngestView() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [statusErr, setStatusErr] = useState<string | null>(null);
  const [tab, setTab] = useState<AdapterId>("ecp");

  useEffect(() => {
    let cancelled = false;
    api.ingest
      .status()
      .then((r) => {
        if (cancelled) return;
        setEnabled(r.enabled);
      })
      .catch((e) => {
        if (cancelled) return;
        setStatusErr(formatApiError(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
      <header className="flex flex-col gap-1">
        <h1 className="font-mono text-sm font-semibold uppercase tracking-[0.22em] text-[var(--color-text)]">
          Real-data ingest
        </h1>
        <p className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
          drop a GCSS-MC export · dry-run first · confirm token gates apply
        </p>
      </header>

      {statusErr && (
        <ErrorState title="Ingest status unavailable" description={statusErr} />
      )}

      {enabled === false && (
        <div className="rounded-md border border-[var(--color-warning)] bg-[color-mix(in_oklab,var(--color-warning-muted)_18%,var(--color-surface))] p-3 font-mono text-xs text-[var(--color-warning)]">
          Ingest is disabled on this box. Set{" "}
          <code className="rounded bg-[var(--color-bg)] px-1 py-px">SPIRE_INGEST_ENABLED=1</code>{" "}
          on the backend env and restart. Dry-run uploads will return 503 until the flag is on.
        </div>
      )}

      <nav className="flex items-center gap-1 border-b border-[var(--color-border)]" role="tablist">
        {(["ecp", "util", "sr-header"] as AdapterId[]).map((id) => (
          <Pressable
            key={id}
            onClick={() => setTab(id)}
            block={false}
            role="tab"
            aria-selected={tab === id}
            className={
              "!min-h-0 px-3 py-2 font-mono text-xs uppercase tracking-widest transition-colors " +
              (tab === id
                ? "border-b-2 border-[var(--color-primary)] text-[var(--color-text)]"
                : "border-b-2 border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text)]")
            }
          >
            {id === "sr-header" ? "SR-Header" : id.toUpperCase()}
          </Pressable>
        ))}
      </nav>

      <section className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <div>
            <div className="font-mono text-xs uppercase tracking-widest text-[var(--color-text)]">
              GCSS-MC · {ADAPTER_META[tab].label}
            </div>
            <div className="mt-0.5 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
              {ADAPTER_META[tab].route}
            </div>
          </div>
          <div className="text-right font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
            writes to
            <div className="text-[var(--color-text-secondary)] normal-case tracking-wide">
              {ADAPTER_META[tab].writes}
            </div>
          </div>
        </div>
        {tab === "ecp" && <EcpPanel />}
        {tab === "util" && <UtilPanel />}
        {tab === "sr-header" && <SrHeaderPanel />}
      </section>

      <StaleQueue />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared dropzone primitive
// ---------------------------------------------------------------------------

function FileDropzone({
  accept = ".csv,text/csv",
  onFile,
  busy,
  hint,
}: {
  accept?: string;
  onFile: (f: File) => void;
  busy?: boolean;
  hint: string;
}) {
  const [dragging, setDragging] = useState(false);
  return (
    <label
      className={
        "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-4 py-8 transition-colors " +
        (busy
          ? "cursor-wait border-[var(--color-border)] bg-[var(--color-bg)]"
          : dragging
            ? "border-[var(--color-primary)] bg-[color-mix(in_oklab,var(--color-primary)_12%,var(--color-surface))]"
            : "border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-primary)]")
      }
      onDragOver={(e) => {
        e.preventDefault();
        if (!busy) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (busy) return;
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
    >
      <input
        type="file"
        accept={accept}
        className="hidden"
        disabled={busy}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
        }}
      />
      <span className="font-mono text-xs uppercase tracking-widest text-[var(--color-text-secondary)]">
        {busy ? "Uploading…" : "Drop CSV here · or click to browse"}
      </span>
      <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
        {hint}
      </span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// ECP panel — dry-run preview + confirm → apply
// ---------------------------------------------------------------------------

function EcpPanel() {
  const pushToast = useSpireStore((s) => s.pushToast);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<EcpUploadResult | null>(null);
  const [busy, setBusy] = useState<"idle" | "preview" | "apply">("idle");
  const [err, setErr] = useState<string | null>(null);

  async function runDryRun(f: File) {
    setBusy("preview");
    setErr(null);
    setPreview(null);
    setFile(f);
    try {
      const r = await api.ingest.ecp(f);
      setPreview(r);
    } catch (e) {
      setErr(formatApiError(e));
    } finally {
      setBusy("idle");
    }
  }

  async function runApply() {
    if (!file || !preview) return;
    setBusy("apply");
    setErr(null);
    try {
      const r = await api.ingest.ecp(file, { apply: true, confirm: preview.preview_token });
      setPreview(r);
      pushToast({
        tone: "ok",
        text: `ECP applied · matched ${r.applied_counts?.matched_changed ?? 0} · new ${r.applied_counts?.new ?? 0} · stale ${r.applied_counts?.stale ?? 0}`,
        ttlMs: 6000,
      });
    } catch (e) {
      setErr(formatApiError(e));
    } finally {
      setBusy("idle");
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <FileDropzone
        onFile={runDryRun}
        busy={busy !== "idle"}
        hint="8 columns expected · TAMCN/NSN/SERIAL_NUMBER/NOMENCLATURE/OWNER_UIC/ALLOWANCE_QTY/ON_HAND_QTY/LAST_INVENTORY_DATE"
      />
      {busy === "preview" && <LoadingState label="Parsing + computing diff" />}
      {err && <ErrorState title="Upload failed" description={err} />}
      {preview && !preview.applied && (
        <PreviewSummary
          counts={preview.preview?.counts ?? null}
          report={preview.report}
          token={preview.preview_token}
          onApply={runApply}
          applyBusy={busy === "apply"}
          conflicts={preview.preview?.conflicts ?? []}
        />
      )}
      {preview?.applied && (
        <div className="rounded-md border border-[var(--color-success)] bg-[color-mix(in_oklab,var(--color-success-muted)_15%,var(--color-surface))] p-3 font-mono text-xs text-[var(--color-success)]">
          Applied · matched {preview.applied_counts?.matched_changed ?? 0} · new{" "}
          {preview.applied_counts?.new ?? 0} · stale{" "}
          {preview.applied_counts?.stale ?? 0} flagged for review
        </div>
      )}
    </div>
  );
}

function PreviewSummary({
  counts,
  report,
  token,
  onApply,
  applyBusy,
  conflicts,
}: {
  counts: { matched_changed: number; new: number; unchanged: number; stale: number; conflicts: number } | null;
  report: { rows_total: number; rows_kept: number; header_mismatch: boolean };
  token: string;
  onApply: () => void;
  applyBusy: boolean;
  conflicts: { tamcn: string; serial_number: string; reason: string }[];
}) {
  const blocked = conflicts.length > 0;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] uppercase tracking-widest">
        <Stat label="parsed" value={report.rows_total} />
        <Stat label="kept" value={report.rows_kept} />
        {counts && (
          <>
            <Stat label="matched" value={counts.matched_changed} tone="warning" />
            <Stat label="new" value={counts.new} tone="primary" />
            <Stat label="unchanged" value={counts.unchanged} tone="muted" />
            <Stat label="stale" value={counts.stale} tone="warning" />
            <Stat label="conflicts" value={counts.conflicts} tone={counts.conflicts ? "danger" : "muted"} />
          </>
        )}
      </div>
      {report.header_mismatch && (
        <div className="rounded-sm border border-[var(--color-warning)] bg-[var(--color-bg)] px-2 py-1 font-mono text-xs text-[var(--color-warning)]">
          Header mismatch — adapter ran in lenient mode; verify the columns before applying.
        </div>
      )}
      {blocked && (
        <div className="rounded-sm border border-[var(--color-danger)] bg-[var(--color-bg)] px-2 py-1 font-mono text-xs text-[var(--color-danger)]">
          {conflicts.length} conflict row(s) — apply blocked. Resolve duplicates upstream then re-upload.
        </div>
      )}
      <div className="flex items-center justify-between gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
        <div className="flex flex-col">
          <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
            Preview token
          </span>
          <span className="font-mono text-xs tabular-nums text-[var(--color-text-secondary)]">
            {token.slice(0, 12)}…
          </span>
        </div>
        <Button
          variant="primary"
          onClick={onApply}
          pending={applyBusy}
          disabled={blocked || applyBusy}
        >
          {blocked ? "Blocked by conflicts" : "Apply to canonical roster"}
        </Button>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "warning" | "primary" | "muted" | "danger" }) {
  const color =
    tone === "warning" ? "var(--color-warning)" :
    tone === "primary" ? "var(--color-primary)" :
    tone === "danger" ? "var(--color-danger)" :
    "var(--color-text-muted)";
  return (
    <span
      className="rounded-sm border px-2 py-[2px] tabular-nums"
      style={{ borderColor: `color-mix(in oklab, ${color} 40%, var(--color-border))`, color }}
    >
      {label} {value}
    </span>
  );
}

// ---------------------------------------------------------------------------
// UTIL panel
// ---------------------------------------------------------------------------

function UtilPanel() {
  const pushToast = useSpireStore((s) => s.pushToast);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<UtilUploadResult | null>(null);
  const [busy, setBusy] = useState<"idle" | "preview" | "apply">("idle");
  const [err, setErr] = useState<string | null>(null);

  async function runDryRun(f: File) {
    setBusy("preview");
    setErr(null);
    setPreview(null);
    setFile(f);
    try {
      const r = await api.ingest.util(f);
      setPreview(r);
    } catch (e) {
      setErr(formatApiError(e));
    } finally {
      setBusy("idle");
    }
  }

  async function runApply() {
    if (!file || !preview) return;
    setBusy("apply");
    setErr(null);
    try {
      const r = await api.ingest.util(file, { apply: true, confirm: preview.preview_token });
      setPreview(r);
      pushToast({
        tone: "ok",
        text: `Utilization applied · ${r.applied_counts?.matched ?? 0} assets updated · ${r.applied_counts?.unmatched_rows ?? 0} ghost rows`,
        ttlMs: 6000,
      });
    } catch (e) {
      setErr(formatApiError(e));
    } finally {
      setBusy("idle");
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <FileDropzone
        onFile={runDryRun}
        busy={busy !== "idle"}
        hint="6 columns expected · ASSET_ID/READING_DATE/TOTAL_HOURS/TOTAL_MILES/READINESS_CODE/READING_SOURCE"
      />
      {busy === "preview" && <LoadingState label="Parsing + matching" />}
      {err && <ErrorState title="Upload failed" description={err} />}
      {preview && !preview.applied && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] uppercase tracking-widest">
            <Stat label="parsed" value={preview.report.rows_total} />
            <Stat label="kept" value={preview.report.rows_kept} />
            {preview.preview_counts && (
              <>
                <Stat label="matched" value={preview.preview_counts.matched} tone="warning" />
                <Stat label="ghost rows" value={preview.preview_counts.unmatched_rows} tone={preview.preview_counts.unmatched_rows ? "warning" : "muted"} />
                <Stat label="skipped" value={preview.preview_counts.skipped_assets} tone="muted" />
              </>
            )}
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
            <div className="flex flex-col">
              <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
                Preview token
              </span>
              <span className="font-mono text-xs tabular-nums text-[var(--color-text-secondary)]">
                {preview.preview_token.slice(0, 12)}…
              </span>
            </div>
            <Button
              variant="primary"
              onClick={runApply}
              pending={busy === "apply"}
              disabled={busy === "apply"}
            >
              Apply to current_hours / current_miles / current_status
            </Button>
          </div>
        </div>
      )}
      {preview?.applied && (
        <div className="rounded-md border border-[var(--color-success)] bg-[color-mix(in_oklab,var(--color-success-muted)_15%,var(--color-surface))] p-3 font-mono text-xs text-[var(--color-success)]">
          Applied · {preview.applied_counts?.matched ?? 0} assets updated ·{" "}
          {preview.applied_counts?.unmatched_rows ?? 0} ghost rows
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SR-header panel — dry-run only
// ---------------------------------------------------------------------------

function SrHeaderPanel() {
  const [preview, setPreview] = useState<SrHeaderUploadResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function runDryRun(f: File) {
    setBusy(true);
    setErr(null);
    setPreview(null);
    try {
      const r = await api.ingest.srHeader(f, { cm_only: true });
      setPreview(r);
    } catch (e) {
      setErr(formatApiError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <FileDropzone
        onFile={runDryRun}
        busy={busy}
        hint="12 columns expected · the standard GCSS-MC SR-header export · CM-only filter on"
      />
      {busy && <LoadingState label="Parsing + sanitizing" />}
      {err && <ErrorState title="Upload failed" description={err} />}
      {preview && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] uppercase tracking-widest">
            <Stat label="parsed" value={preview.report.rows_total} />
            <Stat label="kept" value={preview.report.rows_kept} />
            <Stat label="filtered (PMCS)" value={preview.report.rows_filtered_pmcs} tone="muted" />
            <Stat label="warnings" value={preview.report.rows_with_warnings} tone={preview.report.rows_with_warnings ? "warning" : "muted"} />
            <Stat label="defect-code normalized" value={preview.report.defect_code_trailing_period_normalized} tone="muted" />
          </div>
          {preview.report.schema_warnings.length > 0 && (
            <div className="rounded-sm border border-[var(--color-warning)] bg-[var(--color-bg)] px-2 py-1 font-mono text-xs text-[var(--color-warning)]">
              Schema warnings: {preview.report.schema_warnings.join(" · ")}
            </div>
          )}
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-[11px] text-[var(--color-text-secondary)] tracking-wide">
            This route is the dry-run analyzer. To actually write SRs into the canonical
            dataset, push the full 3-CSV bundle (header + sr_parts + due_in) through{" "}
            <code className="rounded bg-[var(--color-surface)] px-1 py-px">{preview.applied_pointer}</code>.
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stale-asset queue
// ---------------------------------------------------------------------------

function StaleQueue() {
  const pushToast = useSpireStore((s) => s.pushToast);
  const [stale, setStale] = useState<StaleAsset[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.ingest
      .listStale()
      .then((r) => {
        if (!cancelled) setStale(r.stale);
      })
      .catch((e) => {
        if (!cancelled) setErr(formatApiError(e));
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  async function resolve(asset_id: string, action: "remove" | "confirm" | "defer") {
    setBusyId(asset_id);
    try {
      await api.ingest.resolveStale([{ asset_id, action }]);
      pushToast({ tone: "ok", text: `${asset_id} ${action}`, ttlMs: 3500 });
      setTick((t) => t + 1);
    } catch (e) {
      pushToast({ tone: "error", text: `Resolve failed: ${formatApiError(e)}` });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <div className="font-mono text-xs uppercase tracking-widest text-[var(--color-text)]">
          Stale-asset queue
        </div>
        <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
          {stale ? `${stale.length} flagged` : "loading"}
        </div>
      </div>
      {err && <ErrorState title="Stale list unavailable" description={err} />}
      {stale && stale.length === 0 && (
        <div className="font-mono text-xs text-[var(--color-text-muted)]">
          No stale assets. The roster matches the most recent ECP file.
        </div>
      )}
      {stale && stale.length > 0 && (
        <ul className="flex flex-col gap-1">
          {stale.map((s) => (
            <li
              key={s.asset_id}
              className="flex items-center justify-between gap-3 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2"
            >
              <div className="flex min-w-0 flex-col">
                <span className="font-mono text-xs text-[var(--color-text)]">
                  {s.asset_id}
                </span>
                <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
                  {s.tamcn} · {s.unit_uic || s.unit_name || "—"} · {s.nomenclature}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="secondary"
                  onClick={() => resolve(s.asset_id, "confirm")}
                  pending={busyId === s.asset_id}
                  disabled={!!busyId}
                  size="sm"
                >
                  Confirm
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => resolve(s.asset_id, "defer")}
                  pending={busyId === s.asset_id}
                  disabled={!!busyId}
                  size="sm"
                >
                  Defer
                </Button>
                <Button
                  variant="danger"
                  onClick={() => resolve(s.asset_id, "remove")}
                  pending={busyId === s.asset_id}
                  disabled={!!busyId}
                  size="sm"
                >
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
