import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { api, type MarkResult } from "../../api";
import { formatApiError } from "../../api-retry";
import { SegmentedControl } from "../../components/SegmentedControl";
import { useSpireStore } from "../../state/store";
import { InsufficientPrivilege } from "../../components/InsufficientPrivilege";
import { Pressable } from "../../components/ui";
import { ClassifiedExport } from "../../components/classification";

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
