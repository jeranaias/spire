import { useState } from "react";
import clsx from "clsx";
import { api, type MarkResult } from "../../api";

const RELEASE_AUTHS = [
  { id: "US_ONLY", label: "U.S. Only" },
  { id: "FVEY",    label: "FVEY" },
  { id: "NATO",    label: "NATO" },
];

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
  const [text, setText] = useState("");
  const [release, setRelease] = useState("US_ONLY");
  const [result, setResult] = useState<MarkResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function mark() {
    if (!text.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const r = await api.sentry.mark(text, release);
      setResult(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex h-full overflow-hidden">
      <div className="flex w-1/2 flex-col overflow-y-auto border-r border-[var(--color-border)] p-4">
        <h2 className="mb-1 text-sm font-semibold">Upstream marking — recommend before release</h2>
        <div className="mb-4 text-xs text-[var(--color-text-muted)]">
          Paste a paragraph, remark, or draft section. SENTRY Tier-1 runs the same regex ensemble as the batch
          processor and returns a classification + caveat recommendation per DoDM 5200.01. No LLM required.
        </div>

        <div className="mb-2 flex flex-wrap gap-2">
          {SAMPLES.map((s) => (
            <button
              key={s.label}
              onClick={() => setText(s.text)}
              className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1 text-[11px] text-[var(--color-text-secondary)] hover:border-[var(--color-border-active)] hover:text-[var(--color-text)]"
            >
              {s.label}
            </button>
          ))}
        </div>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste a draft paragraph, SR remark, or operational text..."
          className="min-h-[240px] flex-1 resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 font-mono text-sm leading-relaxed text-[var(--color-text)] focus:border-[var(--color-primary)] focus:outline-none"
        />

        <div className="mt-3 flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
            Release authority
            <select
              value={release}
              onChange={(e) => setRelease(e.target.value)}
              className="appearance-none rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[var(--color-text)] hover:border-[var(--color-border-active)] focus:border-[var(--color-primary)] focus:outline-none"
            >
              {RELEASE_AUTHS.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={mark}
            disabled={loading || !text.trim()}
            className="rounded border border-[var(--color-primary)] bg-[var(--color-primary)] px-5 py-1.5 text-xs font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
          >
            {loading ? "Marking ..." : "Recommend marking"}
          </button>
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
            <div
              className={clsx(
                "mb-3 rounded-md border p-4",
                result.recommended_classification === "SECRET" && "border-[var(--color-danger-muted)] bg-[color-mix(in_oklab,var(--color-danger-muted)_20%,var(--color-surface))]",
                result.recommended_classification === "CUI" && "border-[var(--color-warning-muted)] bg-[color-mix(in_oklab,var(--color-warning-muted)_20%,var(--color-surface))]",
                result.recommended_classification === "UNCLASSIFIED" && "border-[var(--color-success-muted)] bg-[color-mix(in_oklab,var(--color-success-muted)_15%,var(--color-surface))]",
              )}
            >
              <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">Recommended marking</div>
              <div className="mt-1 font-mono text-xl font-semibold tracking-wide"
                style={{
                  color:
                    result.recommended_classification === "SECRET"
                      ? "var(--color-danger)"
                      : result.recommended_classification === "CUI"
                        ? "var(--color-warning)"
                        : "var(--color-success)",
                }}
              >
                {result.recommended_classification}
                {result.caveats_recommended.length > 0 && (
                  <span className="ml-2 text-base text-[var(--color-text-secondary)]">
                    // {result.caveats_recommended.join(" / ")}
                  </span>
                )}
              </div>
              <div className="mt-1 text-xs text-[var(--color-text-muted)]">
                Confidence: {(result.confidence * 100).toFixed(0)}% · Release authority requested:{" "}
                {result.release_authority_requested}
              </div>
            </div>

            <section className="mb-4">
              <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                Evidence ({result.evidence.length} rule match{result.evidence.length === 1 ? "" : "es"})
              </h4>
              {result.evidence.length === 0 && (
                <div className="text-xs text-[var(--color-text-muted)]">
                  No sensitive patterns detected. Consider open release pending reviewer confirmation.
                </div>
              )}
              <div className="flex flex-col gap-2">
                {result.evidence.map((e, i) => (
                  <div key={i} className="rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-xs">
                    <div className="flex items-baseline gap-2">
                      <span
                        className="rounded-sm px-1.5 py-0.5 text-[10px] font-mono uppercase"
                        style={{
                          background: "color-mix(in oklab, var(--color-warning-muted) 25%, var(--color-surface))",
                          color: "var(--color-warning)",
                        }}
                      >
                        {e.flag}
                      </span>
                      <span className="text-[10px] font-mono text-[var(--color-text-muted)]">rule: {e.rule}</span>
                    </div>
                    <div className="mt-1 font-mono text-[var(--color-text)]">"{e.evidence}"</div>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                Audit trail
              </h4>
              <div className="rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-[11px] text-[var(--color-text-secondary)]">
                <div>Engine: {result.audit.engine}</div>
                <div>Timestamp: <span className="font-mono">{result.audit.timestamp}</span></div>
                <div className="mt-1 italic">
                  Every marking is logged to the hash-chained audit trail per LICENSE §Security Architecture.
                </div>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
