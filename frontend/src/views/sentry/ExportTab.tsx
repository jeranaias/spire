import { useEffect, useState } from "react";
import { api, ApiError, type DistributionOverride, type ExportResult } from "../../api";
import type { SentryContext } from "../SentryView";
import { SegmentedControl } from "../../components/SegmentedControl";
import { useSpireStore } from "../../state/store";
import { InsufficientPrivilege } from "../../components/InsufficientPrivilege";
import { Pressable, fireIdempotent } from "../../components/ui";
import {
  ClassifiedExport,
  ClassificationBadge,
  MaskedSpan,
  RedactionToggle,
  usePiiRedaction,
  type PiiRedactionController,
} from "../../components/classification";

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

// Task-108 — Distribution Statement override options. AUTO keeps the
// (release, classification)-derived letter; A-F force a specific letter.
// Per-letter blurbs come straight from DoDI 5230.24 so a Marine doesn't have
// to leave the screen to look it up.
const DISTRIBUTION_OPTIONS: { value: DistributionOverride; label: string; blurb: string }[] = [
  { value: "AUTO", label: "Auto (derived)", blurb: "Let SPIRE derive A-F from release authority + classification per DoDI 5230.24." },
  { value: "A",    label: "A — Public release",  blurb: "Approved for public release; distribution unlimited. UNCLASSIFIED only." },
  { value: "B",    label: "B — USG agencies",    blurb: "U.S. Government agencies only. Other requests routed to the originator." },
  { value: "C",    label: "C — USG + contractors", blurb: "U.S. Government agencies and their contractors. Further dist. originator-controlled." },
  { value: "D",    label: "D — DoD + DoD contractors", blurb: "Department of Defense and U.S. DoD contractors only — narrower than C." },
  { value: "E",    label: "E — DoD only",        blurb: "DoD components only. Excludes contractors." },
  { value: "F",    label: "F — Originator-controlled", blurb: "Further dissemination only as directed by the originating office." },
];

