/**
 * PULSE Model tab — model card + baselines.
 *
 * Honest answer to J3 DELTA's "what is your loss function and what are
 * you NOT optimizing?" question. Pulled from `/pulse/model-card` which
 * computes everything deterministically against the synthetic dataset.
 *
 * The canonical detail page lives under /admin/models/pulse-risk-scorer (lane
 * C3); this surface is the in-PULSE summary so an operator never has
 * to leave the workflow to inspect model behavior.
 */
import { useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api, isEmptyEnvelope, type ModelCard, type ModelCardBaseline } from "../../api";
import { formatApiError } from "../../api-retry";
import { AwaitingIngestEmpty } from "../../components/AwaitingIngestEmpty";
import { ErrorState, LoadingState } from "../../components/ui";

export function ModelTab() {
  const [card, setCard] = useState<ModelCard | null>(null);
  const [empty, setEmpty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.pulse
      .modelCard()
      .then((res) => {
        // Task #183 — backend may return {empty:true} when the dataset
        // singleton is empty (stage live-ingest mode pre-hydration).
        // Defend the typed state against the envelope so we never
        // dereference card.loss_function on a null card.
        if (isEmptyEnvelope(res)) {
          setEmpty(true);
        } else {
          setCard(res as ModelCard);
        }
      })
      .catch((e) => setError(formatApiError(e)));
  }, []);

  if (empty) {
    return (
      <AwaitingIngestEmpty
        surface="PULSE"
        description="The PULSE model card hydrates from the live GCSS-MC export. Drop the three sanitized CSVs into DECISION BRIDGE to populate this surface."
      />
    );
  }

  if (error && !card) {
    return (
      <div className="flex h-full items-center justify-center p-12">
        <ErrorState
          variant="panel"
          title="Failed to load model card"
          description="The PULSE model-card endpoint did not respond."
          detail={error}
          onRetry={() => window.location.reload()}
          retryLabel="Reload"
        />
      </div>
    );
  }
  if (!card) return <LoadingState size="page" label="Computing baselines …" />;

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex flex-col gap-4 p-4">
        <Header card={card} />
        <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(20rem, 100%), 1fr))" }}>
          <Panel title="What we optimize · loss function">
            <div className="font-mono text-sm leading-relaxed text-[var(--color-text)]">
              {card.loss_function.headline}
            </div>
            <div className="mt-2 spire-body-muted">
              {card.loss_function.details}
            </div>
            <div className="mt-3 flex items-center gap-3 font-mono text-xs uppercase tracking-wider">
              <Pill
                label="Horizon"
                value={`${card.loss_function.horizon_days} days`}
              />
              <Pill
                label="FN penalty"
                value={`${card.loss_function.weights.false_negative}×`}
                tone="danger"
              />
              <Pill
                label="FP penalty"
                value={`${card.loss_function.weights.false_positive}×`}
              />
            </div>
          </Panel>

          <Panel title="What we are NOT optimizing">
            <ul className="m-0 list-none p-0">
              {card.tradeoffs.map((t) => (
                <li
                  key={t}
                  className="mb-2 flex gap-2 font-mono text-sm leading-relaxed text-[var(--color-text-secondary)]"
                >
                  <span className="text-[var(--color-warning)]">·</span>
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          </Panel>
        </div>

        <Panel title="Baselines · model vs alternatives (test holdout)">
          <BaselinesTable baselines={card.baselines} />
          <div className="mt-3">
            <BaselinesChart baselines={card.baselines} />
          </div>
        </Panel>

        <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(20rem, 100%), 1fr))" }}>
          <Panel title="Train / val / test split">
            <SplitTable card={card} />
            <div className="mt-3 spire-body-muted">
              <span className="font-mono text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
                Method ·{" "}
              </span>
              {card.split.split_method}
            </div>
            <div className="mt-2 spire-body-muted">
              <span className="font-mono text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
                Holdout integrity ·{" "}
              </span>
              {card.split.holdout_integrity}
            </div>
          </Panel>

          <Panel title="Confusion matrix · current model on holdout">
            <ConfusionMatrix card={card} />
          </Panel>
        </div>

        <Panel title="Data drift · input distribution per month">
          <DriftChart card={card} />
          <div className="mt-3 spire-body-muted">{card.drift.method}</div>
          {card.drift.alerts.length > 0 ? (
            <div className="mt-3 flex flex-col gap-1.5">
              {card.drift.alerts.map((a) => (
                <div
                  key={a.feature + a.last_period}
                  className="rounded-sm border px-2 py-1.5 font-mono text-xs tracking-wide"
                  style={{
                    borderColor: "var(--color-warning-muted)",
                    background:
                      "color-mix(in oklab, var(--color-warning-muted) 18%, transparent)",
                    color: "var(--color-warning)",
                  }}
                >
                  DRIFT · {a.feature_label} at {a.last_period} · z={a.z_score.toFixed(2)}
                  {a.delta_pct != null ? ` · ${a.delta_pct > 0 ? "+" : ""}${a.delta_pct}% vs prior window` : ""}
                </div>
              ))}
            </div>
          ) : (
            <div
              className="mt-3 rounded-sm border border-dashed border-[var(--color-border)] p-2 font-mono text-xs uppercase tracking-wider text-[var(--color-text-muted)]"
            >
              NO DRIFT FLAGS · all monitored features within ±2σ of prior window
            </div>
          )}
        </Panel>

        <Panel title="Last validation">
          <LastValidation card={card} />
        </Panel>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header — engine label + canonical-card cross-link
// ---------------------------------------------------------------------------

function Header({ card }: { card: ModelCard }) {
  const engine = card.engine.public_label;
  const tone =
    engine === "torch production"
      ? "ok"
      : engine === "torch placeholder"
      ? "warn"
      : "muted";
  const toneColor =
    tone === "ok"
      ? "var(--color-success)"
      : tone === "warn"
      ? "var(--color-warning)"
      : "var(--color-text-muted)";
  const toneBg =
    tone === "ok"
      ? "color-mix(in oklab, var(--color-success-muted) 22%, transparent)"
      : tone === "warn"
      ? "color-mix(in oklab, var(--color-warning-muted) 22%, transparent)"
      : "var(--color-bg)";
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div>
        <h2 className="font-mono text-base font-semibold uppercase tracking-widest text-[var(--color-text)]">
          PULSE Risk Scorer · Model Card
        </h2>
        <div className="mt-1 spire-body-muted">
          In-PULSE summary of the model behind the Risk Board, Predicted Failure panel, and Forecast spaghetti.
          Canonical detail lives at{" "}
          <a
            href={card.canonical_model_card_url}
            className="text-[var(--color-primary)] hover:underline"
          >
            /admin/models/pulse-risk-scorer
          </a>
          .
        </div>
      </div>
      <div className="flex flex-col items-end gap-1.5">
        <span
          className="rounded-sm border px-2 py-1 font-mono text-xs uppercase tracking-widest"
          style={{
            color: toneColor,
            borderColor: toneColor,
            background: toneBg,
          }}
        >
          Engine · {engine}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
          internal id · {card.engine.internal_id}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
          as of · {card.as_of}
        </span>
      </div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="mb-3 font-mono text-xs uppercase tracking-widest text-[var(--color-primary)]">
        {title}
      </div>
      {children}
    </div>
  );
}

