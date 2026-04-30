import { useState } from "react";
import { api, ApiError, type ExportResult, type SentryExportManifest } from "../../api";
import type { SentryContext } from "../SentryView";
import { SegmentedControl } from "../../components/SegmentedControl";
import { useSpireStore } from "../../state/store";
import { InsufficientPrivilege } from "../../components/InsufficientPrivilege";
import { Pressable, fireIdempotent } from "../../components/ui";
import { ClassifiedExport, ClassificationBadge } from "../../components/classification";

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
  // Task-69 — surface a hard error on the result panel when the doctrinal
  // release-compatibility gate at /api/sentry/export rejects the requested
  // (classification, release_authority, caveats) combo. The build is refused
  // and `result` stays null; the operator sees the issues + a fix path.
  const [releaseBlock, setReleaseBlock] = useState<{
    classification: string;
    release_authority: string;
    caveats: string[];
    issues: string[];
  } | null>(null);
  // Manifest preview — non-destructive dry-run of /export. Lets the operator
  // sanity-check the bundle scope (counts, top units, top flags, first 100
  // SRs, estimated bytes) BEFORE committing to a real ZIP build. The panel
  // is independent of `result`/`releaseBlock`; clicking Generate Bundle
  // afterward must not auto-clear it.
  const [manifest, setManifest] = useState<SentryExportManifest | null>(null);
  const [manifestLoading, setManifestLoading] = useState(false);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const pushToast = useSpireStore((s) => s.pushToast);

  if (role !== "data_custodian" && role !== "security_manager" && role !== "mef_commander") {
    return (
      <InsufficientPrivilege
        feature="Sanitized Export"
        requiredRoles={["data_custodian", "security_manager", "mef_commander"]}
        description="Release packaging of sanitized records requires Data Custodian, Security Manager, or MEF Commander authorization."
      />
    );
  }

  async function doExport() {
    // Idempotency guard — export bundles a sanitized release. Rapid
    // double-tap on "Export Sanitized Bundle" must not register two
    // distinct export bundles for the same (batch, authority, format).
    const key = `sentry:export:${ctx.batchId ?? "no-batch"}:${authority}:${format}`;
    await fireIdempotent(key, async () => {
      setLoading(true);
      try {
        // Walkthrough #6 — pass batchId so the export covers the same batch
        // the operator just processed.
        const r = await api.sentry.export(authority, format, ctx.batchId);
        setResult(r);
        // Task-69 — clear any prior block once the build succeeds.
        setReleaseBlock(null);
        const cls = r.classification ?? "CUI";
        // Toast carries a click-through link so the operator never wonders
        // "where did the file go?" after a successful export. Reviewer caught
        // the celebratory toast having no destination.
        pushToast({
          tone: "ok",
          text: `✓ Export ${r.export_id} · ${cls} · ${(r.records_exported ?? 0).toLocaleString("en-US")} records · ${((r.bytes ?? 0) / 1024).toFixed(1)} KB`,
          link: r.download_url ? { label: "Download", href: r.download_url } : undefined,
          ttlMs: 6000,
        });
      } catch (err: unknown) {
        // Surface the spillage event distinctly when the backend gate fires.
        const detail = err instanceof ApiError && err.body && typeof err.body === "object" ? (err.body as { detail?: Record<string, unknown> }).detail : undefined;
        if (detail && detail.error === "InsufficientClearance") {
          pushToast({
            tone: "error",
            text: `Spillage prevented · backend blocked ${detail.action} (need ${detail.required_classification}, you have ${detail.user_clearance}).`,
            ttlMs: 7000,
          });
        } else if (detail && detail.error === "release_blocked") {
          // Task-69 — doctrinal release-compatibility hard block. Stamp the
          // result panel with a hard error and refuse the build.
          const issues = Array.isArray(detail.issues) ? (detail.issues as string[]) : [];
          setResult(null);
          setReleaseBlock({
            classification: String(detail.classification ?? ""),
            release_authority: String(detail.release_authority ?? authority),
            caveats: Array.isArray(detail.caveats) ? (detail.caveats as string[]) : [],
            issues,
          });
          pushToast({
            tone: "error",
            text: `Release blocked · ${detail.classification} → ${detail.release_authority} is doctrinally incompatible. ${issues[0] ?? ""}`.trim(),
            ttlMs: 8000,
          });
        } else if (detail && detail.error === "batch_not_found") {
          pushToast({
            tone: "error",
            text: `Batch ${detail.batch_id} not found. Re-run processing or pick a current batch.`,
            ttlMs: 7000,
          });
        } else if (detail && detail.error === "invalid_release_authority") {
          pushToast({
            tone: "error",
            text: `Unknown release authority "${detail.release_authority}". Allowed: ${(detail.allowed as string[] | undefined)?.join(", ")}.`,
            ttlMs: 7000,
          });
        } else {
          pushToast({ tone: "error", text: "Export failed" });
        }
      } finally {
        setLoading(false);
      }
    }, 500);
  }

  // Manifest preview — fetches /export-manifest and renders the side panel.
  // Non-destructive: no ZIP is built, no audit chain entry is committed
  // beyond the read-only manifest call itself. Surfaces inline errors
  // (not toast-only) so a failed preview is debuggable in place.
  async function loadManifest() {
    setManifestLoading(true);
    setManifestError(null);
    try {
      const m = await api.sentry.exportManifest(authority, ctx.batchId);
      setManifest(m);
      pushToast({
        tone: "ok",
        text: `Manifest preview loaded · ${m.counts.records_in_bundle.toLocaleString("en-US")} records`,
        ttlMs: 4000,
      });
    } catch (err: unknown) {
      const detail =
        err instanceof ApiError && err.body && typeof err.body === "object"
          ? (err.body as { detail?: Record<string, unknown> }).detail
          : undefined;
      let msg = "Manifest preview failed.";
      if (detail && typeof detail === "object") {
        if (detail.error === "batch_not_found") {
          msg = `Batch ${detail.batch_id} not found. Re-run processing or pick a current batch.`;
        } else if (detail.error === "invalid_release_authority") {
          const allowed = (detail.allowed as string[] | undefined)?.join(", ") ?? "";
          msg = `Unknown release authority "${detail.release_authority}". Allowed: ${allowed}.`;
        } else if (typeof detail.error === "string") {
          msg = `Manifest preview failed · ${detail.error}`;
        }
      } else if (err instanceof Error) {
        msg = `Manifest preview failed · ${err.message}`;
      }
      setManifestError(msg);
      setManifest(null);
    } finally {
      setManifestLoading(false);
    }
  }

  function closeManifest() {
    // Removes the panel from the DOM entirely — operator gets the rest of
    // the tab back. Re-opening requires another click on Preview Manifest.
    setManifest(null);
    setManifestError(null);
  }

  // The bundle classification is auto-inherited from the source records
  // server-side. Until the operator runs an export the marking is unknown;
  // default to UNCLASSIFIED so the FE doesn't pre-render a SECRET banner
  // on a synthetic-only batch. The real marking flows through
  // result.classification once the export runs; the backend re-checks
  // on every /export and /download call.
  const expectedBundleClass = result?.classification ?? "UNCLASSIFIED";

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

      <div className="flex items-center gap-4">
        <ClassifiedExport
          classification={expectedBundleClass}
          action="sentry.export"
          label="Export Sanitized Bundle"
          pendingLabel="Building bundle …"
          loading={loading}
          // Client-side gate — if the manifest preview already told us the
          // build will be doctrinally refused, disable the Generate Bundle
          // button instead of pretending it'll work. The backend still
          // re-checks and 403s on its own (defense in depth).
          disabled={!ctx.batchId || (manifest?.release_blocked ?? false)}
          disabledReason={
            !ctx.batchId
              ? "Requires a processed batch."
              : manifest?.release_blocked
              ? "Release blocked by manifest preview — change release authority or batch."
              : undefined
          }
          onExport={doExport}
        />
        <Pressable
          block={false}
          onClick={loadManifest}
          disabled={!ctx.batchId || manifestLoading}
          aria-label="Preview manifest"
          className="rounded-md border px-4 py-[10px] font-mono text-xs font-semibold uppercase tracking-widest"
          style={{
            borderColor: "var(--color-border)",
            background: "var(--color-surface)",
            color: "var(--color-text)",
          }}
          title={!ctx.batchId ? "Requires a processed batch." : "Dry-run /export · no ZIP build, no audit-chain commit"}
        >
          {manifestLoading ? "Loading preview …" : "Preview Manifest"}
        </Pressable>
        <span className="font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
          Bundle classification auto-inherits from source · {expectedBundleClass}
        </span>
      </div>

      {/* Manifest-preview side panel · non-destructive scope check.
          Sits above the success/warn/block panels so the operator can
          verify counts before clicking Generate Bundle. Closable. */}
      {manifestError && !manifest && (
        <div
          role="alert"
          className="mt-6 rounded-md border p-3 font-mono text-sm"
          style={{
            background: "color-mix(in oklab, var(--color-danger) 14%, var(--color-surface))",
            borderColor: "color-mix(in oklab, var(--color-danger) 50%, var(--color-border))",
            color: "var(--color-text)",
          }}
        >
          <div className="mb-1 font-semibold uppercase tracking-widest text-[var(--color-danger)]">
            Manifest Preview Failed
          </div>
          <div>{manifestError}</div>
        </div>
      )}

      {manifest && (
        <ManifestPreviewPanel
          manifest={manifest}
          onClose={closeManifest}
          onRefresh={loadManifest}
          refreshing={manifestLoading}
        />
      )}

      {/* Task-69 — yellow warn banner ABOVE the result panel when the
          server returned status="warn" (e.g. SECRET → FVEY without an
          explicit downgrade caveat). The bundle is built but the operator
          must confirm release authority before forwarding. */}
      {result && result.release_warnings && result.release_warnings.length > 0 && (
        <div
          role="status"
          className="mt-6 rounded-md border p-3 font-mono text-sm"
          style={{
            background: "color-mix(in oklab, var(--color-warning) 14%, var(--color-surface))",
            borderColor: "color-mix(in oklab, var(--color-warning) 50%, var(--color-border))",
            color: "var(--color-text)",
          }}
        >
          <div
            className="mb-1 font-semibold uppercase tracking-widest text-[var(--color-warning)]"
          >
            Release Warning · {result.classification ?? expectedBundleClass} → {result.release_authority}
          </div>
          <ul className="list-disc pl-5">
            {result.release_warnings.map((msg, i) => (
              <li key={i}>{msg}</li>
            ))}
          </ul>
          <div className="mt-1 text-xs text-[var(--color-text-secondary)]">
            Bundle was built. Confirm explicit release authority before forwarding to the partner.
          </div>
        </div>
      )}

      {/* Task-69 — hard error panel when the doctrinal release-compatibility
          gate refused the build. Mirrors the success panel's prominence so
          the operator can't mistake a refusal for "build prepared". */}
      {releaseBlock && (
        <div
          role="alert"
          className="mt-6 rounded-md border p-4 font-mono text-sm"
          style={{
            background: "color-mix(in oklab, var(--color-danger) 14%, var(--color-surface))",
            borderColor: "color-mix(in oklab, var(--color-danger) 50%, var(--color-border))",
            color: "var(--color-text)",
          }}
        >
          <div
            className="mb-2 font-semibold uppercase tracking-widest text-[var(--color-danger)]"
          >
            Release Blocked · doctrinally incompatible
          </div>
          <div className="mb-2">
            Refusing to build a <span className="font-semibold">{releaseBlock.classification}</span>
            {" "}bundle for release authority{" "}
            <span className="font-semibold">{releaseBlock.release_authority}</span>.
            {releaseBlock.caveats.length > 0 && (
              <>
                {" "}Aggregated caveats: <span className="font-semibold">{releaseBlock.caveats.join(", ")}</span>.
              </>
            )}
          </div>
          <ul className="list-disc pl-5">
            {releaseBlock.issues.map((msg, i) => (
              <li key={i}>{msg}</li>
            ))}
          </ul>
          <div className="mt-2 text-xs text-[var(--color-text-secondary)]">
            Logged to the audit chain as <code>release_blocked</code>. Pick a compatible release
            authority (typically <code>US_ONLY</code>), or remove the offending records from the
            batch, and re-export.
          </div>
        </div>
      )}

      {result && (
        <div className="mt-6 rounded-md border border-[var(--color-success-muted)] bg-[color-mix(in_oklab,var(--color-success-muted)_15%,var(--color-surface))] p-4">
          <div className="mb-3 flex items-baseline justify-between">
            <h4
              className="font-mono text-base font-semibold uppercase text-[var(--color-success)] tracking-widest flex items-center gap-3"
            >
              <span>Export Prepared</span>
              <ClassificationBadge
                classification={result.classification ?? "CUI"}
                size="md"
              />
            </h4>
            <span
              className="font-mono text-xs text-[var(--color-text-muted)] tracking-wide"
              title={result.created_at}
            >
              {/* Walkthrough audit: raw ISO ('2026-04-27T15:30:42Z') in the
               * Export Prepared corner read like a debug print. Render the
               * audit-grade DD MMM YYYY · HHMMz format used elsewhere. */}
              {(() => {
                const iso = result.created_at || "";
                const d = new Date(iso);
                if (Number.isNaN(d.getTime())) return iso;
                const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
                const z = (n: number) => String(n).padStart(2, "0");
                return `${z(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} · ${z(d.getUTCHours())}${z(d.getUTCMinutes())}z`;
              })()}
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
                /* Task-70 — pin the saved filename to the bundle name the
                 * backend chose (spire_<CLASS>_sanitized_<EXP>.zip) so the
                 * operator doesn't get a URL-derived gibberish filename when
                 * the browser saves the file. */
                download={result.filename ?? ""}
                className="font-mono text-base text-[var(--color-primary)] hover:underline"
              >
                {result.filename ?? result.download_url}
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
              <Pressable
                onClick={() => setExpanded(open ? null : d.sr_number)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left"
              >
                <span className="font-mono text-sm text-[var(--color-text)]">{d.sr_number}</span>
                <span className="font-mono text-xs text-[var(--color-text-muted)] tracking-wide">
                  {d.unit_name} · {d.equipment_type.replace(/_/g, " ")}
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
              </Pressable>
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

// ---------------------------------------------------------------------------
// Manifest Preview Panel — non-destructive scope check before /export.
// Renders counts, top units, top flags, first 100 SR records, estimated
// bundle size, and a prominent banner when release_blocked is true.
// ---------------------------------------------------------------------------

const PREVIEW_SR_LIMIT = 100;
const TOP_UNITS_LIMIT = 10;
const TOP_FLAGS_LIMIT = 10;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function topEntries(rec: Record<string, number>, limit: number): Array<[string, number]> {
  return Object.entries(rec)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

function ManifestPreviewPanel({
  manifest,
  onClose,
  onRefresh,
  refreshing,
}: {
  manifest: SentryExportManifest;
  onClose: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const counts = manifest.counts;
  const byClassEntries = Object.entries(counts.by_classification).sort((a, b) => b[1] - a[1]);
  const topUnits = topEntries(counts.by_unit, TOP_UNITS_LIMIT);
  const topFlags = topEntries(counts.by_flag, TOP_FLAGS_LIMIT);
  const visibleSrs = manifest.sr_records.slice(0, PREVIEW_SR_LIMIT);
  const hiddenCount = Math.max(0, manifest.sr_total - visibleSrs.length);

  return (
    <div
      className="mt-6 rounded-md border bg-[var(--color-surface)]"
      style={{
        borderColor: manifest.release_blocked
          ? "color-mix(in oklab, var(--color-danger) 50%, var(--color-border))"
          : "var(--color-border)",
      }}
    >
      <div className="flex items-center gap-3 border-b border-[var(--color-border)] px-4 py-3">
        <h4 className="font-mono text-sm font-semibold uppercase text-[var(--color-text)] tracking-widest">
          Manifest Preview
        </h4>
        <ClassificationBadge classification={manifest.classification || "UNCLASSIFIED"} size="sm" />
        <span className="font-mono text-xs text-[var(--color-text-muted)] tracking-wide">
          {manifest.release_authority} · batch {manifest.batch_source} ·{" "}
          {(() => {
            const d = new Date(manifest.as_of);
            if (Number.isNaN(d.getTime())) return manifest.as_of;
            const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
            const z = (n: number) => String(n).padStart(2, "0");
            return `${z(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} · ${z(d.getUTCHours())}${z(d.getUTCMinutes())}z`;
          })()}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Pressable
            block={false}
            onClick={onRefresh}
            disabled={refreshing}
            aria-label="Refresh manifest preview"
            className="rounded-sm border px-2 py-1 font-mono text-xs uppercase tracking-wider"
            style={{ borderColor: "var(--color-border)", color: "var(--color-text-muted)" }}
          >
            {refreshing ? "Refreshing …" : "Refresh"}
          </Pressable>
          <Pressable
            block={false}
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? "Expand manifest preview" : "Collapse manifest preview"}
            aria-expanded={!collapsed}
            className="rounded-sm border px-2 py-1 font-mono text-xs uppercase tracking-wider"
            style={{ borderColor: "var(--color-border)", color: "var(--color-text-muted)" }}
          >
            {collapsed ? "Expand" : "Collapse"}
          </Pressable>
          <Pressable
            block={false}
            onClick={onClose}
            aria-label="Close manifest preview"
            className="rounded-sm border px-2 py-1 font-mono text-xs uppercase tracking-wider"
            style={{ borderColor: "var(--color-border)", color: "var(--color-text-muted)" }}
          >
            Close
          </Pressable>
        </div>
      </div>

      {!collapsed && (
        <div className="px-4 py-4">
          {/* Doctrinal release-block banner — disables the actual Export
              button via state in the parent. Surfaced here so the operator
              can read the issues alongside the preview that produced them. */}
          {manifest.release_blocked && (
            <div
              role="alert"
              className="mb-4 rounded-md border p-3 font-mono text-sm"
              style={{
                background: "color-mix(in oklab, var(--color-danger) 14%, var(--color-surface))",
                borderColor: "color-mix(in oklab, var(--color-danger) 50%, var(--color-border))",
                color: "var(--color-text)",
              }}
            >
              <div className="mb-1 font-semibold uppercase tracking-widest text-[var(--color-danger)]">
                Release Blocked · Generate Bundle disabled
              </div>
              <div className="mb-2 text-xs text-[var(--color-text-secondary)]">
                {manifest.classification} → {manifest.release_authority} is doctrinally incompatible.
                Change release authority or remove the offending records, then refresh the preview.
              </div>
              {manifest.release_compatibility.issues.length > 0 && (
                <ul className="list-disc pl-5">
                  {manifest.release_compatibility.issues.map((msg, i) => (
                    <li key={i}>{msg}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Counts row */}
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat
              label="In Bundle"
              value={counts.records_in_bundle.toLocaleString("en-US")}
            />
            <Stat
              label="Rejected"
              value={counts.records_rejected.toLocaleString("en-US")}
            />
            <Stat
              label="Estimated Size"
              value={formatBytes(manifest.estimated_bytes)}
            />
            <Stat
              label="Files in ZIP"
              value={`${manifest.estimated_files_in_zip}`}
            />
          </div>

          <div className="mb-4">
            <StatLabel>By Classification</StatLabel>
            <div className="mt-1 flex flex-wrap gap-2">
              {byClassEntries.length === 0 && (
                <span className="font-mono text-xs text-[var(--color-text-muted)]">—</span>
              )}
              {byClassEntries.map(([cls, n]) => (
                <span
                  key={cls}
                  className="rounded-sm border px-2 py-[2px] font-mono text-xs tracking-wide"
                  style={{
                    borderColor: "var(--color-border)",
                    color: "var(--color-text)",
                    background: "var(--color-bg)",
                  }}
                >
                  <span className="font-semibold uppercase tracking-widest">{cls}</span>
                  <span className="ml-2 tabular-nums text-[var(--color-text-muted)]">
                    {n.toLocaleString("en-US")}
                  </span>
                </span>
              ))}
            </div>
          </div>

          <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <StatLabel>Top Units · {topUnits.length} of {Object.keys(counts.by_unit).length}</StatLabel>
              <div className="mt-1 flex flex-col gap-1">
                {topUnits.length === 0 && (
                  <span className="font-mono text-xs text-[var(--color-text-muted)]">—</span>
                )}
                {topUnits.map(([unit, n]) => (
                  <div
                    key={unit}
                    className="flex items-center justify-between rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 font-mono text-xs"
                  >
                    <span className="text-[var(--color-text)]">{unit}</span>
                    <span className="tabular-nums text-[var(--color-text-muted)]">
                      {n.toLocaleString("en-US")}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <StatLabel>Top Flags · {topFlags.length} of {Object.keys(counts.by_flag).length}</StatLabel>
              <div className="mt-1 flex flex-col gap-1">
                {topFlags.length === 0 && (
                  <span className="font-mono text-xs text-[var(--color-text-muted)]">—</span>
                )}
                {topFlags.map(([flag, n]) => (
                  <div
                    key={flag}
                    className="flex items-center justify-between rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 font-mono text-xs"
                  >
                    <span
                      className="font-semibold uppercase tracking-wider"
                      style={{ color: FLAG_COLOR[flag] || "var(--color-text)" }}
                    >
                      {flag}
                    </span>
                    <span className="tabular-nums text-[var(--color-text-muted)]">
                      {n.toLocaleString("en-US")}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div>
            <StatLabel>
              SR Records · showing {visibleSrs.length} of {manifest.sr_total.toLocaleString("en-US")}
            </StatLabel>
            <div
              className="mt-1 max-h-72 overflow-y-auto rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)]"
            >
              {visibleSrs.length === 0 && (
                <div className="px-3 py-2 font-mono text-xs text-[var(--color-text-muted)]">
                  No records in bundle.
                </div>
              )}
              {visibleSrs.map((sr) => (
                <div
                  key={sr.sr_number}
                  className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-1 font-mono text-xs last:border-b-0"
                >
                  <span className="text-[var(--color-text)]">{sr.sr_number}</span>
                  <span className="text-[var(--color-text-muted)]">{sr.unit}</span>
                  <span className="text-[var(--color-text-muted)]">
                    {sr.equipment_type.replace(/_/g, " ")}
                  </span>
                  <span className="ml-auto flex items-center gap-1">
                    <span
                      className="rounded-sm border px-1 py-[1px] font-semibold uppercase tracking-wider"
                      style={{
                        borderColor: "var(--color-border)",
                        color: "var(--color-text)",
                      }}
                    >
                      {sr.classification}
                    </span>
                    {sr.flags.map((f) => (
                      <span
                        key={f}
                        className="rounded-sm border px-1 py-[1px] font-semibold uppercase tracking-wider"
                        style={{
                          color: FLAG_COLOR[f] || "var(--color-text-muted)",
                          borderColor: `color-mix(in oklab, ${FLAG_COLOR[f] || "#666"} 40%, var(--color-border))`,
                        }}
                      >
                        {f}
                      </span>
                    ))}
                  </span>
                </div>
              ))}
            </div>
            {(manifest.preview_truncated || hiddenCount > 0) && (
              <div className="mt-1 font-mono text-xs text-[var(--color-text-muted)] tracking-wide">
                truncated — {hiddenCount.toLocaleString("en-US")} more not shown
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Task-70 / Walkthrough #5 — Distribution Statements (A-F) and REL TO caveats
// are independent. Earlier blurbs conflated them and were doctrinally wrong
// ("Distribution A · public release" for U.S.-only is the OPPOSITE meaning;
// Distribution E means DoD components only, not partner). Pre-export the
// final letter depends on the source classification (UNCLASSIFIED→A, CUI→B,
// SECRET+→C), so the blurb hints at the range rather than overpromising. The
// Export Prepared panel below shows the actual derived letter post-build.
const DISTRIBUTION_BLURB: Record<Authority, string> = {
  US_ONLY:  "U.S.-only release · Distribution Statement derived per DoDI 5230.24 (UNCLASSIFIED → A; CUI → B; SECRET+ → C). No foreign release.",
  FVEY:     "Five-Eyes release · Distribution C · REL TO USA, AUS, CAN, GBR, NZL.",
  NATO:     "NATO release · Distribution C · REL TO NATO. Further distribution requires originator approval.",
  SPECIFIC: "Specific partner release · Distribution C · originator-controlled per coalition agreement.",
};