export function ExportTab({ ctx }: { ctx: SentryContext }) {
  const role = useSpireStore((s) => s.role);
  const [authority, setAuthority] = useState<Authority>("US_ONLY");
  const [format, setFormat] = useState<Format>("xlsx");
  // Task-108 — operator-chosen Distribution Statement letter; "AUTO" keeps
  // the system-derived behavior (UNCLASSIFIED → A, CUI → B, SECRET+ → C).
  const [distributionOverride, setDistributionOverride] = useState<DistributionOverride>("AUTO");
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
  const pushToast = useSpireStore((s) => s.pushToast);
  // Task #176 — clear the persisted SENTRY batch handles when this
  // export succeeds. The operator is done with the batch; leaving the
  // localStorage IDs in place would strand the next session on a stale
  // batch (or worse, on a different operator's batch after CAC swap
  // didn't sign out cleanly).
  const setSentryBatch = useSpireStore((s) => s.setSentryBatch);

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
    // Idempotency guard — export bundles a sanitized release. Rapid
    // double-tap on "Export Sanitized Bundle" must not register two
    // distinct export bundles for the same (batch, authority, format).
    const key = `sentry:export:${ctx.batchId ?? "no-batch"}:${authority}:${format}:${distributionOverride}`;
    await fireIdempotent(key, async () => {
      setLoading(true);
      try {
        // Walkthrough #6 — pass batchId so the export covers the same batch
        // the operator just processed.
        // Task-108 — pass the operator's Distribution Statement choice so
        // the backend can stamp / validate the letter against bundle class.
        const r = await api.sentry.export(authority, format, ctx.batchId, distributionOverride);
        setResult(r);
        // Task-69 — clear any prior block once the build succeeds.
        setReleaseBlock(null);
        // Task #176 — operator finished the batch. Drop the persisted
        // batch / job IDs so a reload after this point lands them on
        // Upload (the natural next-batch start) instead of replaying a
        // job that's already been shipped.
        setSentryBatch(null, null);
        const cls = r.classification ?? "CUI";
        const warnings = r.release_warnings ?? [];
        // Task #101 — when the doctrinal release-compatibility gate
        // returned warnings (e.g. SECRET → FVEY without an explicit
        // downgrade caveat) the bundle was built but the operator must
        // confirm release authority before forwarding. Escalate the
        // celebratory toast to a warn tone so the requirement follows
        // the operator off-page (the on-page banner alone isn't enough
        // if they navigate away after submitting).
        if (warnings.length > 0) {
          pushToast({
            tone: "warn",
            text: `✓ Built ${r.export_id} · ${cls} → ${r.release_authority ?? authority} · release review required (downgrade authority must confirm before forwarding).`,
            link: r.download_url ? { label: "Download", href: r.download_url } : undefined,
            ttlMs: 9000,
          });
        } else {
          // Toast carries a click-through link so the operator never wonders
          // "where did the file go?" after a successful export. Reviewer caught
          // the celebratory toast having no destination.
          pushToast({
            tone: "ok",
            text: `✓ Export ${r.export_id} · ${cls} · ${(r.records_exported ?? 0).toLocaleString("en-US")} records · ${((r.bytes ?? 0) / 1024).toFixed(1)} KB`,
            link: r.download_url ? { label: "Download", href: r.download_url } : undefined,
            ttlMs: 6000,
          });
        }
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
        } else if (detail && detail.error === "invalid_distribution_override") {
          // Task-108 — backend refused the operator's Distribution Statement
          // choice (e.g. Distribution A on a SECRET bundle). Surface the
          // doctrinal reason in a toast and leave the result panel as-is so
          // the operator can change the dropdown and try again without losing
          // their other selections.
          const reason = typeof detail.reason === "string"
            ? detail.reason
            : `Letter ${detail.distribution_override} is not allowed on ${detail.classification ?? "this bundle"}.`;
          pushToast({
            tone: "error",
            text: `Distribution ${detail.distribution_override ?? "?"} rejected · ${reason}`,
            ttlMs: 8000,
          });
        } else {
          pushToast({ tone: "error", text: "Export failed" });
        }
      } finally {
        setLoading(false);
      }
    }, 500);
  }

  // Single-artifact path of the `<ClassifiedExport>` API: the bundle is
  // assembled, redacted, and stamped *server-side*. The FE never enumerates
  // the source records, so there is nothing to row-stamp from here — the
  // server's `result.classification` is the authoritative roll-up and we
  // pass it via `classification`. Pre-export we don't yet know the level;
  // default to SECRET because canonical batches always contain at least one
  // SECRET-tier record (the redaction report itself surfaces them). This is
  // the gate the FE primitive renders against — the backend re-checks on
  // every /export and /download call. (The `rows={…}` form of the primitive
  // exists for surfaces like Audit · SOC View that DO assemble bundles
  // client-side; see components/classification/README.md for the rule.)
  const expectedBundleClass = result?.classification ?? "SECRET";

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

          {/* Task-108 — Distribution Statement override. Sits next to the
              release-authority picker so the release officer can force a
              specific letter (e.g. D on a sanitized SECRET extract) when
              the (release, classification) tuple can't express the handling
              constraint. AUTO keeps today's derived behavior. The blurb
              underneath spells out the chosen letter so a Marine doesn't
              have to look it up in DoDI 5230.24. */}
          <div className="mt-4 border-t border-[var(--color-border)] pt-3">
            <label
              htmlFor="sentry-export-distribution"
              className="mb-2 block font-mono text-xs font-semibold uppercase text-[var(--color-text-muted)] tracking-widest"
            >
              Distribution Statement
            </label>
            <select
              id="sentry-export-distribution"
              value={distributionOverride}
              onChange={(e) => setDistributionOverride(e.target.value as DistributionOverride)}
              className="w-full rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 font-mono text-sm text-[var(--color-text)] focus:border-[var(--color-primary)] focus:outline-none"
            >
              {DISTRIBUTION_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            <div className="mt-2 font-mono text-xs text-[var(--color-text-muted)] tracking-wide">
              {DISTRIBUTION_OPTIONS.find((o) => o.value === distributionOverride)?.blurb}
            </div>
            {distributionOverride !== "AUTO" && (
              <div className="mt-1 font-mono text-xs text-[var(--color-warning)] tracking-wide">
                Override · backend will validate against bundle classification and audit your choice.
              </div>
            )}
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
          disabled={!ctx.batchId}
          disabledReason="Requires a processed batch."
          onExport={doExport}
        />
        <span className="font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
          Bundle classification auto-inherits from source · {expectedBundleClass}
        </span>
      </div>

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
              {/* Task-172 — render the letter + a one-line "why" tooltip
                  naming the dominant evidence (controlled serials, comms,
                  classification level, etc.) so an operator hovering can see
                  *which content* drove the chosen letter.
                  Task-108 — when an operator forces a letter via the export
                  dropdown, render an Override chip alongside the value, and
                  surface the letter SPIRE would have auto-derived if it
                  differs. */}
              <div
                className="font-mono text-sm text-[var(--color-text)] flex items-center gap-2"
                title={result.distribution_reason ?? "Selected per DoDI 5230.24."}
              >
                <span>{result.distribution_authority ?? "—"}</span>
                {result.distribution_source === "override" && (
                  <span
                    className="rounded-sm border px-1.5 py-[1px] font-mono text-xs font-semibold uppercase tracking-wider"
                    style={{
                      color: "var(--color-warning)",
                      borderColor: "color-mix(in oklab, var(--color-warning) 50%, var(--color-border))",
                      background: "color-mix(in oklab, var(--color-warning) 12%, transparent)",
                    }}
                    title={
                      result.distribution_derived_letter && result.distribution_derived_letter !== result.distribution_letter
                        ? `Operator override · system would have derived Distribution ${result.distribution_derived_letter}`
                        : "Operator override · audit row recorded"
                    }
                  >
                    Override
                    {result.distribution_derived_letter && result.distribution_derived_letter !== result.distribution_letter
                      ? ` (auto: ${result.distribution_derived_letter})`
                      : ""}
                  </span>
                )}
              </div>
              <div className="text-xs text-[var(--color-text-secondary)]">
                Controls who can access (DoDI 5230.24).
              </div>
              {result.distribution_reason && (
                <div className="mt-1 font-mono text-xs text-[var(--color-text-muted)] tracking-wide">
                  Why: {result.distribution_reason}
                </div>
              )}
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
            <SampleDiffPanel
              diffs={result.sample_diffs}
              recordClass={result.classification ?? "SECRET"}
              exportId={result.export_id}
            />
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

function SampleDiffPanel({
  diffs,
  recordClass,
  exportId,
}: {
  diffs: DiffSample[];
  recordClass: string;
  exportId?: string;
}) {
  const [expanded, setExpanded] = useState<string | null>(diffs[0]?.sr_number ?? null);
  // Task #169 — same click-to-reveal PII gate the Review Queue inspector
  // uses, scoped to this export's diff panel. recordClass tracks the
  // bundle's effective classification so the gate authorises against the
  // strictest level the export contains. Reset on export_id change so a
  // freshly-built bundle doesn't inherit reveals from the previous one.
  const piiRedaction = usePiiRedaction(recordClass);
  // Reset reveals whenever a new export bundle replaces the prior one.
  // We piggy-back on `exportId` because the diff list is stable within a
  // single bundle but flips wholesale when the operator re-exports.
  useEffect(() => {
    piiRedaction.resetRevealed();
  }, [exportId, piiRedaction.resetRevealed]);
  return (
    <div className="mt-4 border-t border-[var(--color-border)] pt-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="font-mono text-xs font-semibold uppercase text-[var(--color-text-muted)] tracking-widest">
          Before / After · {diffs.length} Sample Records
        </div>
        {/* Task #169 — projection/redaction toggle. Black ██ blocks
            replace the strike-through originals on the left pane until
            the operator clicks to reveal (or flips off projection mode). */}
        <RedactionToggle controller={piiRedaction} variant="compact" className="shrink-0" />
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
                        controller={piiRedaction}
                        keyPrefix={`export:${d.sr_number}`}
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
  controller,
  keyPrefix,
}: {
  original: string;
  spans: NonNullable<DiffSample["removed_spans"]>;
  controller: PiiRedactionController;
  keyPrefix: string;
}) {
  if (!spans || spans.length === 0) return <>{original}</>;
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const out: React.ReactNode[] = [];
  let cursor = 0;
  for (let i = 0; i < sorted.length; i++) {
    const sp = sorted[i];
    if (sp.start < cursor) continue;
    if (sp.start > cursor) out.push(<span key={`p${i}`}>{original.slice(cursor, sp.start)}</span>);
    // Task #169 — the pre-redaction substring (PII / geo / classified
    // identifier) renders as a black ██ block by default and reveals
    // (with the strike-through styling) only on click + clearance +
    // projection-off. Category drives the accent stripe.
    out.push(
      <MaskedSpan
        key={`s${i}`}
        controller={controller}
        spanKey={`${keyPrefix}:span:${i}`}
        text={sp.before}
        category={mapExportSpanToCategory(sp.category)}
        alwaysMask
        revealedClassName="rounded-sm px-0.5 line-through decoration-2"
        revealedStyle={{
          background: "color-mix(in oklab, var(--color-danger) 16%, transparent)",
          color: "var(--color-danger)",
        }}
      />,
    );
    cursor = sp.end;
  }
  if (cursor < original.length) out.push(<span key="tail">{original.slice(cursor)}</span>);
  return <>{out}</>;
}

// Map the backend's removed_span category strings (already lowercase
// "pii"/"geo"/"comms"/"classified"/"controlled") onto the inspector
// palette. Falls through to "pii" for unknown categories — the safe
// default for any value the backend tagged as worth redacting.
function mapExportSpanToCategory(category: string | undefined): string {
  const c = (category ?? "").toLowerCase();
  if (c === "geo" || c === "comms" || c === "classified" || c === "controlled" || c === "pii") return c;
  return "pii";
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