function Pill({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn" | "danger";
}) {
  const color =
    tone === "ok"
      ? "var(--color-success)"
      : tone === "warn"
      ? "var(--color-warning)"
      : tone === "danger"
      ? "var(--color-danger)"
      : "var(--color-text)";
  return (
    <span
      className="rounded-sm border px-2 py-0.5"
      style={{
        color,
        borderColor:
          tone === "ok"
            ? "var(--color-success-muted)"
            : tone === "warn"
            ? "var(--color-warning-muted)"
            : tone === "danger"
            ? "var(--color-danger-muted)"
            : "var(--color-border)",
      }}
    >
      <span className="text-[var(--color-text-muted)]">{label} · </span>
      <span className="tabular-nums">{value}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Baselines
// ---------------------------------------------------------------------------

function BaselinesTable({ baselines }: { baselines: ModelCardBaseline[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full font-mono text-sm">
        <thead>
          <tr className="text-left font-mono text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
            <th className="px-2 py-1">Predictor</th>
            <th className="px-2 py-1">Source</th>
            <th className="px-2 py-1 text-right">Accuracy</th>
            <th className="px-2 py-1 text-right">Precision</th>
            <th className="px-2 py-1 text-right">Recall</th>
            <th className="px-2 py-1 text-right">F1</th>
            <th
              className="px-2 py-1 text-right"
              title="Mission-weighted score: 1 - (FP + 5·FN) / N. Higher is better. The actual loss function PULSE optimizes against."
            >
              Mission ▼
            </th>
          </tr>
        </thead>
        <tbody>
          {baselines.map((b) => (
            <tr
              key={b.key}
              className={`border-t border-[var(--color-border)] ${
                b.is_model
                  ? "bg-[color-mix(in_oklab,var(--color-primary)_8%,transparent)]"
                  : ""
              }`}
            >
              <td className="px-2 py-1.5 text-[var(--color-text)]">
                {b.is_model ? (
                  <span className="font-semibold tracking-wide">{b.name}</span>
                ) : (
                  <span className="tracking-wide">{b.name}</span>
                )}
              </td>
              <td className="px-2 py-1.5 text-[var(--color-text-secondary)] tracking-wide">
                {b.source}
              </td>
              <td className="px-2 py-1.5 text-right tabular-nums text-[var(--color-text)]">
                {(b.accuracy * 100).toFixed(1)}%
              </td>
              <td className="px-2 py-1.5 text-right tabular-nums text-[var(--color-text)]">
                {(b.precision * 100).toFixed(1)}%
              </td>
              <td className="px-2 py-1.5 text-right tabular-nums text-[var(--color-text)]">
                {(b.recall * 100).toFixed(1)}%
              </td>
              <td className="px-2 py-1.5 text-right tabular-nums text-[var(--color-text)]">
                {(b.f1 * 100).toFixed(1)}%
              </td>
              <td className="px-2 py-1.5 text-right tabular-nums">
                <span style={{ color: missionColor(b.mission_weighted) }}>
                  {(b.mission_weighted * 100).toFixed(1)}%
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BaselinesChart({ baselines }: { baselines: ModelCardBaseline[] }) {
  const data = baselines.map((b) => ({
    name: b.name.replace(/^Current /, "").replace(/^Prior-year /, ""),
    mission: Math.round(b.mission_weighted * 1000) / 10,
    is_model: b.is_model,
  }));
  return (
    <div style={{ width: "100%", height: 180 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          margin={{ top: 8, right: 16, left: 0, bottom: 28 }}
        >
          <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="name"
            stroke="var(--color-text-muted)"
            tick={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10 }}
            interval={0}
            angle={-12}
            textAnchor="end"
            height={50}
          />
          <YAxis
            stroke="var(--color-text-muted)"
            tick={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10 }}
            tickFormatter={(v) => `${v}%`}
            domain={[0, 100]}
          />
          <Tooltip
            contentStyle={{
              background: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              fontFamily: "JetBrains Mono, monospace",
              fontSize: 12,
            }}
            formatter={(v) => [
              `${typeof v === "number" ? v.toFixed(1) : v}%`,
              "Mission-weighted score",
            ]}
          />
          <Bar dataKey="mission" radius={[2, 2, 0, 0]}>
            {data.map((d, i) => (
              <Cell
                key={i}
                fill={d.is_model ? "var(--color-primary)" : "var(--color-text-muted)"}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function missionColor(score: number): string {
  if (score >= 0.85) return "var(--color-success)";
  if (score >= 0.7) return "var(--color-warning)";
  return "var(--color-danger)";
}

// ---------------------------------------------------------------------------
// Splits
// ---------------------------------------------------------------------------

function SplitTable({ card }: { card: ModelCard }) {
  const total = card.split.train_n + card.split.val_n + card.split.test_n;
  const rows = [
    {
      label: "Train",
      n: card.split.train_n,
      start: card.split.train_start,
      end: card.split.train_end,
      color: "var(--color-primary)",
    },
    {
      label: "Validation",
      n: card.split.val_n,
      start: card.split.val_start,
      end: card.split.val_end,
      color: "var(--color-warning)",
    },
    {
      label: "Test (holdout)",
      n: card.split.test_n,
      start: card.split.test_start,
      end: card.split.test_end,
      color: "var(--color-success)",
    },
  ];
  return (
    <div>
      <div className="mb-2 flex h-2 w-full overflow-hidden rounded-sm border border-[var(--color-border)]">
        {rows.map((r) => (
          <div
            key={r.label}
            style={{
              width: `${(r.n / Math.max(total, 1)) * 100}%`,
              background: r.color,
            }}
            title={`${r.label}: ${r.n.toLocaleString("en-US")} rows`}
          />
        ))}
      </div>
      <table className="w-full font-mono text-sm">
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-t border-[var(--color-border)]">
              <td className="px-2 py-1 tracking-wide text-[var(--color-text)]">
                <span
                  className="mr-2 inline-block h-2 w-2 rounded-sm align-middle"
                  style={{ background: r.color }}
                />
                {r.label}
              </td>
              <td className="px-2 py-1 tabular-nums text-[var(--color-text-secondary)]">
                {r.start} → {r.end}
              </td>
              <td className="px-2 py-1 text-right tabular-nums text-[var(--color-text)]">
                {r.n.toLocaleString("en-US")} rows
              </td>
              <td className="px-2 py-1 text-right tabular-nums text-[var(--color-text-muted)]">
                {((r.n / Math.max(total, 1)) * 100).toFixed(1)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confusion matrix
// ---------------------------------------------------------------------------

function ConfusionMatrix({ card }: { card: ModelCard }) {
  const cm = card.confusion_matrix;
  const cells = [
    {
      label: "True positive",
      key: "tp",
      n: cm.tp,
      desc: "Predicted NMC, actually NMC — caught early.",
      color: "var(--color-success)",
      bg: "color-mix(in oklab, var(--color-success-muted) 32%, transparent)",
    },
    {
      label: "False positive",
      key: "fp",
      n: cm.fp,
      desc: "Predicted NMC, actually MC — wasted maintainer attention.",
      color: "var(--color-warning)",
      bg: "color-mix(in oklab, var(--color-warning-muted) 22%, transparent)",
    },
    {
      label: "False negative",
      key: "fn",
      n: cm.fn,
      desc: "Predicted MC, actually NMC — missed warning. The expensive error.",
      color: "var(--color-danger)",
      bg: "color-mix(in oklab, var(--color-danger-muted) 32%, transparent)",
    },
    {
      label: "True negative",
      key: "tn",
      n: cm.tn,
      desc: "Predicted MC, actually MC — quiet, correct.",
      color: "var(--color-text-muted)",
      bg: "var(--color-bg)",
    },
  ];
  return (
    <div>
      <div className="grid grid-cols-2 gap-2">
        {cells.map((c) => (
          <div
            key={c.key}
            className="rounded-sm border p-3"
            style={{ borderColor: c.color, background: c.bg }}
          >
            <div className="font-mono text-xs uppercase tracking-widest" style={{ color: c.color }}>
              {c.label}
            </div>
            <div
              className="mt-1 font-mono text-2xl font-semibold tabular-nums"
              style={{ color: c.color }}
            >
              {c.n.toLocaleString("en-US")}
            </div>
            <div className="mt-1 spire-body-muted">{c.desc}</div>
          </div>
        ))}
      </div>
      <div className="mt-3 spire-body-muted">
        <span className="font-mono text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
          Split ·{" "}
        </span>
        {cm.split} · n = {cm.n.toLocaleString("en-US")}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

function DriftChart({ card }: { card: ModelCard }) {
  const data = card.drift.series.map((p) => ({
    period: p.period,
    nmc_rate: Math.round(p.nmc_rate * 10000) / 100,
    avg_days_deadlined: p.avg_days_deadlined,
  }));
  if (data.length === 0) {
    return (
      <div className="rounded-sm border border-dashed border-[var(--color-border)] p-6 text-center font-mono text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
        NO DRIFT SERIES YET
      </div>
    );
  }
  return (
    <div style={{ width: "100%", height: 220 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
          <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="period"
            stroke="var(--color-text-muted)"
            tick={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10 }}
          />
          <YAxis
            yAxisId="left"
            stroke="var(--color-text-muted)"
            tick={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10 }}
            tickFormatter={(v) => `${v}%`}
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            stroke="var(--color-text-muted)"
            tick={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10 }}
          />
          <Tooltip
            contentStyle={{
              background: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              fontFamily: "JetBrains Mono, monospace",
              fontSize: 12,
            }}
          />
          <ReferenceLine y={0} yAxisId="left" stroke="var(--color-border)" />
          <Line
            yAxisId="left"
            type="monotone"
            dataKey="nmc_rate"
            name="NMC rate (%)"
            stroke="var(--color-danger)"
            strokeWidth={2}
            dot={{ r: 3, fill: "var(--color-danger)" }}
            isAnimationActive={false}
          />
          <Line
            yAxisId="right"
            type="monotone"
            dataKey="avg_days_deadlined"
            name="Avg days deadlined"
            stroke="var(--color-primary)"
            strokeWidth={2}
            dot={{ r: 3, fill: "var(--color-primary)" }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Last validation
// ---------------------------------------------------------------------------

function LastValidation({ card }: { card: ModelCard }) {
  const v = card.last_validation;
  return (
    <div className="grid grid-cols-2 gap-3 font-mono text-sm">
      <div>
        <div className="font-mono text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
          Date
        </div>
        <div className="mt-0.5 tabular-nums tracking-wide text-[var(--color-text)]">
          {v.date}
        </div>
      </div>
      <div>
        <div className="font-mono text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
          Validator
        </div>
        <div className="mt-0.5 tracking-wide text-[var(--color-text)]">{v.validator}</div>
        <div className="spire-body-muted">{v.validator_role}</div>
      </div>
      <div className="col-span-2">
        <div className="font-mono text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
          Methodology
        </div>
        <div className="mt-0.5 tracking-wide text-[var(--color-text-secondary)]">
          {v.methodology}
        </div>
        <a
          href={v.methodology_link}
          className="mt-1 inline-block text-[var(--color-primary)] hover:underline"
        >
          → full methodology · /admin/models/pulse-risk-scorer
        </a>
      </div>
    </div>
  );
}
