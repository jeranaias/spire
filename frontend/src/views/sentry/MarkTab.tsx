import { useState } from "react";
import clsx from "clsx";
import { api, type MarkResult } from "../../api";
import { SegmentedControl } from "../../components/SegmentedControl";
import { useSpireStore } from "../../state/store";
import { InsufficientPrivilege } from "../../components/InsufficientPrivilege";

const RELEASE_AUTHS = [
  { value: "US_ONLY", label: "U.S." },
  { value: "FVEY",    label: "FVEY" },
  { value: "NATO",    label: "NATO" },
] as const;

type Auth = typeof RELEASE_AUTHS[number]["value"];

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
  const [text, setText] = useState("");
  const [release, setRelease] = useState<Auth>("US_ONLY");
  const [result, setResult] = useState<MarkResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const pushToast = useSpireStore((s) => s.pushToast);

  if (role !== "data_custodian" && role !== "security_manager") {
    return (
      <InsufficientPrivilege
        feature="Mark Draft"
        requiredRoles={["data_custodian", "security_manager"]}
        description="Classification-marking recommendations alter records' authoritative marking and require Data Custodian or Security Manager privileges per DoDM 5200.01."
      />
    );
  }

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
          Paste a paragraph, remark, or draft section. The Tier-1 pattern engine returns a recommended
          classification and caveat set per DoDM 5200.01. Runs entirely local; no language model required.
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

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <span
            className="font-mono text-[10px] uppercase text-[var(--color-text-muted)]"
            style={{ letterSpacing: "0.18em" }}
          >
            Release Authority
          </span>
          <SegmentedControl
            value={release}
            options={RELEASE_AUTHS.map((r) => ({ value: r.value, label: r.label }))}
            onChange={setRelease}
          />
          <button
            onClick={mark}
            disabled={loading || !text.trim()}
            className="ml-auto rounded-sm border border-[var(--color-primary)] bg-[var(--color-primary)] px-5 py-1.5 font-mono text-[11px] font-semibold uppercase text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
            style={{ letterSpacing: "0.18em" }}
          >
            {loading ? "Marking …" : "Recommend Marking"}
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
            <MarkingBanner result={result} />
            <div className="mb-4 flex items-center gap-3">
              <div className="font-mono text-[11px] text-[var(--color-text-secondary)]" style={{ letterSpacing: "0.04em" }}>
                Confidence <span className="tabular-nums text-[var(--color-text)]">{(result.confidence * 100).toFixed(0)}%</span>
                <span className="mx-2 text-[var(--color-border-active)]">│</span>
                Release: <span className="text-[var(--color-text)]">{result.release_authority_requested}</span>
              </div>
              <button
                onClick={async () => {
                  setDownloading(true);
                  try {
                    const attest = {
                      input_hash: await sha256(text),
                      recommended_marking: result.recommended_classification,
                      caveats: result.caveats_recommended,
                      confidence: result.confidence,
                      evidence: result.evidence,
                      engine: result.audit.engine,
                      timestamp: result.audit.timestamp,
                      release_authority: release,
                    };
                    const blob = new Blob([JSON.stringify(attest, null, 2)], { type: "application/json" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `spire_mark_attestation_${Date.now()}.json`;
                    a.click();
                    URL.revokeObjectURL(url);
                    pushToast({ tone: "ok", text: "Attestation downloaded" });
                  } finally {
                    setDownloading(false);
                  }
                }}
                className="ml-auto rounded-sm border border-[var(--color-border)] px-3 py-1 font-mono text-[10px] font-semibold uppercase text-[var(--color-text-secondary)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]"
                style={{ letterSpacing: "0.18em" }}
              >
                {downloading ? "…" : "↓ Attestation"}
              </button>
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
            className="font-mono text-[10px] uppercase text-[var(--color-text-muted)]"
            style={{ letterSpacing: "0.22em" }}
          >
            Recommended Marking
          </div>
          <div
            className="mt-1 font-mono text-[22px] font-semibold uppercase"
            style={{ color, letterSpacing: "0.08em", lineHeight: 1 }}
          >
            {cls.replace("_", " ")}
            {result.caveats_recommended.length > 0 && (
              <span className="ml-2 text-[18px] text-[var(--color-text-secondary)]">
                // {result.caveats_recommended.join(" / ")}
              </span>
            )}
          </div>
        </div>
        <div
          className="font-mono text-[10px] uppercase text-[var(--color-text-muted)]"
          style={{ letterSpacing: "0.22em" }}
        >
          DoDM 5200.01
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
