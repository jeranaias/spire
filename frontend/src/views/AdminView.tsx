/**
 * AdminView — GC-6 Training Data Flywheel surface.
 *
 * Restricted to security_manager. Three panels:
 *  - Engine performance: per-scoring-engine accuracy (rule_based vs j2 vs
 *    regex vs llm_gate), rolling-window trend, retrain-needed flag.
 *  - Decision outcomes: per-decision-kind accuracy + recent outcome log
 *    with the contributing notes for each incorrect call.
 *  - Pilot feedback: in-app issues filed via the FeedbackDrawer with
 *    GitHub-issue link if created.
 *
 * The flywheel claim is real: every approve/reject/feedback action lands
 * in the audit chain AND updates this view in near-real-time. As the
 * cohort uses the app, the trend drifts visibly. When accuracy drops
 * below 80% across 20+ outcomes, the panel shows "retraining recommended."
 */
import { useEffect, useState } from "react";
import {
  api,
  type AdminTelemetry,
  type DecisionOutcome,
  type FeedbackRecord,
} from "../api";
import { withRetry, formatApiError } from "../api-retry";
import { useSpireStore } from "../state/store";
import { InsufficientPrivilege } from "../components/InsufficientPrivilege";
import { ErrorState, LoadingState } from "../components/ui";
import { Link } from "react-router-dom";

export function AdminView() {
  const role = useSpireStore((s) => s.role);

  if (role !== "security_manager" && role !== "mef_commander") {
    return (
      <InsufficientPrivilege
        feature="Admin · Training Flywheel"
        requiredRoles={["security_manager", "mef_commander"]}
        description="Model telemetry and decision-outcome history are restricted to Security Manager and MEF Commander review per the audit posture."
      />
    );
  }

  return <TrainingFlywheelTab />;
}

