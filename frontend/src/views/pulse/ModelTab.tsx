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
import { useEffect, useMemo, useState } from "react";
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
import { formatApiError, withRetry } from "../../api-retry";
import { AwaitingIngestEmpty } from "../../components/AwaitingIngestEmpty";
import { ErrorState, LoadingState } from "../../components/ui";
import { useSpireStore } from "../../state/store";
import { formatAsOf } from "./FleetOverviewTab";

export function ModelTab() {
  const [card, setCard] = useState<ModelCard | null>(null);
  const [empty, setEmpty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  // Bumping this re-runs the load effect so the ErrorState retry
  // button re-enters the cold-load path without a full page reload
  // (which would also wipe sibling-tab state).
  const [loadAttempt, setLoadAttempt] = useState(0);
  // F6 — DDIL cache freshness. Mirrors the chip on RiskBoardTab and
  // ForecastTab so the operator sees the same stale-cache warning on
  // every PULSE surface when comms are denied and the data on screen
  // has aged out beyond the 5-minute floor.
  const ddilLastCacheHit = useSpireStore((s) => s.ddilLastCacheHit);
  const ddilMode = useSpireStore((s) => s.ddilMode);
  const STALE_THRESHOLD_MS = 5 * 60 * 1000;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // 30s tick matches the RiskBoardTab cadence — fast enough that the
    // chip flips on within ~5m05s of crossing the threshold without
    // taxing render.
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  const cacheStaleMs = useMemo(() => {
    if (ddilMode !== "DISCONNECTED") return null;
    if (!ddilLastCacheHit) return null;
    if (!ddilLastCacheHit.key.includes("/pulse/model-card")) return null;
    const ageMs = now - ddilLastCacheHit.cachedAt;
    return ageMs > STALE_THRESHOLD_MS ? ageMs : null;
  }, [ddilLastCacheHit, ddilMode, now]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setRetrying(true);
    // F6 — wrap the cold load in withRetry so a single transient 5xx /
    // SATCOM yellow doesn't dead-end the model-card surface. Schedule
    // matches the sibling RiskBoardTab / ForecastTab (1s/3s/5s).
    withRetry(() => api.pulse.modelCard())
      .then((res) => {
        if (cancelled) return;
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
      .catch((e) => { if (!cancelled) setError(formatApiError(e)); })
      .finally(() => { if (!cancelled) setRetrying(false); });
    return () => { cancelled = true; };
  }, [loadAttempt]);

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
          onRetry={() => setLoadAttempt((n) => n + 1)}
          retrying={retrying}
        />
      </div>
    );
  }
  if (!card) return <LoadingState size="page" label="Computing baselines …" />;

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex flex-col gap-4 p-4">
        <Header card={card} cacheStaleMs={cacheStaleMs} />
        <div className="grid grid-cols-2 gap-4">
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

        <Panel title="Holdout MAE · published accuracy claim">
          <HoldoutMaeBlock card={card} />
        </Panel>

        <div className="grid grid-cols-2 gap-4">
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

function Header({ card, cacheStaleMs }: { card: ModelCard; cacheStaleMs: number | null }) {
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
          {/* F5 — dataset freshness stamp. Routes the model card's
           * `as_of` through the shared formatAsOf helper so this header
           * reads identical "as of <date>" copy to FleetOverviewTab,
           * RiskBoardTab, and ForecastTab. */}
          {card.as_of && (
            <span className="ml-3 font-mono text-[var(--color-text-muted)] tracking-wider">
              · as of {formatAsOf(card.as_of)}
            </span>
          )}
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
        {cacheStaleMs != null && (
          <div
            role="status"
            className="mt-2 inline-flex items-center gap-2 rounded-sm border border-[var(--color-warning-muted)] bg-[color-mix(in_oklab,var(--color-warning-muted)_18%,var(--color-surface))] px-2 py-1 font-mono text-xs text-[var(--color-warning)] tracking-wider"
          >
            <span aria-hidden>▲</span>
            <span>
              Cached {Math.floor(cacheStaleMs / 60000)} min ago — DDIL disconnected.
              Verify before quoting baselines.
            </span>
          </div>
        )}
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

// ---------------------------------------------------------------------------
// Holdout-MAE block — the published accuracy claim (Task #87).
//
// Renders the model + baseline MAE side by side with bootstrap CIs, the
// frozen holdout window, and the relative diff. Same numbers the slide-5
// one-liner cites; same numbers `scripts/pulse_baseline_eval.py` prints.
// ---------------------------------------------------------------------------

function HoldoutMaeBlock({ card }: { card: ModelCard }) {
  const h = card.holdout_mae;
  if (!h) return null;
  const diff = h.baseline_diff_pct;
  const diffPositive = diff >= 0;
  const diffColor = diffPositive ? "var(--color-success)" : "var(--color-warning)";
  const diffSign = diffPositive ? "+" : "";
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <MaeCard
          label="PULSE-Risk"
          sublabel={`engine · ${card.engine.public_label}`}
          mae={h.model.mae}
          ciLower={h.model.ci_lower_95}
          ciUpper={h.model.ci_upper_95}
          n={h.model.n}
        />
        <MaeCard
          label={h.baseline.name}
          sublabel={`rule · ${h.baseline.rule}`}
          mae={h.baseline.mae}
          ciLower={h.baseline.ci_lower_95}
          ciUpper={h.baseline.ci_upper_95}
          n={h.baseline.n}
        />
      </div>
      <div
        className="rounded-sm border px-3 py-2 font-mono text-xs uppercase tracking-wider"
        style={{ color: diffColor, borderColor: diffColor }}
      >
        Relative MAE vs baseline · <span className="tabular-nums">{diffSign}{diff.toFixed(1)}%</span>
        {!diffPositive ? " · rule-based fallback under-performs SOP today (continuous prob incurs calibration penalty); trained-weights swap is the planned win" : ""}
      </div>
      <div className="grid grid-cols-2 gap-3 spire-body-muted">
        <div>
          <span className="font-mono text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
            Frozen window ·{" "}
          </span>
          <span className="tabular-nums">{h.frozen_holdout.window_start} → {h.frozen_holdout.window_end}</span>
          <div className="mt-1">
            <span className="font-mono text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
              Asset pool ·{" "}
            </span>
            n = <span className="tabular-nums">{h.frozen_holdout.asset_pool_n}</span> · horizon{" "}
            {h.frozen_holdout.evaluation_horizon_days}d
          </div>
        </div>
        <div>
          <span className="font-mono text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
            CI methodology ·{" "}
          </span>
          {h.model.method} · {h.model.n_bootstrap} resamples · seed={h.model.seed}
          <div className="mt-1">
            <span className="font-mono text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
              Reproduce ·{" "}
            </span>
            <code className="rounded-sm bg-[var(--color-bg)] px-1 py-0.5 text-[var(--color-text)]">
              python -m {h.reproducibility_script.replace(/\.py$/, "").replace(/\//g, ".")}
            </code>
          </div>
        </div>
      </div>
      <div className="spire-body-muted">
        <span className="font-mono text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
          Metric ·{" "}
        </span>
        {h.metric_definition}
      </div>
      <div className="spire-body-muted">
        <span className="font-mono text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
          Label ·{" "}
        </span>
        {h.frozen_holdout.label_definition}
      </div>
    </div>
  );
}

function MaeCard({
  label,
  sublabel,
  mae,
  ciLower,
  ciUpper,
  n,
}: {
  label: string;
  sublabel: string;
  mae: number;
  ciLower: number;
  ciUpper: number;
  n: number;
}) {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
      <div className="font-mono text-xs uppercase tracking-widest text-[var(--color-primary)]">
        {label}
      </div>
      <div className="mt-2 font-mono text-2xl font-semibold tabular-nums tracking-wide text-[var(--color-text)]">
        {mae.toFixed(4)}
      </div>
      <div className="mt-1 spire-body-muted">
        95% CI <span className="tabular-nums">{ciLower.toFixed(4)} – {ciUpper.toFixed(4)}</span> · n={n}
      </div>
      <div className="mt-1 spire-body-muted">{sublabel}</div>
    </div>
  );
}
