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
import { useSpireStore } from "../state/store";
import { InsufficientPrivilege } from "../components/InsufficientPrivilege";

export function AdminView() {
  const role = useSpireStore((s) => s.role);
  if (role !== "security_manager") {
    return (
      <InsufficientPrivilege
        feature="Admin · Training Flywheel"
        requiredRoles={["security_manager"]}
        description="Model telemetry and decision-outcome history are restricted to Security Manager review per the audit posture."
      />
    );
  }

  const [tel, setTel] = useState<AdminTelemetry | null>(null);
  const [outcomes, setOutcomes] = useState<DecisionOutcome[]>([]);
  const [feedback, setFeedback] = useState<FeedbackRecord[]>([]);

  useEffect(() => {
    const fetchAll = async () => {
      try {
        const [t, o, f] = await Promise.all([
          api.system.adminTelemetry(),
          api.system.adminOutcomes(60),
          api.system.adminFeedback(),
        ]);
        setTel(t);
        setOutcomes(o.outcomes);
        setFeedback(f.feedback);
      } catch {
        /* tolerate */
      }
    };
    fetchAll();
    const id = setInterval(fetchAll, 8000);
    return () => clearInterval(id);
  }, []);

  if (!tel) {
    return (
      <div className="flex h-full items-center justify-center font-mono text-[11px] text-[var(--color-text-secondary)]" style={{ letterSpacing: "0.1em" }}>
        Loading admin telemetry …
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-6">
      <div className="mb-4">
        <h2
          className="font-mono text-[12px] font-semibold uppercase text-[var(--color-text)]"
          style={{ letterSpacing: "0.2em" }}
        >
          Admin · Training Flywheel · GC-6
        </h2>
        <div className="mt-1 spire-body-muted">
          Every operator decision feeds the model improvement cycle. Outcomes scored against ground truth populate
          the rolling accuracy trend; below 80% accuracy across ≥ 20 outcomes triggers a retraining recommendation.
        </div>
      </div>

      {/* Hero stats row */}
      <div className="mb-4 grid grid-cols-4 gap-3">
        <Stat label="Total outcomes" value={tel.total_outcomes.toLocaleString()} />
        <Stat
          label="Overall accuracy"
          value={tel.overall_accuracy != null ? `${(tel.overall_accuracy * 100).toFixed(1)}%` : "—"}
          tone={tel.overall_accuracy != null && tel.overall_accuracy >= 0.85 ? "ok" : tel.overall_accuracy && tel.overall_accuracy >= 0.75 ? "warn" : "danger"}
        />
        <Stat label="Pilot feedback (filed)" value={feedback.length.toLocaleString()} />
        <div
          className="rounded-md border p-4"
          style={{
            borderColor: tel.retraining_recommended ? "var(--color-warning)" : "var(--color-border)",
            background: tel.retraining_recommended
              ? "color-mix(in oklab, var(--color-warning-muted) 18%, var(--color-surface))"
              : "var(--color-surface)",
          }}
        >
          <div className="font-mono text-[9px] uppercase text-[var(--color-text-muted)]" style={{ letterSpacing: "0.22em" }}>
            Retraining
          </div>
          <div
            className="mt-1 font-mono text-[14px] font-semibold tabular-nums"
            style={{
              color: tel.retraining_recommended ? "var(--color-warning)" : "var(--color-success)",
              letterSpacing: "0.04em",
            }}
          >
            {tel.retraining_recommended ? "Recommended" : "Not yet"}
          </div>
        </div>
      </div>

      {/* Engine performance */}
      <div className="mb-4 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div
          className="mb-3 font-mono text-[10px] uppercase text-[var(--color-primary)]"
          style={{ letterSpacing: "0.22em" }}
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
            className="mb-3 font-mono text-[10px] uppercase text-[var(--color-primary)]"
            style={{ letterSpacing: "0.22em" }}
          >
            Rolling Accuracy · 5-record buckets
          </div>
          <RollingChart points={tel.rolling_accuracy} />
        </div>
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <div
            className="mb-3 font-mono text-[10px] uppercase text-[var(--color-primary)]"
            style={{ letterSpacing: "0.22em" }}
          >
            By Decision Kind
          </div>
          <div className="flex flex-col gap-1.5">
            {Object.entries(tel.by_decision_kind).map(([k, b]) => (
              <div key={k} className="flex items-center justify-between font-mono text-[11px]" style={{ letterSpacing: "0.04em" }}>
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
          className="mb-3 font-mono text-[10px] uppercase text-[var(--color-primary)]"
          style={{ letterSpacing: "0.22em" }}
        >
          Recent Decision Outcomes ({outcomes.length})
        </div>
        <div className="max-h-72 overflow-y-auto">
          <table className="w-full font-mono text-[10px]">
            <thead>
              <tr className="text-[var(--color-text-muted)]" style={{ letterSpacing: "0.16em" }}>
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
                    {o.observed_at.slice(5, 16).replace("T", " ")}
                  </td>
                  <td className="px-1 py-1 text-[var(--color-text)]">{o.decision_kind.replace(/_/g, " ")}</td>
                  <td className="px-1 py-1 text-[var(--color-text-secondary)]">{o.scoring_engine}</td>
                  <td className="px-1 py-1 text-[var(--color-text-muted)]" style={{ letterSpacing: "0.06em" }}>
                    {o.decided_by}
                  </td>
                  <td className="px-1 py-1 text-center">
                    <span
                      className="rounded-sm border px-1 py-[1px]"
                      style={{
                        color: o.was_correct ? "var(--color-success)" : "var(--color-danger)",
                        borderColor: o.was_correct ? "var(--color-success-muted)" : "var(--color-danger-muted)",
                        background: o.was_correct ? "color-mix(in oklab, var(--color-success-muted) 25%, transparent)" : "color-mix(in oklab, var(--color-danger-muted) 25%, transparent)",
                        letterSpacing: "0.16em",
                      }}
                    >
                      {o.was_correct ? "OK" : "✗"}
                    </span>
                  </td>
                  <td className="px-1 py-1 text-[var(--color-text-muted)] italic" style={{ letterSpacing: "0.02em" }}>
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
          className="mb-3 font-mono text-[10px] uppercase text-[var(--color-primary)]"
          style={{ letterSpacing: "0.22em" }}
        >
          Pilot Feedback ({feedback.length})
        </div>
        <div className="max-h-60 overflow-y-auto flex flex-col gap-2">
          {feedback.length === 0 && (
            <div className="rounded-sm border border-dashed border-[var(--color-border)] p-4 text-center font-mono text-[10px] text-[var(--color-text-muted)]" style={{ letterSpacing: "0.14em" }}>
              NO FEEDBACK YET — first issue filed via the in-app drawer will land here
            </div>
          )}
          {feedback.slice().reverse().map((f) => (
            <div key={f.id} className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono">
              <div className="flex items-center gap-2 text-[10px]" style={{ letterSpacing: "0.08em" }}>
                <span className="text-[var(--color-text-muted)]">{f.id}</span>
                <span className="rounded-sm border border-[var(--color-border-active)] px-1 text-[9px] uppercase text-[var(--color-text-secondary)]" style={{ letterSpacing: "0.16em" }}>
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
              <div className="mt-1 text-[11px] font-semibold text-[var(--color-text)]" style={{ letterSpacing: "0.04em" }}>
                {f.title}
              </div>
              <div className="mt-0.5 text-[10px] text-[var(--color-text-secondary)]" style={{ letterSpacing: "0.04em" }}>
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
      <div className="font-mono text-[9px] uppercase text-[var(--color-text-muted)]" style={{ letterSpacing: "0.22em" }}>
        {label}
      </div>
      <div className="mt-1 font-mono text-[18px] font-semibold tabular-nums" style={{ color, letterSpacing: "-0.01em" }}>
        {value}
      </div>
    </div>
  );
}

function EngineRow({ engine, stat }: { engine: string; stat: { accuracy: number; correct: number; incorrect: number; total: number } }) {
  return (
    <div className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-2">
      <div className="flex items-baseline justify-between font-mono">
        <span className="text-[12px] font-semibold text-[var(--color-text)]" style={{ letterSpacing: "0.04em" }}>
          {engine}
        </span>
        <span className="text-[10px] text-[var(--color-text-muted)]" style={{ letterSpacing: "0.14em" }}>
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
        <span className="font-mono text-[11px] tabular-nums" style={{ color: accColor(stat.accuracy), letterSpacing: "-0.01em" }}>
          {(stat.accuracy * 100).toFixed(1)}%
        </span>
      </div>
    </div>
  );
}

function RollingChart({ points }: { points: { bucket_end: string; accuracy: number; n: number }[] }) {
  if (points.length === 0) {
    return (
      <div className="rounded-sm border border-dashed border-[var(--color-border)] p-6 text-center font-mono text-[10px] text-[var(--color-text-muted)]" style={{ letterSpacing: "0.14em" }}>
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
      <text x="0" y={h + 15} fill="var(--color-text-muted)" fontSize="8" fontFamily="JetBrains Mono, monospace">
        {points[0]?.bucket_end?.slice(5, 10)}
      </text>
      <text x={w} y={h + 15} fill="var(--color-text-muted)" fontSize="8" textAnchor="end" fontFamily="JetBrains Mono, monospace">
        {points[points.length - 1]?.bucket_end?.slice(5, 10)} · accuracy
      </text>
    </svg>
  );
}

function accColor(a: number): string {
  if (a >= 0.9) return "var(--color-success)";
  if (a >= 0.8) return "var(--color-warning)";
  return "var(--color-danger)";
}
