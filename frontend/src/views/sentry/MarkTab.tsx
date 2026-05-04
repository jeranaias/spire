import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { api, type MarkResult, type MarkExplainResult, type SentryBulkMarkRow } from "../../api";
import { formatApiError } from "../../api-retry";
import { SegmentedControl } from "../../components/SegmentedControl";
import { useSpireStore } from "../../state/store";
import { DemoOnly } from "../../state/buildMode";
import { InsufficientPrivilege } from "../../components/InsufficientPrivilege";
import { Pressable } from "../../components/ui";
import { ClassifiedExport } from "../../components/classification";

// Recent attestations — cap is intentionally small. The localStorage
// payload holds enough to re-render the row + show the JSON the
// operator already downloaded; full audit history lives server-side.
const ATTESTATION_STORE_KEY = "spire.markdraft.attestations.v1";
const ATTESTATION_CAP = 10;

interface AttestationRecord {
  ts: number;
  classification: string;
  recommended_marking: string;
  caveats: string[];
  input_hash: string;
  chain_index: number | null;
  attestation: any;
}

function loadAttestations(): AttestationRecord[] {
  try {
    const raw = window.localStorage.getItem(ATTESTATION_STORE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveAttestation(rec: AttestationRecord) {
  const list = [rec, ...loadAttestations()].slice(0, ATTESTATION_CAP);
  try {
    window.localStorage.setItem(ATTESTATION_STORE_KEY, JSON.stringify(list));
  } catch {
    // localStorage may be full or unavailable; swallow — the audit chain
    // already persisted server-side.
  }
}

const RELEASE_AUTHS = [
  { value: "US_ONLY", label: "U.S." },
  { value: "FVEY",    label: "FVEY" },
  { value: "NATO",    label: "NATO" },
] as const;

type Auth = typeof RELEASE_AUTHS[number]["value"];

// Walkthrough #5 / Task-61 — Distribution Statement (A-F) and REL TO caveat
// are independent fields, both now driven by the backend engine instead of a
// hardcoded "Distribution C" lookup. The fallback below only fires when the
// engine response hasn't arrived yet.
const REL_TO_FALLBACK: Record<Auth, string> = {
  US_ONLY: "",
  FVEY:    "REL TO USA, AUS, CAN, GBR, NZL",
  NATO:    "REL TO NATO",
};

const SAMPLES = [
  {
    label: "Motor pool fault remark",
    text:
      "Veh exhibited trans fluid leak from output shaft area during ops. Approx 1 qt on ground after overnight. Traced to output seal failure IAW TM 9-2320-391-20. Replaced seal and gasket set. POC: Cpl Davis R. / ext 4827",
  },
  {
    label: "Radar fault (classified TM)",
    text:
      "Phased array calibration exceeding [REDACTED] threshold during BIT. 6 T/R modules showing degraded output. DL'd for depot-level calibration per [CLASSIFIED TM XX-XXXX-XXX-XX-X]. POC: SSgt Martinez J. / EDIPI 9910042851",
  },
  {
    label: "Deployed convoy brief",
    text:
      "Convoy SP at 18S UJ 23648 60819 heading NE. 4 x MTVR + 1 x JLTV. Reported on TAD Net 30.050 MHz to BN COC. Route clearance confirmed, no further action.",
  },
];

export function MarkTab() {
  const role = useSpireStore((s) => s.role);
  // Walkthrough #3 — uncontrolled textarea so fast typing doesn't drop
  // characters through React's controlled-input round-trip.
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // textVersion was the textarea's `key` so explicit-clear flows could
  // force a remount + reset to defaultValue="". Now retained only as the
  // key, never bumped during sample loads (that was the bug — bumping
  // here destroyed the value loadSample had just written).
  const [textVersion] = useState(0);
  const [release, setRelease] = useState<Auth>("US_ONLY");
  const [result, setResult] = useState<MarkResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const pushToast = useSpireStore((s) => s.pushToast);
  const debounceRef = useRef<number | null>(null);
  const latestTextRef = useRef<string>("");

  // Tier-2 grounded-explainer (Gemma) state — opt-in. Not auto-fired
  // on every keystroke so /mark stays cheap; the operator clicks
  // "Explain with Gemma" to spend a tier-2 call.
  const [explain, setExplain] = useState<MarkExplainResult | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [explainError, setExplainError] = useState<string | null>(null);

  // Bulk Mark Draft (CSV) state — drops a CSV with a `text` column,
  // gets back tier-1 marks ranked by needs-review.
  const [bulkRows, setBulkRows] = useState<SentryBulkMarkRow[] | null>(null);
  const [bulkCounts, setBulkCounts] = useState<{
    needs_review: number;
    auto_clear: number;
    UNCLASSIFIED?: number;
    CUI?: number;
  } | null>(null);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkSourceName, setBulkSourceName] = useState<string | null>(null);

  // Recent attestations — replay from localStorage so the operator can
  // see what they downloaded earlier without re-running the engine.
  const [attestations, setAttestations] = useState<AttestationRecord[]>(() => loadAttestations());
  const [attestationView, setAttestationView] = useState<AttestationRecord | null>(null);

  if (role !== "data_custodian" && role !== "security_manager" && role !== "mef_commander") {
    return (
      <InsufficientPrivilege
        feature="Mark Draft"
        requiredRoles={["data_custodian", "security_manager", "mef_commander"]}
        description="Classification-marking recommendations alter records' authoritative marking and require Data Custodian, Security Manager, or MEF Commander privileges per DoDM 5200.01."
      />
    );
  }

  function scheduleMark(immediate = false) {
    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const text = (textareaRef.current?.value ?? "").trim();
    latestTextRef.current = text;
    if (!text) {
      setResult(null);
      setExplain(null);
      setExplainError(null);
      return;
    }
    // Tier-2 explanation is anchored on the previous text+result; if
    // the text changes the cached explanation no longer applies. Clear
    // it here so a stale paragraph doesn't render under fresh evidence.
    setExplain(null);
    setExplainError(null);
    const ms = immediate ? 0 : 250;
    debounceRef.current = window.setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        // Walkthrough #3 — re-fire engine on every input change. The audit
        // timestamp returned advances on every fresh response so the right
        // pane never shows stale evidence/timestamp from a prior input.
        const r = await api.sentry.mark(latestTextRef.current, release);
        setResult(r);
      } catch (e) {
        setError(formatApiError(e));
      } finally {
        setLoading(false);
      }
    }, ms);
  }

  // Tier-2 grounded-explainer — Gemma writes a paragraph anchored on
  // the Tier-1 evidence spans + a redacted phrasing the operator can
  // copy. Opt-in to keep /mark cheap; this is one Gemma call per click.
  async function runExplain() {
    const text = (textareaRef.current?.value ?? "").trim();
    if (!text || !result) return;
    setExplaining(true);
    setExplainError(null);
    try {
      const r = await api.sentry.explain(text, {
        classification: result.recommended_classification,
        flags: result.flags,
        highlights: result.evidence.map((e) => ({
          category: e.flag,
          rule: e.rule,
          text: e.evidence,
          // start/end aren't returned on /mark's evidence shape today;
          // /explain accepts a tier1 *summary* and re-runs tier1 on
          // the server side if highlights lack offsets, so passing the
          // text-only triple is fine.
        })),
      });
      setExplain(r);
    } catch (e) {
      setExplainError(formatApiError(e));
    } finally {
      setExplaining(false);
    }
  }

  // Bulk Mark Draft — drag a CSV with a `text` column (or any single
  // column treated as text). Server returns tier-1 results ranked by
  // needs-review so the highest-risk rows surface first.
  async function handleBulkCsv(file: File) {
    setBulkLoading(true);
    setBulkError(null);
    setBulkRows(null);
    setBulkCounts(null);
    setBulkSourceName(file.name);
    try {
      const text = await file.text();
      const rows = parseCsvForBulk(text);
      if (rows.length === 0) {
        setBulkError("No text rows detected — first column should hold the draft remark, or include a `text` column.");
        return;
      }
      const r = await api.sentry.markBulk(rows);
      setBulkRows(r.results);
      setBulkCounts(r.counts);
      pushToast({
        tone: "ok",
        text: `Bulk mark: ${r.row_count} rows · ${r.counts.needs_review} need review`,
      });
    } catch (e) {
      setBulkError(formatApiError(e));
    } finally {
      setBulkLoading(false);
    }
  }

  // Walkthrough #3 — release-authority change re-fires the engine.
  useEffect(() => {
    if ((textareaRef.current?.value ?? "").trim()) {
      scheduleMark(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [release]);

  // Cold-start auto-seed: drop the first sample remark into the textarea
  // on first mount so a new operator immediately sees a working Tier-1
  // recommendation (classification + caveats + REL TO + distribution
  // statement) without clicking anything. Persists "seen" so the auto-
  // seed never overwrites a returning operator's in-progress draft.
  // Sample rotation: cycle through SAMPLES across visits so the operator
  // sees variety on repeat dismissals.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const seenKey = "spire.sentry.mark.autoseed.seen.v1";
    const idxKey = "spire.sentry.mark.autoseed.idx.v1";
    if (window.localStorage.getItem(seenKey) === "1") return;
    if ((textareaRef.current?.value ?? "").trim()) return;
    const idx = Math.max(
      0,
      Number(window.localStorage.getItem(idxKey) ?? "0") % SAMPLES.length,
    );
    const sample = SAMPLES[idx];
    if (!sample) return;
    if (textareaRef.current) {
      textareaRef.current.value = sample.text;
      latestTextRef.current = sample.text;
    }
    scheduleMark(true);
    window.localStorage.setItem(seenKey, "1");
    window.localStorage.setItem(idxKey, String((idx + 1) % SAMPLES.length));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function loadSample(preset: string) {
    // Bug: this used to bump `textVersion` after writing the value,
    // which is the textarea's `key` prop — React unmounts the
    // existing textarea and remounts it with `defaultValue=""`,
    // wiping the value we just wrote. Sample badges then appeared
    // to do nothing. Just write the value and schedule the mark
    // against the existing textarea.
    if (textareaRef.current) {
      textareaRef.current.value = preset;
      // Keep the latest-text ref in sync so the engine call uses the
      // sample's text, not whatever was there before.
      latestTextRef.current = preset;
    }
    scheduleMark(true);
  }

  return (
    <div className="flex h-full overflow-hidden">
      {attestationView && (
        <AttestationViewerModal
          rec={attestationView}
          onClose={() => setAttestationView(null)}
          onCopy={() => {
            try {
              navigator.clipboard?.writeText(JSON.stringify(attestationView.attestation, null, 2));
              pushToast({ tone: "ok", text: "Attestation JSON copied to clipboard" });
            } catch {
              pushToast({ tone: "warn", text: "Clipboard unavailable — copy manually" });
            }
          }}
        />
      )}
      <div className="flex w-1/2 flex-col overflow-y-auto border-r border-[var(--color-border)] p-4">
        <h2 className="mb-1 text-sm font-semibold">Upstream marking — recommend before release</h2>
        <DemoOnly>
          <div className="mb-4 text-xs text-[var(--color-text-muted)]">
            Paste a paragraph, remark, or draft section. The pattern engine returns a recommended
            classification and caveat set per DoDM 5200.01. Recommendations refresh automatically
            as you type or change release authority.
          </div>
        </DemoOnly>

        <DemoOnly>
          <div className="mb-2 flex flex-wrap gap-2">
            {SAMPLES.map((s) => (
              <Pressable
                key={s.label}
                onClick={() => loadSample(s.text)}
                block={false}
                className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1 text-sm text-[var(--color-text-secondary)] hover:border-[var(--color-border-active)] hover:text-[var(--color-text)]"
              >
                {s.label}
              </Pressable>
            ))}
          </div>
        </DemoOnly>

        <textarea
          ref={textareaRef}
          // Walkthrough #3 — uncontrolled. defaultValue avoids the batched-
          // render path that was dropping fast-typed characters.
          defaultValue=""
          key={textVersion}
          onChange={() => scheduleMark(false)}
          placeholder="Paste a draft paragraph, SR remark, or operational text..."
          className="min-h-[240px] flex-1 resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 font-mono text-sm leading-relaxed text-[var(--color-text)] focus:border-[var(--color-primary)] focus:outline-none"
        />

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <span
            className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest"
          >
            Release Authority
          </span>
          <SegmentedControl
            value={release}
            options={RELEASE_AUTHS.map((r) => ({ value: r.value, label: r.label }))}
            onChange={setRelease}
          />
          <span className="ml-auto font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
            {loading ? "Marking …" : "Live · auto-refreshes"}
          </span>
          {error && <span className="text-xs text-[var(--color-danger)]">{error}</span>}
        </div>

        {/* Bulk Mark Draft (CSV drop). Real action: POSTs every row to
            /sentry/mark/bulk and renders the ranked queue. SSgts who
            keep their remarks in spreadsheets can pre-clear the queue
            here instead of pasting one at a time. */}
        <BulkMarkDropzone
          onFile={handleBulkCsv}
          loading={bulkLoading}
          error={bulkError}
          rows={bulkRows}
          counts={bulkCounts}
          sourceName={bulkSourceName}
          onClear={() => {
            setBulkRows(null);
            setBulkCounts(null);
            setBulkError(null);
            setBulkSourceName(null);
          }}
          onPickRow={(row) => {
            // Send the row's preview to the live Mark Draft pane so
            // the operator can drill into it. The bulk endpoint stops
            // at preview text (120 chars); for full re-mark the row's
            // preview is sufficient since the engine already classified
            // the full row server-side.
            if (textareaRef.current && row.preview) {
              textareaRef.current.value = row.preview;
              latestTextRef.current = row.preview;
              scheduleMark(true);
            }
          }}
        />

        {/* Recent attestations — local-storage backed, shows what was
            downloaded earlier so the operator can re-open the JSON
            without re-running the engine. The audit chain stays the
            permanent record server-side. */}
        <RecentAttestationsPanel
          items={attestations}
          onView={(rec) => setAttestationView(rec)}
          onClear={() => {
            try {
              window.localStorage.removeItem(ATTESTATION_STORE_KEY);
            } catch {}
            setAttestations([]);
          }}
        />
      </div>

      <div className="flex w-1/2 flex-col overflow-y-auto p-4">
        {!result && (
          <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-muted)]">
            Submit text to see the marking recommendation.
          </div>
        )}
        {result && (
          <>
            <MarkingBanner result={result} />

            {/* Walkthrough #4 — release-authority validator banner. */}
            {result.release_compatibility && result.release_compatibility.status !== "ok" && (
              <ReleaseCompatibilityBanner compat={result.release_compatibility} />
            )}

            {/* Walkthrough #5 / Task-61 — Distribution Statement + REL TO
                caveat side-by-side, both selected by the engine from
                content + release authority. */}
            <DistributionAuthorityPanel result={result} release={release} />

            <div className="mb-4 flex items-center gap-3">
              <div className="font-mono text-sm text-[var(--color-text-secondary)] tracking-wide">
                {/* Honesty pass — `confidence` is a heuristic from the
                 * Tier-1 rule engine, not an AI confidence. Labelled
                 * accordingly so an operator doesn't read "78%" as the
                 * model's certainty. The tier-2 explainer (Gemma)
                 * surfaces a separate grounded read in its own panel. */}
                Rule confidence{" "}
                <span
                  className="tabular-nums text-[var(--color-text)]"
                  title="Tier-1 rule-engine heuristic — not a model probability"
                >
                  {(result.confidence * 100).toFixed(0)}%
                </span>
                <span className="mx-2 text-[var(--color-border-active)]">│</span>
                Release: <span className="text-[var(--color-text)]">{result.release_authority_requested}</span>
              </div>
              <div className="ml-auto">
                <ClassifiedExport
                  classification={result.recommended_classification}
                  caveats={result.caveats_recommended}
                  action="sentry.mark.attestation"
                  label="↓ Attestation"
                  pendingLabel="…"
                  loading={downloading}
                  disabled={result.release_compatibility?.status === "block"}
                  disabledReason={
                    result.release_compatibility?.status === "block"
                      ? "Cannot generate attestation while release is blocked."
                      : undefined
                  }
                  onExport={async (cls) => {
                    setDownloading(true);
                    try {
                      const text = textareaRef.current?.value ?? "";
                      // Visible classification banner stamped at the top of
                      // the attestation file. Top-level field on the JSON so
                      // any downstream parser can route by sensitivity
                      // without inspecting nested rules.
                      const banner = cls === "TS_SCI" ? "TOP SECRET // SCI" : cls.replace("_", " ");
                      const attest = {
                        _classification: cls,
                        _classification_banner: `// CLASSIFICATION: ${banner} //`,
                        _handling: "Handle per DoDM 5200.01",
                        input_hash: await sha256(text),
                        recommended_marking: result.recommended_classification,
                        caveats: result.caveats_recommended,
                        confidence: result.confidence,
                        evidence: result.evidence,
                        release_compatibility: result.release_compatibility,
                        engine: result.audit.engine,
                        timestamp: result.audit.timestamp,
                        release_authority: release,
                      };
                      const blob = new Blob([JSON.stringify(attest, null, 2)], { type: "application/json" });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      // Filename inherits classification so the marking is
                      // visible on disk before the file is ever opened.
                      const safeCls = cls.replace(/\//g, "_");
                      a.download = `spire_${safeCls}_mark_attestation_${Date.now()}.json`;
                      a.click();
                      URL.revokeObjectURL(url);
                      // Persist a recent-attestation row so the operator
                      // can re-open what was downloaded without re-running
                      // the engine. Cap at 10; the audit chain is the
                      // permanent source of truth, this is just UX recall.
                      const rec: AttestationRecord = {
                        ts: Date.now(),
                        classification: cls,
                        recommended_marking: result.recommended_classification,
                        caveats: result.caveats_recommended,
                        input_hash: attest.input_hash,
                        chain_index: result.audit?.chain_index ?? null,
                        attestation: attest,
                      };
                      saveAttestation(rec);
                      setAttestations(loadAttestations());
                      pushToast({ tone: "ok", text: `Attestation downloaded · ${banner}` });
                    } finally {
                      setDownloading(false);
                    }
                  }}
                />
              </div>
            </div>

            {/* Tier-2 grounded explainer (Gemma) — opt-in, one call per
             * click. Renders the paragraph + the suggested redacted
             * phrasing the operator can copy back into the textarea. */}
            <section className="mb-4 rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
              <div className="flex flex-wrap items-center gap-3">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                  Tier-2 · Gemma 4 grounding
                </h4>
                {explain?.economics && (
                  <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
                    {explain.economics.tier} · ${explain.economics.cost_usd.toFixed(4)} ·{" "}
                    {Math.round(explain.economics.latency_ms)}ms
                    {explain.cached && (
                      <span className="ml-2 text-[var(--color-success)]">cached</span>
                    )}
                  </span>
                )}
                <Pressable
                  block={false}
                  disabled={explaining}
                  onClick={() => runExplain()}
                  className="ml-auto rounded-sm border border-[var(--color-primary)] bg-[color-mix(in_oklab,var(--color-primary)_12%,var(--color-surface))] px-3 py-1 font-mono text-xs uppercase tracking-widest text-[var(--color-text)] hover:bg-[color-mix(in_oklab,var(--color-primary)_24%,var(--color-surface))] disabled:opacity-50"
                >
                  {explaining ? "Calling Gemma…" : explain ? "Re-run with Gemma" : "Explain with Gemma"}
                </Pressable>
              </div>
              {explainError && (
                <div className="mt-2 text-xs text-[var(--color-danger)]">{explainError}</div>
              )}
              {!explain && !explainError && (
                <div className="mt-2 text-xs text-[var(--color-text-muted)]">
                  Tier-1 already classified this draft. Click to spend one Gemma call for a
                  paragraph-length grounded explanation + a suggested redacted phrasing.
                </div>
              )}
              {explain && (
                <div className="mt-3 space-y-3">
                  <div className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-sm leading-relaxed text-[var(--color-text)]">
                    {explain.explanation || "(no explanation returned)"}
                  </div>
                  {explain.suggested_redaction && (
                    <div>
                      <div className="mb-1 flex items-center gap-2">
                        <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
                          Suggested redacted phrasing
                        </span>
                        <Pressable
                          block={false}
                          onClick={() => {
                            if (textareaRef.current) {
                              textareaRef.current.value = explain.suggested_redaction;
                              latestTextRef.current = explain.suggested_redaction;
                              scheduleMark(true);
                              pushToast({
                                tone: "ok",
                                text: "Suggested phrasing applied — re-run mark to verify",
                              });
                            }
                          }}
                          className="rounded-sm border border-[var(--color-border)] px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-secondary)] hover:border-[var(--color-border-active)] hover:text-[var(--color-text)]"
                        >
                          ↩ Apply to draft
                        </Pressable>
                      </div>
                      <pre className="overflow-x-auto whitespace-pre-wrap rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-3 font-mono text-xs leading-relaxed text-[var(--color-text)]">
                        {explain.suggested_redaction}
                      </pre>
                    </div>
                  )}
                  <div className="text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
                    Engine: {explain.engine} · Capped at CUI per build policy.
                    {!explain.grounded_in_evidence && (
                      <span className="ml-2 text-[var(--color-warning)]">
                        ⚠ Grounding flag not set — review carefully.
                      </span>
                    )}
                  </div>
                </div>
              )}
            </section>

            <section className="mb-4">
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                Evidence ({result.evidence.length} rule match{result.evidence.length === 1 ? "" : "es"})
                {result.evidence.length > 0 && (
                  <span className="ml-2 font-normal normal-case tracking-wide text-[var(--color-text-muted)]">
                    — click any row to highlight it in the input
                  </span>
                )}
              </h4>
              {result.evidence.length === 0 && (
                <div className="text-xs text-[var(--color-text-muted)]">
                  No sensitive patterns detected. Consider open release pending reviewer confirmation.
                </div>
              )}
              <div className="flex flex-col gap-2">
                {result.evidence.map((e, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => {
                      // Click an evidence row → scroll the input textarea to
                      // the matched span and select it. Closes the loop
                      // between "engine flagged this" and "this is what it
                      // saw." If the substring isn't found (e.g. the input
                      // changed since the recommendation came back), fall
                      // back to focusing the textarea.
                      const ta = textareaRef.current;
                      if (!ta) return;
                      const text = ta.value;
                      const idx = text.indexOf(e.evidence);
                      ta.focus();
                      if (idx < 0) return;
                      ta.setSelectionRange(idx, idx + e.evidence.length);
                      // Approximate scroll-into-view: scrollTop proportional
                      // to the line containing the match.
                      const lineNum = text.slice(0, idx).split("\n").length;
                      const lineHeight = 22; // matches font-mono leading-relaxed
                      ta.scrollTop = Math.max(0, (lineNum - 3) * lineHeight);
                    }}
                    className="text-left rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-xs transition-colors hover:border-[var(--color-primary)] hover:bg-[color-mix(in_oklab,var(--color-primary)_8%,var(--color-surface))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
                    aria-label={`Highlight matched span "${e.evidence}" in input`}
                  >
                    <div className="flex items-baseline gap-2">
                      <span
                        className="rounded-sm px-1.5 py-0.5 text-xs font-mono uppercase"
                        style={{
                          background: "color-mix(in oklab, var(--color-warning-muted) 25%, var(--color-surface))",
                          color: "var(--color-warning)",
                        }}
                      >
                        {e.flag}
                      </span>
                      <span className="text-xs font-mono text-[var(--color-text-muted)]">rule: {e.rule}</span>
                      <span className="ml-auto text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
                        ↩ jump to span
                      </span>
                    </div>
                    <div className="mt-1 font-mono text-[var(--color-text)] break-words">
                      "{e.evidence}"
                    </div>
                  </button>
                ))}
              </div>
            </section>

            <section>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                Audit trail
              </h4>
              <div className="rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-sm text-[var(--color-text-secondary)]">
                <div>
                  Engine: {result.audit.engine}
                  {result.audit.engine_version && (
                    <span className="ml-1 text-[var(--color-text-muted)]">
                      ({result.audit.engine_version})
                    </span>
                  )}
                </div>
                <div title={result.audit.timestamp}>
                  Timestamp:{" "}
                  <span className="font-mono">
                    {/* Walkthrough audit: prior render dumped raw ISO
                     * ('2026-04-27T15:30:42Z') into the audit panel. Format
                     * as DD MMM YYYY · HHMMz so the line reads as audit
                     * prose; raw ISO stays available via the title attr. */}
                    {(() => {
                      const iso = result.audit.timestamp;
                      const d = new Date(iso);
                      if (Number.isNaN(d.getTime())) return iso;
                      const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
                      const z = (n: number) => String(n).padStart(2, "0");
                      return `${z(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} · ${z(d.getUTCHours())}${z(d.getUTCMinutes())}z`;
                    })()}
                  </span>
                </div>
                {/* Chain index returned by the backend audit table. Same
                 * row id an investigator pulls in the audit-log viewer —
                 * proves the marking actually wrote to the chain instead
                 * of just being claimed in the UI. */}
                {typeof result.audit.chain_index === "number" && (
                  <div>
                    Chain entry:{" "}
                    <span className="font-mono text-[var(--color-text)]">
                      #{result.audit.chain_index}
                    </span>
                    {result.audit.input_hash && (
                      <span
                        className="ml-2 font-mono text-xs text-[var(--color-text-muted)]"
                        title={`SHA-256 ${result.audit.input_hash}`}
                      >
                        sha256 {result.audit.input_hash.slice(0, 8)}…
                      </span>
                    )}
                  </div>
                )}
                {result.audit.actor_name && (
                  <div>
                    Actor:{" "}
                    <span className="text-[var(--color-text)]">
                      {result.audit.actor_name}
                    </span>
                    {result.audit.actor_role && (
                      <span className="ml-1 text-[var(--color-text-muted)]">
                        ({result.audit.actor_role})
                      </span>
                    )}
                  </div>
                )}
                <div className="mt-1 italic">
                  Marking written to the hash-chained audit trail per LICENSE §Security Architecture.
                </div>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

// Full-width DoDM-5200.01-style marking banner. Coloured left-border bar,
// hero-sized classification text, caveat string on a second line in mono.
function MarkingBanner({ result }: { result: MarkResult }) {
  const cls = result.recommended_classification;
  const color =
    cls === "SECRET" || cls === "TOP_SECRET"
      ? "var(--color-danger)"
      : cls === "CUI"
      ? "var(--color-warning)"
      : "var(--color-success)";
  return (
    <div
      className={clsx(
        "mb-4 overflow-hidden rounded-sm border-l-[6px]",
      )}
      style={{
        borderLeftColor: color,
        background: `color-mix(in oklab, ${color} 10%, var(--color-surface))`,
        borderTop: "1px solid color-mix(in oklab, " + color + " 30%, var(--color-border))",
        borderRight: "1px solid color-mix(in oklab, " + color + " 30%, var(--color-border))",
        borderBottom: "1px solid color-mix(in oklab, " + color + " 30%, var(--color-border))",
      }}
    >
      <div className="flex items-center justify-between px-4 py-3">
        <div>
          <div
            className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest"
          >
            Recommended Marking
          </div>
          <div
            className="mt-1 font-mono text-xl font-semibold uppercase tracking-wide"
            style={{ color, lineHeight: 1 }}
          >
            {cls.replace(/_/g, " ")}
            {result.caveats_recommended.length > 0 && (
              <span className="ml-2 text-xl text-[var(--color-text-secondary)]">
                // {result.caveats_recommended.join(" / ")}
              </span>
            )}
          </div>
        </div>
        <div
          className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest"
        >
          DoDM 5200.01
        </div>
      </div>
    </div>
  );
}

// Walkthrough #4 — release-authority validator banner.
function ReleaseCompatibilityBanner({
  compat,
}: {
  compat: NonNullable<MarkResult["release_compatibility"]>;
}) {
  const isBlock = compat.status === "block";
  const color = isBlock ? "var(--color-danger)" : "var(--color-warning)";
  const label = isBlock ? "Release Blocked" : "Release Warning";
  return (
    <div
      className="mb-4 rounded-sm border-l-[6px] p-3"
      style={{
        borderLeftColor: color,
        background: `color-mix(in oklab, ${color} 10%, var(--color-surface))`,
        borderTop: "1px solid color-mix(in oklab, " + color + " 30%, var(--color-border))",
        borderRight: "1px solid color-mix(in oklab, " + color + " 30%, var(--color-border))",
        borderBottom: "1px solid color-mix(in oklab, " + color + " 30%, var(--color-border))",
      }}
      role={isBlock ? "alert" : "status"}
    >
      <div
        className="font-mono text-xs font-semibold uppercase tracking-widest"
        style={{ color }}
      >
        {label}
      </div>
      <ul className="mt-1 space-y-0.5 text-sm text-[var(--color-text)]">
        {compat.issues.map((issue, i) => (
          <li key={i} className="leading-snug">{issue}</li>
        ))}
      </ul>
    </div>
  );
}

// Walkthrough #5 / Task-61 — Distribution Statement + REL TO caveat side-by-side.
// Both fields are now driven by the backend engine so the Distribution letter
// (A-F) actually changes across the three sample chips per DoDI 5230.24.
function DistributionAuthorityPanel({
  result,
  release,
}: {
  result: MarkResult;
  release: Auth;
}) {
  const dist = result.distribution_statement;
  const distLabel = dist?.label ?? "Distribution —";
  const distNote =
    dist?.description ?? "Controls who can access (U.S. Government, contractors, etc.).";
  const relTo = result.rel_to_caveat ?? REL_TO_FALLBACK[release] ?? "";
  return (
    <div className="mb-4 rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div
        className="mb-2 font-mono text-xs font-semibold uppercase tracking-widest text-[var(--color-text-muted)]"
      >
        Release Posture · DoDI 5230.24
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="font-mono text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
            Distribution Statement
          </div>
          <div className="mt-0.5 font-mono text-sm font-semibold text-[var(--color-text)]">
            {distLabel}
          </div>
          <div className="mt-1 text-xs text-[var(--color-text-secondary)]">
            {distNote}
          </div>
        </div>
        <div>
          <div className="font-mono text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
            REL TO Caveat
          </div>
          <div className="mt-0.5 font-mono text-sm font-semibold text-[var(--color-text)]">
            {relTo || "(no foreign release)"}
          </div>
          <div className="mt-1 text-xs text-[var(--color-text-secondary)]">
            Controls which foreign nationals may receive.
          </div>
        </div>
      </div>
    </div>
  );
}

async function sha256(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Lightweight CSV parser tuned for the Mark-bulk shape. We accept
// either {text}-column CSVs or single-column files; quote-balancing
// is handled but we don't try to be a full RFC-4180 parser. The
// server caps at 500 rows, so the FE doesn't need to scale.
function parseCsvForBulk(raw: string): Array<{ id: string; text: string }> {
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const splitRow = (line: string): string[] => {
    const cells: string[] = [];
    let current = "";
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuote) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            current += '"';
            i++;
          } else {
            inQuote = false;
          }
        } else {
          current += ch;
        }
      } else if (ch === '"') {
        inQuote = true;
      } else if (ch === ",") {
        cells.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    cells.push(current);
    return cells;
  };
  const header = splitRow(lines[0]).map((c) => c.trim().toLowerCase());
  let textIdx = header.indexOf("text");
  if (textIdx === -1) textIdx = header.indexOf("remark");
  if (textIdx === -1) textIdx = header.indexOf("draft");
  let idIdx = header.indexOf("id");
  if (idIdx === -1) idIdx = header.indexOf("sr_number");
  // If no recognised header, treat every line (including the first)
  // as a text-only row.
  let rows: Array<{ id: string; text: string }>;
  if (textIdx === -1) {
    rows = lines.map((l, i) => ({ id: `row-${i + 1}`, text: l.trim() }));
  } else {
    rows = lines.slice(1).map((line, i) => {
      const cells = splitRow(line);
      const idCell = idIdx >= 0 ? (cells[idIdx] ?? "").trim() : "";
      const textCell = (cells[textIdx] ?? "").trim();
      return { id: idCell || `row-${i + 1}`, text: textCell };
    });
  }
  return rows.filter((r) => r.text.length > 0).slice(0, 500);
}

function BulkMarkDropzone({
  onFile,
  loading,
  error,
  rows,
  counts,
  sourceName,
  onClear,
  onPickRow,
}: {
  onFile: (file: File) => void;
  loading: boolean;
  error: string | null;
  rows: SentryBulkMarkRow[] | null;
  counts: { needs_review: number; auto_clear: number; UNCLASSIFIED?: number; CUI?: number } | null;
  sourceName: string | null;
  onClear: () => void;
  onPickRow: (row: SentryBulkMarkRow) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  return (
    <div className="mt-4 rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs uppercase tracking-widest text-[var(--color-text-muted)]">
          Bulk Mark · CSV
        </span>
        <span className="text-[10px] text-[var(--color-text-muted)]">
          drop a `.csv` with a `text`/`remark`/`draft` column · ≤500 rows · Tier-1 only
        </span>
        {rows && (
          <Pressable
            block={false}
            onClick={onClear}
            className="ml-auto rounded-sm border border-[var(--color-border)] px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-secondary)] hover:border-[var(--color-border-active)] hover:text-[var(--color-text)]"
          >
            Clear
          </Pressable>
        )}
      </div>
      {!rows && (
        <div
          className={clsx(
            "mt-2 rounded-sm border-2 border-dashed p-3 text-center font-mono text-xs uppercase tracking-widest transition-colors",
            isDragging
              ? "border-[var(--color-primary)] bg-[color-mix(in_oklab,var(--color-primary)_8%,var(--color-surface))] text-[var(--color-text)]"
              : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-border-active)]",
          )}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setIsDragging(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setIsDragging(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setIsDragging(false);
            const file = e.dataTransfer.files?.[0];
            if (file) onFile(file);
          }}
        >
          {loading ? (
            <span>Classifying rows…</span>
          ) : (
            <>
              <div>Drop CSV here</div>
              <div className="mt-1 normal-case tracking-wide text-[10px] text-[var(--color-text-muted)]">
                or{" "}
                <button
                  type="button"
                  className="underline underline-offset-2 hover:text-[var(--color-text)]"
                  onClick={() => inputRef.current?.click()}
                >
                  pick a file
                </button>
              </div>
              <input
                ref={inputRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) onFile(file);
                  e.currentTarget.value = "";
                }}
              />
            </>
          )}
        </div>
      )}
      {error && (
        <div className="mt-2 text-xs text-[var(--color-danger)]">{error}</div>
      )}
      {rows && counts && (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap items-center gap-3 font-mono text-xs">
            <span className="text-[var(--color-text-muted)]">{sourceName ?? "(uploaded)"}</span>
            <span className="text-[var(--color-text)]">
              {rows.length} rows · {counts.needs_review} need review · {counts.auto_clear} auto-clear
            </span>
            <span className="text-[var(--color-text-muted)]">
              {Object.entries(counts)
                .filter(([k]) => k === "UNCLASSIFIED" || k === "CUI")
                .map(([k, v]) => `${k}: ${v}`)
                .join(" · ")}
            </span>
          </div>
          <div className="max-h-48 overflow-y-auto rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)]">
            {rows.slice(0, 60).map((r, i) => (
              <button
                type="button"
                key={r.id ?? i}
                onClick={() => onPickRow(r)}
                className="flex w-full items-baseline gap-2 border-b border-[var(--color-border)] px-2 py-1 text-left font-mono text-xs hover:bg-[color-mix(in_oklab,var(--color-primary)_8%,var(--color-surface))]"
              >
                <span
                  className={clsx(
                    "shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] uppercase tracking-widest",
                    r.classification === "CUI"
                      ? "bg-[color-mix(in_oklab,var(--color-warning)_25%,var(--color-surface))] text-[var(--color-warning)]"
                      : "bg-[color-mix(in_oklab,var(--color-success)_15%,var(--color-surface))] text-[var(--color-success)]",
                  )}
                >
                  {r.classification ?? "—"}
                </span>
                <span className="shrink-0 text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
                  {r.needs_review ? "review" : "clear"}
                </span>
                <span className="shrink-0 tabular-nums text-[var(--color-text-muted)]">
                  {((r.confidence ?? 0) * 100).toFixed(0)}%
                </span>
                <span className="truncate text-[var(--color-text)]">{r.preview ?? r.id}</span>
              </button>
            ))}
            {rows.length > 60 && (
              <div className="px-2 py-1 text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
                … {rows.length - 60} more rows; refine your CSV or drill in via Review Queue
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function AttestationViewerModal({
  rec,
  onClose,
  onCopy,
}: {
  rec: AttestationRecord;
  onClose: () => void;
  onCopy: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="relative max-h-[80vh] w-full max-w-3xl overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
          <span className="font-mono text-xs uppercase tracking-widest text-[var(--color-text-muted)]">
            Attestation · {new Date(rec.ts).toLocaleString()}
          </span>
          <span className="rounded-sm bg-[color-mix(in_oklab,var(--color-warning)_25%,var(--color-surface))] px-2 py-0.5 font-mono text-[10px] uppercase text-[var(--color-warning)]">
            {rec.classification.replace("_", " ")}
          </span>
          <Pressable
            block={false}
            onClick={onCopy}
            className="ml-auto rounded-sm border border-[var(--color-border)] px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-secondary)] hover:border-[var(--color-border-active)] hover:text-[var(--color-text)]"
          >
            Copy JSON
          </Pressable>
          <Pressable
            block={false}
            onClick={onClose}
            className="rounded-sm border border-[var(--color-border)] px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-secondary)] hover:border-[var(--color-border-active)] hover:text-[var(--color-text)]"
          >
            Close ✕
          </Pressable>
        </div>
        <pre className="max-h-[68vh] overflow-auto p-3 font-mono text-xs leading-relaxed text-[var(--color-text)]">
{JSON.stringify(rec.attestation, null, 2)}
        </pre>
      </div>
    </div>
  );
}

function RecentAttestationsPanel({
  items,
  onView,
  onClear,
}: {
  items: AttestationRecord[];
  onView: (rec: AttestationRecord) => void;
  onClear: () => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mt-4 rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs uppercase tracking-widest text-[var(--color-text-muted)]">
          Recent attestations · {items.length}
        </span>
        <span className="text-[10px] text-[var(--color-text-muted)]">
          stored locally · audit chain is the permanent record
        </span>
        <Pressable
          block={false}
          onClick={onClear}
          className="ml-auto rounded-sm border border-[var(--color-border)] px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-secondary)] hover:border-[var(--color-border-active)] hover:text-[var(--color-text)]"
        >
          Clear local
        </Pressable>
      </div>
      <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto">
        {items.map((rec, i) => (
          <li key={`${rec.input_hash}-${rec.ts}-${i}`}>
            <button
              type="button"
              onClick={() => onView(rec)}
              className="flex w-full items-baseline gap-2 rounded-sm border border-transparent px-2 py-1 text-left font-mono text-xs hover:border-[var(--color-border)]"
            >
              <span className="tabular-nums text-[var(--color-text-muted)]">
                {new Date(rec.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
              <span className="rounded-sm bg-[color-mix(in_oklab,var(--color-warning)_20%,var(--color-surface))] px-1.5 py-0.5 text-[10px] uppercase text-[var(--color-warning)]">
                {rec.classification.replace("_", " ")}
              </span>
              {rec.caveats.length > 0 && (
                <span className="text-[var(--color-text-secondary)]">// {rec.caveats.join(" / ")}</span>
              )}
              <span className="ml-auto text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
                #{rec.chain_index ?? "—"} · {rec.input_hash.slice(0, 8)}…
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