function TrainingFlywheelTab() {
  const [tel, setTel] = useState<AdminTelemetry | null>(null);
  const [outcomes, setOutcomes] = useState<DecisionOutcome[]>([]);
  const [feedback, setFeedback] = useState<FeedbackRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [waking, setWaking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fetchAll = async (firstLoad: boolean) => {
      try {
        // Cold-start retry only on first load — the 8s poll afterwards is
        // single-shot so we don't tie up the queue waiting on a flapping
        // backend.
        const fetcher = firstLoad
          ? () =>
              withRetry(
                () =>
                  Promise.all([
                    api.system.adminTelemetry(),
                    api.system.adminOutcomes(60),
                    api.system.adminFeedback(),
                  ]),
                {
                  onAttempt: (attempt) => {
                    if (!cancelled) setWaking(attempt > 1);
                  },
                },
              )
          : () =>
              Promise.all([
                api.system.adminTelemetry(),
                api.system.adminOutcomes(60),
                api.system.adminFeedback(),
              ]);
        const [t, o, f] = await fetcher();
        if (cancelled) return;
        setTel(t);
        setOutcomes(o.outcomes);
        setFeedback(f.feedback);
        setError(null);
        setWaking(false);
      } catch (e) {
        if (cancelled) return;
        // First-load failure is loud; poll-failure is silent (the existing
        // data stays on screen).
        if (firstLoad) {
          setError(formatApiError(e));
          setWaking(false);
        } else {
          console.warn("Admin telemetry poll failed:", e);
        }
      }
    };
    fetchAll(true);
    const id = setInterval(() => fetchAll(false), 8000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (error && !tel) {
    return (
      <ErrorState
        title="Admin Telemetry Offline"
        description="Training-flywheel telemetry endpoint did not respond after 4 attempts. Backend may be cycling."
        detail={error}
        onRetry={() => {
          setError(null);
          setWaking(true);
          // Force a refetch by toggling waking; the existing effect re-runs
          // on dependency change. Simplest path here is to remount — the
          // role useEffect handles the actual fetch on first mount.
          window.location.reload();
        }}
      />
    );
  }
  if (!tel) {
    return <LoadingState size="page" label="Loading admin telemetry …" waking={waking} />;
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-6">
      {/* AdminTabs (W1 #29 audit view) provides formal sub-nav across
       * all /admin/* surfaces; the in-header "Model supply chain →"
       * link below is a redundant CTA in the heading row, kept after
       * the rebase so the Flywheel page still cross-links to the model
       * registry without forcing the operator into the tab strip. */}
      <AdminTabs active="flywheel" />
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <div>
          {/* Promoted from h2 to h1 — this view is the document, not a
           * subsection. Single h1 per view anchors the screen-reader
           * outline. */}
          <h1
            className="font-mono text-base font-semibold uppercase text-[var(--color-text)] tracking-widest"
          >
            Admin · Training Flywheel
          </h1>
          <div className="mt-1 spire-body-muted">
            Every operator decision feeds the model improvement cycle. Outcomes scored against ground truth populate
            the rolling accuracy trend; below 80% accuracy across ≥ 20 outcomes triggers a retraining recommendation.
          </div>
        </div>
        {/* W1 #30 — admin-side link to the canonical model supply-chain
         * page. Lives next to the flywheel so a security manager can pivot
         * from "are we still calibrated" to "what models are we running"
         * in one click. */}
        <a
          href="#/admin/models"
          className="shrink-0 rounded-sm border border-[var(--color-border-active)] bg-[var(--color-surface)] px-3 py-1.5 font-mono text-xs uppercase tracking-widest text-[var(--color-primary)] hover:bg-[var(--color-bg)]"
          title="Per-model provenance, hosting target, FedRAMP, vendor jurisdiction"
        >
          Model supply chain →
        </a>
      </div>

      {/* Hero stats row */}
      <div className="mb-4 grid grid-cols-4 gap-3">
        <Stat label="Total outcomes" value={tel.total_outcomes.toLocaleString("en-US")} />
        <Stat
          label="Overall accuracy"
          value={tel.overall_accuracy != null ? `${(tel.overall_accuracy * 100).toFixed(1)}%` : "—"}
          tone={tel.overall_accuracy != null && tel.overall_accuracy >= 0.85 ? "ok" : tel.overall_accuracy && tel.overall_accuracy >= 0.75 ? "warn" : "danger"}
        />
        <Stat label="Pilot feedback (filed)" value={feedback.length.toLocaleString("en-US")} />
        <div
          className="rounded-md border p-4"
          style={{
            borderColor: tel.retraining_recommended ? "var(--color-warning)" : "var(--color-border)",
            background: tel.retraining_recommended
              ? "color-mix(in oklab, var(--color-warning-muted) 18%, var(--color-surface))"
              : "var(--color-surface)",
          }}
        >
          <div className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
            Retraining
          </div>
          <div
            className="mt-1 font-mono text-lg font-semibold tabular-nums tracking-wide"
            style={{
              color: tel.retraining_recommended ? "var(--color-warning)" : "var(--color-success)",
            }}
          >
            {tel.retraining_recommended ? "Recommended" : "Not yet"}
          </div>
        </div>
      </div>

      {/* Engine performance */}
      <div className="mb-4 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div
          className="mb-3 font-mono text-xs uppercase text-[var(--color-primary)] tracking-widest"
        >
          Engine Performance · per scoring engine
        </div>
        <div className="flex flex-col gap-2">
          {Object.entries(tel.by_engine).map(([engine, b]) => (
            <EngineRow key={engine} engine={engine} stat={b} />
          ))}
        </div>
      </div>

      {/* Rolling accuracy + decision-kind */}
      <div className="mb-4 grid grid-cols-2 gap-3">
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <div
            className="mb-3 font-mono text-xs uppercase text-[var(--color-primary)] tracking-widest"
          >
            Rolling Accuracy · 5-record buckets
          </div>
          <RollingChart points={tel.rolling_accuracy} />
        </div>
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <div
            className="mb-3 font-mono text-xs uppercase text-[var(--color-primary)] tracking-widest"
          >
            By Decision Kind
          </div>
          <div className="flex flex-col gap-1.5">
            {Object.entries(tel.by_decision_kind).map(([k, b]) => (
              <div key={k} className="flex items-center justify-between font-mono text-sm tracking-wide">
                <span className="text-[var(--color-text)]">{k.replace(/_/g, " ")}</span>
                <div className="flex items-center gap-2 tabular-nums">
                  <span style={{ color: accColor(b.accuracy) }}>{(b.accuracy * 100).toFixed(0)}%</span>
                  <span className="text-[var(--color-text-muted)]">({b.total})</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Recent outcomes */}
      <div className="mb-4 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div
          className="mb-3 font-mono text-xs uppercase text-[var(--color-primary)] tracking-widest"
        >
          Recent Decision Outcomes ({outcomes.length})
        </div>
        <div className="max-h-72 overflow-y-auto">
          <table className="w-full font-mono text-xs">
            <thead>
              <tr className="text-[var(--color-text-muted)] tracking-wider">
                <th className="px-1 py-1 text-left uppercase">When</th>
                <th className="px-1 py-1 text-left uppercase">Kind</th>
                <th className="px-1 py-1 text-left uppercase">Engine</th>
                <th className="px-1 py-1 text-left uppercase">Actor</th>
                <th className="px-1 py-1 text-center uppercase">Result</th>
                <th className="px-1 py-1 text-left uppercase">Notes</th>
              </tr>
            </thead>
            <tbody>
              {outcomes.slice(-30).reverse().map((o) => (
                <tr key={o.id} className="border-t border-[var(--color-border)]">
                  <td className="px-1 py-1 tabular-nums text-[var(--color-text-secondary)]">
                    {/* Walkthrough audit: prior slice(5, 16) stripped the
                     * year ('2026-04-27T15:30' → '04-27 15:30'). Show
                     * 'DD MMM HHMMz' so the row's date is parseable
                     * without context, and the full year remains
                     * recoverable via the row's title attribute. */}
                    <span title={o.observed_at}>
                      {(() => {
                        const d = new Date(o.observed_at);
                        if (Number.isNaN(d.getTime())) return o.observed_at;
                        const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
                        const z = (n: number) => String(n).padStart(2, "0");
                        return `${z(d.getUTCDate())} ${months[d.getUTCMonth()]} ${z(d.getUTCHours())}${z(d.getUTCMinutes())}z`;
                      })()}
                    </span>
                  </td>
                  <td className="px-1 py-1 text-[var(--color-text)]">{o.decision_kind.replace(/_/g, " ")}</td>
                  <td className="px-1 py-1 text-[var(--color-text-secondary)]">{o.scoring_engine}</td>
                  <td className="px-1 py-1 text-[var(--color-text-muted)] tracking-wide">
                    {o.decided_by}
                  </td>
                  <td className="px-1 py-1 text-center">
                    <span
                      className="rounded-sm border px-1 py-[1px] tracking-wider"
                      style={{
                        color: o.was_correct ? "var(--color-success)" : "var(--color-danger)",
                        borderColor: o.was_correct ? "var(--color-success-muted)" : "var(--color-danger-muted)",
                        background: o.was_correct ? "color-mix(in oklab, var(--color-success-muted) 25%, transparent)" : "color-mix(in oklab, var(--color-danger-muted) 25%, transparent)",
                      }}
                    >
                      {o.was_correct ? "OK" : "✗"}
                    </span>
                  </td>
                  <td className="px-1 py-1 text-[var(--color-text-muted)] italic">
                    {o.notes || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pilot feedback */}
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div
          className="mb-3 font-mono text-xs uppercase text-[var(--color-primary)] tracking-widest"
        >
          Pilot Feedback ({feedback.length})
        </div>
        <div className="max-h-60 overflow-y-auto flex flex-col gap-2">
          {feedback.length === 0 && (
            <div className="rounded-sm border border-dashed border-[var(--color-border)] p-4 text-center font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
              NO FEEDBACK YET — first issue filed via the in-app drawer will land here
            </div>
          )}
          {feedback.slice().reverse().map((f) => (
            <div key={f.id} className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono">
              <div className="flex items-center gap-2 text-xs tracking-wide">
                <span className="text-[var(--color-text-muted)]">{f.id}</span>
                <span className="rounded-sm border border-[var(--color-border-active)] px-1 text-xs uppercase text-[var(--color-text-secondary)] tracking-wider">
                  {f.severity}
                </span>
                <span className="text-[var(--color-text-muted)]">{f.role}</span>
                <span className="text-[var(--color-text-muted)]">· {f.view}</span>
                {f.github_issue_url && (
                  <a
                    href={f.github_issue_url}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-auto text-[var(--color-primary)] hover:underline"
                  >
                    GH #{f.github_issue_number}
                  </a>
                )}
              </div>
              <div className="mt-1 text-sm font-semibold text-[var(--color-text)] tracking-wide">
                {f.title}
              </div>
              <div className="mt-0.5 text-xs text-[var(--color-text-secondary)] tracking-wide">
                {f.body.slice(0, 200)}{f.body.length > 200 ? "…" : ""}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" | "danger" }) {
  const color =
    tone === "ok" ? "var(--color-success)" :
    tone === "warn" ? "var(--color-warning)" :
    tone === "danger" ? "var(--color-danger)" :
    "var(--color-text)";
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
        {label}
      </div>
      <div className="mt-1 font-mono text-xl font-semibold tabular-nums" style={{ color }}>
        {value}
      </div>
    </div>
  );
}

function EngineRow({ engine, stat }: { engine: string; stat: { accuracy: number; correct: number; incorrect: number; total: number } }) {
  return (
    <div className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-2">
      <div className="flex items-baseline justify-between font-mono">
        <span className="text-base font-semibold text-[var(--color-text)] tracking-wide">
          {engine}
        </span>
        <span className="text-xs text-[var(--color-text-muted)] tracking-wider">
          {stat.total} outcomes · {stat.correct} correct · {stat.incorrect} incorrect
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <div className="relative h-[5px] flex-1 overflow-hidden rounded-[1px] border border-[var(--color-border)]">
          <div
            className="absolute inset-y-0 left-0"
            style={{ width: `${stat.accuracy * 100}%`, background: accColor(stat.accuracy) }}
          />
        </div>
        <span className="font-mono text-sm tabular-nums" style={{ color: accColor(stat.accuracy) }}>
          {(stat.accuracy * 100).toFixed(1)}%
        </span>
      </div>
    </div>
  );
}

function RollingChart({ points }: { points: { bucket_end: string; accuracy: number; n: number }[] }) {
  if (points.length === 0) {
    return (
      <div className="rounded-sm border border-dashed border-[var(--color-border)] p-6 text-center font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
        NO ROLLING DATA YET
      </div>
    );
  }
  const w = 360;
  const h = 80;
  const xs = points.map((_, i) => (i / (Math.max(1, points.length - 1))) * w);
  const ys = points.map((p) => h - p.accuracy * h);
  const path = xs.map((x, i) => `${i === 0 ? "M" : "L"} ${x} ${ys[i]}`).join(" ");
  return (
    <svg width="100%" height={h + 20} viewBox={`0 0 ${w} ${h + 20}`}>
      <line x1="0" y1={h * 0.2} x2={w} y2={h * 0.2} stroke="var(--color-success)" strokeWidth="0.5" strokeDasharray="3 3" opacity="0.4" />
      <line x1="0" y1={h * 0.5} x2={w} y2={h * 0.5} stroke="var(--color-warning)" strokeWidth="0.5" strokeDasharray="3 3" opacity="0.4" />
      <path d={path} fill="none" stroke="var(--color-primary)" strokeWidth="2" strokeLinejoin="round" />
      {xs.map((x, i) => (
        <circle key={i} cx={x} cy={ys[i]} r="2.5" fill="var(--color-primary)" />
      ))}
      {/* Walkthrough audit: prior axis labels were 'MM-DD' only.
       * For a multi-week chart that crossed a year boundary the labels
       * read identically. Render 'DD MMM' so a January→December run
       * stays disambiguated. */}
      <text x="0" y={h + 15} fill="var(--color-text-muted)" fontSize="8" fontFamily="JetBrains Mono, monospace">
        {fmtAxis(points[0]?.bucket_end)}
      </text>
      <text x={w} y={h + 15} fill="var(--color-text-muted)" fontSize="8" textAnchor="end" fontFamily="JetBrains Mono, monospace">
        {fmtAxis(points[points.length - 1]?.bucket_end)} · accuracy
      </text>
    </svg>
  );
}

function accColor(a: number): string {
  if (a >= 0.9) return "var(--color-success)";
  if (a >= 0.8) return "var(--color-warning)";
  return "var(--color-danger)";
}

function fmtAxis(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${day} ${months[d.getUTCMonth()]}`;
}


/**
 * AdminTabs — shared sub-nav for the /admin/* surfaces. Walkthrough audit:
 * the audit-log view added in W1 was reachable only by typing the URL or
 * via TopBar deep-link; an inline tab strip on every /admin page makes
 * the SOC view discoverable from Flywheel and vice versa.
 */
export type AdminTabKey = "flywheel" | "audit" | "economics" | "ingest" | "mapper" | "channels";

export function AdminTabs({ active }: { active: AdminTabKey }) {
  const tab = (to: string, key: AdminTabKey, label: string, hint: string) => (
    <Link
      to={to}
      aria-current={active === key ? "page" : undefined}
      className="rounded-sm border px-3 py-1.5 font-mono text-xs uppercase tracking-wider transition-colors"
      style={{
        background: active === key
          ? "color-mix(in oklab, var(--color-primary) 22%, var(--color-surface))"
          : "var(--color-surface)",
        borderColor: active === key ? "var(--color-primary)" : "var(--color-border)",
        color: active === key ? "var(--color-text)" : "var(--color-text-secondary)",
        textDecoration: "none",
      }}
      title={hint}
    >
      {label}
    </Link>
  );
  return (
    <nav className="mb-3 flex items-center gap-2" aria-label="Admin sub-navigation">
      {tab("/admin",           "flywheel",  "Training Flywheel",   "Per-engine accuracy + decision outcomes")}
      {tab("/admin/audit",     "audit",     "Audit · SOC View",    "Hash-chained audit log with filters + export")}
      {tab("/admin/economics", "economics", "Inference Economics", "Per-call LLM cost telemetry + 180k-Marine extrapolation")}
      {tab("/admin/ingest",    "ingest",    "Real-Data Ingest",    "Drop a GCSS-MC export to dry-run + apply")}
      {tab("/admin/ingest/mapper", "mapper",  "Mapping Editor",      "Auto + LLM-assisted column-mapping editor; save profiles per unit/source")}
      {tab("/admin/channels",  "channels",  "Ingest Channels",     "Pull-mode SFTP / IMAP / HTTP / DB / Kafka sources, health, DLQ, circuit reset")}
    </nav>
  );
}
