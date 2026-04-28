import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import clsx from "clsx";
import { api, type MarkResult } from "../../api";
import { formatApiError } from "../../api-retry";
import { SegmentedControl } from "../../components/SegmentedControl";
import { useSpireStore } from "../../state/store";
import { InsufficientPrivilege } from "../../components/InsufficientPrivilege";
import { Pressable } from "../../components/ui";
import {
  ClassifiedExport,
  MaskedSpan,
  RedactionToggle,
  usePiiRedaction,
  type PiiRedactionController,
} from "../../components/classification";

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

// Task-92 — client-side mirror of the server's MARK_TEXT_MAX_BYTES. The
// backend is authoritative (a curl from a privileged session must still
// 413 over the cap), but we surface the limit on the textarea and gate
// scheduleMark so operators don't watch the engine spin on a paste they'll
// only get rejected for. UTF-8 byte length matches what the server
// measures, so multi-byte glyphs eat their own weight here too.
const MARK_TEXT_MAX_BYTES = 16 * 1024;

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
  const navigate = useNavigate();
  // Walkthrough #3 — uncontrolled textarea so fast typing doesn't drop
  // characters through React's controlled-input round-trip. Sample/sanitize
  // updates remount the textarea by bumping `textVersion` so React applies
  // the new `defaultValue` (Task-171: this used to be a hardcoded "" and the
  // textarea visually emptied after a sample load, even though the API
  // call captured the preset; now we seed it from `textareaSeed` so the
  // visible value matches what the engine ran on, and a subsequent
  // release-authority click re-fires correctly).
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [textVersion, setTextVersion] = useState(0);
  const [textareaSeed, setTextareaSeed] = useState("");
  const [release, setRelease] = useState<Auth>("US_ONLY");
  const [result, setResult] = useState<MarkResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  // Task-92 — counter for the byte-cap chip beside Release Authority. We
  // recompute on every keystroke (uncontrolled textarea) and use it to
  // both render the usage and short-circuit scheduleMark when the operator
  // pastes something past the cap, so the engine isn't spammed and the
  // audit chain doesn't get a 413 round-trip per keystroke.
  const [textBytes, setTextBytes] = useState(0);
  const pushToast = useSpireStore((s) => s.pushToast);
  const debounceRef = useRef<number | null>(null);
  const latestTextRef = useRef<string>("");
  const overCap = textBytes > MARK_TEXT_MAX_BYTES;

  if (role !== "data_custodian" && role !== "security_manager") {
    return (
      <InsufficientPrivilege
        feature="Mark Draft"
        requiredRoles={["data_custodian", "security_manager"]}
        description="Classification-marking recommendations alter records' authoritative marking and require Data Custodian or Security Manager privileges per DoDM 5200.01."
      />
    );
  }

  function scheduleMark(immediate = false, overrideText?: string) {
    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    // Task-171 — `overrideText` lets sample/sanitize callers pass the new
    // text directly, because React hasn't yet remounted the textarea (the
    // ref still points at the previous DOM node with the prior value) at
    // the moment we want to fire the engine. Without this override, the
    // engine would run on stale DOM contents.
    const text = (overrideText ?? textareaRef.current?.value ?? "").trim();
    latestTextRef.current = text;
    // Task-92 — keep the byte counter in sync on every keystroke so the
    // chip and over-cap gating reflect what the operator just typed/pasted,
    // not the previous render's value.
    const bytes = new TextEncoder().encode(text).length;
    setTextBytes(bytes);
    if (!text) {
      setResult(null);
      setError(null);
      return;
    }
    if (bytes > MARK_TEXT_MAX_BYTES) {
      // Task-92 — short-circuit before the network: we already know the
      // server will 413, so don't spam the audit chain with rejected
      // requests on every keystroke past the cap. Mirror the server-side
      // detail so the operator sees the same numbers either way.
      setLoading(false);
      setResult(null);
      setError(
        `Input is ${bytes.toLocaleString()} bytes — over the ${MARK_TEXT_MAX_BYTES.toLocaleString()}-byte cap. ` +
          "Trim the draft or split into multiple submissions.",
      );
      return;
    }
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

  // Walkthrough #3 — release-authority change re-fires the engine.
  useEffect(() => {
    if ((textareaRef.current?.value ?? "").trim()) {
      scheduleMark(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [release]);

  function loadSample(preset: string) {
    setTextareaSeed(preset);
    setTextVersion((v) => v + 1);
    // Pass the preset directly: the textarea won't remount with the new
    // defaultValue until React commits, so reading textareaRef here would
    // return the prior (or empty) value.
    scheduleMark(true, preset);
  }

  // Task-171 — "Use sanitized excerpt" loads the engine's redacted form
  // back into the textarea and re-fires /mark so the operator sees the
  // unblocked recommendation without typing. Same remount + override
  // pattern as loadSample.
  function useSanitizedExcerpt(sanitized: string) {
    setTextareaSeed(sanitized);
    setTextVersion((v) => v + 1);
    scheduleMark(true, sanitized);
  }

  return (
    <div className="flex h-full overflow-hidden">
      <div className="flex w-1/2 flex-col overflow-y-auto border-r border-[var(--color-border)] p-4">
        <h2 className="mb-1 text-sm font-semibold">Upstream marking — recommend before release</h2>
        <div className="mb-4 text-xs text-[var(--color-text-muted)]">
          {/* Walkthrough #32 — operator-readable copy, no engine jargon. */}
          Paste a paragraph, remark, or draft section. The pattern engine returns a recommended
          classification and caveat set per DoDM 5200.01. Recommendations refresh automatically
          as you type or change release authority.
        </div>

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

        <textarea
          ref={textareaRef}
          // Walkthrough #3 — uncontrolled. defaultValue avoids the batched-
          // render path that was dropping fast-typed characters.
          // Task-171 — defaultValue is now seeded by `textareaSeed`, so a
          // sample chip / "Use sanitized excerpt" click that bumps
          // `textVersion` (key) actually shows the new text in the textarea
          // instead of leaving it blank while only the API call carried the
          // value forward.
          defaultValue={textareaSeed}
          key={textVersion}
          onChange={() => scheduleMark(false)}
          placeholder="Paste a draft paragraph, SR remark, or operational text..."
          // Task-92 — also caps the typed/pasted size at 2x cap so the
          // browser refuses to paste in 1 MB of junk; the byte-counter
          // chip and server 413 still authoritatively gate over the cap.
          maxLength={MARK_TEXT_MAX_BYTES * 2}
          className={clsx(
            "min-h-[240px] flex-1 resize-y rounded-md border bg-[var(--color-surface)] p-3 font-mono text-sm leading-relaxed text-[var(--color-text)] focus:outline-none",
            overCap
              ? "border-[var(--color-danger)] focus:border-[var(--color-danger)]"
              : "border-[var(--color-border)] focus:border-[var(--color-primary)]",
          )}
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
          {/* Task-92 — byte counter mirrors the server's MARK_TEXT_MAX_BYTES.
              Renders muted under the cap, danger over the cap, so an
              operator pasting in too much text sees the limit before
              the engine refuses to run. */}
          <span
            className={clsx(
              "font-mono text-xs tabular-nums tracking-wider",
              overCap
                ? "text-[var(--color-danger)]"
                : "text-[var(--color-text-muted)]",
            )}
            data-testid="mark-byte-counter"
            title="Max input the SENTRY pattern engine will accept per request"
          >
            {textBytes.toLocaleString()} / {MARK_TEXT_MAX_BYTES.toLocaleString()} B
          </span>
          <span className="ml-auto font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
            {loading ? "Marking …" : overCap ? "Over cap · won't submit" : "Live · auto-refreshes"}
          </span>
          {error && <span className="text-xs text-[var(--color-danger)]">{error}</span>}
        </div>
      </div>

      <div className="flex w-1/2 flex-col overflow-y-auto p-4">
        {!result && (
          <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-muted)]">
            Submit text to see the marking recommendation.
          </div>
        )}
        {result && (
          <MarkResultPanel
            result={result}
            release={release}
            downloading={downloading}
            setDownloading={setDownloading}
            pushToast={pushToast}
            textareaRef={textareaRef}
            onUseSanitized={useSanitizedExcerpt}
          />
        )}
      </div>
    </div>
  );
}

// Task #169 — Mark result pane is split out so it owns the shared
// `usePiiRedaction` controller. Evidence strings (EDIPI, POC, MGRS, …)
// surfaced from the pattern engine carry the same PII the Review Queue
// inspector masks; without this gate a presenter clicking "Radar fault
// (classified TM)" sample would project an EDIPI on the projector
// unprompted.
function MarkResultPanel({
  result,
  release,
  downloading,
  setDownloading,
  pushToast,
  textareaRef,
  onUseSanitized,
}: {
  result: MarkResult;
  release: Auth;
  downloading: boolean;
  setDownloading: (v: boolean) => void;
  pushToast: ReturnType<typeof useSpireStore.getState>["pushToast"];
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onUseSanitized?: (sanitized: string) => void;
}) {
  const navigate = useNavigate();
  const piiRedaction = usePiiRedaction(result.recommended_classification);
  // Reset reveals when a fresh marking lands so revealed evidence from a
  // prior input doesn't bleed onto the next sample. Projection mode is
  // preserved on purpose — same demo posture as the Review Queue.
  useEffect(() => {
    piiRedaction.resetRevealed();
  }, [result.audit?.timestamp, result.recommended_classification, piiRedaction.resetRevealed]);
  return (
    <>
      <MarkingBanner result={result} />

      {/* Walkthrough #4 — release-authority validator banner.
          Task-171 — when the engine self-introduced a blocking caveat from
          a redactable span, the banner offers a one-click "Use sanitized
          excerpt" that loads the engine's redacted form back into the
          textarea and re-runs /mark. */}
      {result.release_compatibility && result.release_compatibility.status !== "ok" && (
        <ReleaseCompatibilityBanner
          compat={result.release_compatibility}
          sanitizedText={result.sanitized_text ?? null}
          onUseSanitized={onUseSanitized}
        />
      )}

      {/* Walkthrough #5 / Task-61 — Distribution Statement + REL TO
          caveat side-by-side, both selected by the engine from
          content + release authority. */}
      <DistributionAuthorityPanel result={result} release={release} />

      {/* Task #169 — projection/redaction toggle for the spillage tab.
          Mirrors the chip on the Review Queue inspector so a presenter
          flipping into Mark/spillage doesn't leak the matched evidence
          (EDIPI / POC / MGRS) onto the projector. */}
      <RedactionToggle controller={piiRedaction} className="mb-4" />

      <div className="mb-4 flex items-center gap-3">
        <div className="font-mono text-sm text-[var(--color-text-secondary)] tracking-wide">
          Confidence <span className="tabular-nums text-[var(--color-text)]">{(result.confidence * 100).toFixed(0)}%</span>
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
                pushToast({ tone: "ok", text: `Attestation downloaded · ${banner}` });
              } finally {
                setDownloading(false);
              }
            }}
          />
        </div>
      </div>

      <section className="mb-4">
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
          Evidence ({result.evidence.length} rule match{result.evidence.length === 1 ? "" : "es"})
        </h4>
        {result.evidence.length === 0 && (
          <div className="text-xs text-[var(--color-text-muted)]">
            No sensitive patterns detected. Consider open release pending reviewer confirmation.
          </div>
        )}
        <div className="flex flex-col gap-2">
          {result.evidence.map((e, i) => (
            <EvidenceRow
              key={i}
              flag={e.flag}
              rule={e.rule}
              evidence={e.evidence}
              spanKey={`mark:evidence:${i}`}
              controller={piiRedaction}
            />
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
           * of just being claimed in the UI.
           *
           * Task #91 — render as a button that deep-links to the SOC
           * audit viewer pre-filtered to this exact subject_id
           * (`mark_<input_hash[:12]>`, returned as `chain_subject` by
           * the Mark endpoint). Closes the loop a judge or
           * investigator used to walk by hand: no more leaving the
           * page to copy/paste a subject id into the audit viewer's
           * free-text search. The destination route's role gate
           * admits both data_custodian (subject-scoped narrow bypass)
           * and security_manager — see the `subjectScopedDataCustodian`
           * branch in AuditView.tsx. */}
          {typeof result.audit.chain_index === "number" && (
            <div>
              Chain entry:{" "}
              {result.audit.chain_subject ? (
                <Pressable
                  block={false}
                  onClick={() => {
                    const sid = result.audit.chain_subject!;
                    navigate(`/admin/audit?subject_id=${encodeURIComponent(sid)}`);
                  }}
                  className="rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-[1px] font-mono text-sm font-semibold text-[var(--color-primary)] underline-offset-2 hover:border-[var(--color-primary)] hover:underline focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--color-primary)]"
                  title={`Open the audit-log viewer pre-filtered to subject ${result.audit.chain_subject}`}
                  aria-label={`Open chain entry ${result.audit.chain_index} in the audit-log viewer`}
                >
                  #{result.audit.chain_index} ↗
                </Pressable>
              ) : (
                <span className="font-mono text-[var(--color-text)]">
                  #{result.audit.chain_index}
                </span>
              )}
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
  );
}

// Task #169 — single evidence row. Wraps the engine-matched substring
// (which is the literal PII the pattern engine fired on — EDIPI, POC,
// MGRS, classified TM ref) with the shared `MaskedSpan` so it renders
// as a black ██ block by default and clicks-to-reveal on the same
// clearance gate as the Review Queue inspector.
function EvidenceRow({
  flag,
  rule,
  evidence,
  spanKey,
  controller,
}: {
  flag: string;
  rule: string;
  evidence: string;
  spanKey: string;
  controller: PiiRedactionController;
}) {
  return (
    <div className="rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-xs">
      <div className="flex items-baseline gap-2">
        <span
          className="rounded-sm px-1.5 py-0.5 text-xs font-mono uppercase"
          style={{
            background: "color-mix(in oklab, var(--color-warning-muted) 25%, var(--color-surface))",
            color: "var(--color-warning)",
          }}
        >
          {flag}
        </span>
        <span className="text-xs font-mono text-[var(--color-text-muted)]">rule: {rule}</span>
      </div>
      <div className="mt-1 font-mono text-[var(--color-text)]">
        {"\""}
        <MaskedSpan
          controller={controller}
          spanKey={spanKey}
          text={evidence}
          category={mapFlagToMaskCategory(flag)}
          alwaysMask
        />
        {"\""}
      </div>
    </div>
  );
}

// Map the engine's flag strings (EDIPI, POC_PHONE, MGRS, CLASSIFIED_TM,
// SERIAL, etc.) onto the inspector's category palette so the accent
// stripe under each ██ block matches the Review Queue.
function mapFlagToMaskCategory(flag: string): string {
  const f = flag.toUpperCase();
  if (f.includes("MGRS") || f.includes("GEO") || f.includes("GRID") || f.includes("COORD")) return "geo";
  if (f.includes("CLASS") || f.includes("SECRET")) return "classified";
  if (f.includes("SERIAL") || f.includes("CONTROLLED") || f.includes("TM")) return "controlled";
  if (f.includes("FREQ") || f.includes("COMM") || f.includes("CALL")) return "comms";
  return "pii";
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
// Task-171 — when the engine self-introduces a blocking caveat from a
// redactable span, the backend now ships a `sanitized_text` alongside the
// block message. We render a "Use sanitized excerpt" button next to the
// issue list so the operator can one-click load the rewritten paragraph
// back into the textarea instead of manually retyping it.
function ReleaseCompatibilityBanner({
  compat,
  sanitizedText,
  onUseSanitized,
}: {
  compat: NonNullable<MarkResult["release_compatibility"]>;
  sanitizedText?: string | null;
  onUseSanitized?: (sanitized: string) => void;
}) {
  const isBlock = compat.status === "block";
  const color = isBlock ? "var(--color-danger)" : "var(--color-warning)";
  const label = isBlock ? "Release Blocked" : "Release Warning";
  const canSanitize = isBlock && !!sanitizedText && !!onUseSanitized;
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
      {canSanitize && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Pressable
            onClick={() => onUseSanitized!(sanitizedText!)}
            block={false}
            className="rounded border px-3 py-1 font-mono text-xs font-semibold uppercase tracking-wider"
            style={{
              borderColor: color,
              color,
              background: `color-mix(in oklab, ${color} 8%, var(--color-surface))`,
            }}
            title="Replace the textarea with the engine's redacted form and re-run"
          >
            Use sanitized excerpt
          </Pressable>
          <span className="text-xs text-[var(--color-text-muted)]">
            Replaces the offending span with{" "}
            <span className="font-mono">[REDACTED:…]</span> and re-runs the engine.
          </span>
        </div>
      )}
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
