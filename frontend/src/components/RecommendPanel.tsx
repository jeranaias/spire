/**
 * RecommendPanel — GC-1 Autonomous Replenishment surface.
 *
 * Mounted under the PULSE Forecast chart. Pulls /pulse/recommend-actions
 * and renders the top-N at-risk assets with their ranked candidate
 * actions (cannibalize / expedite / cross-level). Each action shows the
 * impact-per-dollar-per-day score, cost, time-to-effect, expected MC%
 * delta, and an Approve button that creates the downstream artifact.
 *
 * This is the moment PULSE stops being a scoreboard and becomes an
 * operator. The score is the same primitive a G-4 would use to choose
 * between "wait for the depot order" and "burn the expedite budget."
 */
import { useEffect, useMemo, useState } from "react";
import { api, ApiError, type RecommendActionsAsset, type RecommendedAction } from "../api";
import { formatApiError } from "../api-retry";
import { useSpireStore } from "../state/store";
import { Button, ErrorState, LoadingState, EmptyState } from "./ui";

const KIND_COLOR: Record<string, string> = {
  cannibalize: "var(--color-warning)",
  expedite: "var(--color-danger)",
  cross_level: "var(--color-primary)",
  redistribute: "var(--color-info)",
};

const KIND_LABEL: Record<string, string> = {
  cannibalize: "CANNIBALIZE",
  expedite: "EXPEDITE",
  cross_level: "CROSS-LEVEL",
  redistribute: "REDISTRIBUTE",
};

export function RecommendPanel({ unit, hideHeader = false }: { unit?: string; hideHeader?: boolean }) {
  const role = useSpireStore((s) => s.role);
  const pushToast = useSpireStore((s) => s.pushToast);
  // Task #133 — subscribe to the DDIL replay queue so a CANNIBALIZE
  // approval that was queued under DISCONNECTED auto-flips its badge
  // from "Queued · DDIL" to "Replayed" the moment the CommsControl
  // drain removes its id from the store. Mirrors the pattern in
  // CannibalizationTab so this Forecast surface tells the same DDIL
  // story as the rest of the app.
  const ddilQueue = useSpireStore((s) => s.ddilQueue);
  const queuedIds = useMemo(() => new Set(ddilQueue.map((q) => q.id)), [ddilQueue]);
  const [data, setData] = useState<RecommendActionsAsset[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingApproval, setPendingApproval] = useState<string | null>(null);
  const [executed, setExecuted] = useState<Set<string>>(new Set());
  // Task #133 — track per-row DDIL queue id so the button can render a
  // "Queued · DDIL" badge while the local id is still in the global
  // queue, and flip to "Replayed" once it drains.
  const [queuedActions, setQueuedActions] = useState<Record<string, string>>({});

  useEffect(() => {
    setData(null);
    setError(null);
    api.pulse
      .recommendActions({ unit, top: 5 })
      .then((r) => setData(r.assets))
      .catch((e) => setError(formatApiError(e)));
  }, [unit, role]);

  async function approve(asset: RecommendActionsAsset, action: RecommendedAction) {
    const key = `${asset.asset_id}:${action.kind}:${action.title}`;
    setPendingApproval(key);
    try {
      // Cannibalization is the only action with a real backend endpoint today;
      // expedite and cross-level surface their artifact and toast — production
      // wires them up to TMR/MILSTRIP submission paths.
      //
      // Task #133 — route the propose POST through the DDIL-aware client
      // (`api.pulse.cannibalizationPropose`) instead of a raw fetch. The
      // interceptor applies LIMITED latency, INTERMITTENT packet drops,
      // and DISCONNECTED queue-for-replay automatically; we branch on
      // the structured ApiError it raises so the row's state and the
      // operator-facing toast match the actual transport outcome (the
      // raw fetch silently exited the "we work when comms are yellow"
      // demo on this surface). 15s AbortController is preserved so a
      // Fly cold-start can't freeze the button.
      if (action.kind === "cannibalize" && (action.artifact as any).recipient_sr) {
        const ctrl = new AbortController();
        const timer = window.setTimeout(() => ctrl.abort(), 15_000);
        try {
          const artifact = action.artifact as {
            recipient_sr: string;
            donor_asset_id?: string;
            donor_sr?: string;
            nsn: string;
          };
          await api.pulse.cannibalizationPropose(
            {
              recipient_sr: artifact.recipient_sr,
              donor_asset_id: artifact.donor_asset_id ?? "",
              donor_sr: artifact.donor_sr,
              nsn: artifact.nsn,
            },
            { signal: ctrl.signal },
          );
        } finally {
          window.clearTimeout(timer);
        }
      }
      pushToast({
        tone: "ok",
        // Walkthrough audit: mc_delta_pct is a 0..1 fraction in the API
        // (0.6 → +60%, not 0.6%). Prior format printed "MC +0.6%" which
        // misread the impact as a rounding error.
        text: `${KIND_LABEL[action.kind]} approved for ${asset.asset_id} · MC +${(action.mc_delta_pct * 100).toFixed(0)}%`,
      });
      setExecuted((prev) => {
        const n = new Set(prev);
        n.add(key);
        return n;
      });
    } catch (e) {
      const apiErr = e instanceof ApiError ? e : null;
      const ddilTag = apiErr ? ((apiErr.body as any)?.ddil ?? null) : null;
      const status = apiErr ? apiErr.status : 0;
      if (ddilTag === "queued") {
        // DDIL DISCONNECTED — interceptor pushed the write into the
        // local replay queue. Mark the row as "Queued · DDIL"; the
        // CommsControl drain will replay it on reconnect and the
        // useMemo'd queuedIds will flip the badge to "Replayed"
        // automatically. A global "All caught up" toast covers the
        // batch summary, but the per-row badge tells the operator
        // exactly which approval is in flight.
        const localId = apiErr ? ((apiErr.body as any)?.local_id as string | undefined) : undefined;
        setQueuedActions((prev) => ({ ...prev, [key]: localId ?? "" }));
        setExecuted((prev) => {
          const n = new Set(prev);
          n.add(key);
          return n;
        });
        pushToast({
          tone: "warn",
          text: `Comms denied — ${KIND_LABEL[action.kind]} for ${asset.asset_id} queued for replay${localId ? ` (${localId})` : ""}.`,
          ttlMs: 5000,
        });
      } else if (ddilTag === "intermittent") {
        // INTERMITTENT — wire dropped the request. Don't mark the row
        // executed; the operator re-issues the approval to retry, which
        // is the demo beat the DDIL spec asks for.
        pushToast({
          tone: "warn",
          text: `Comms intermittent — ${KIND_LABEL[action.kind]} packet dropped on the wire. Re-issue the approval.`,
          ttlMs: 5000,
        });
      } else if (status === 401) {
        // Session expired mid-approval. Bounce out via the store's
        // signOut bridge so the operator can sign back in and re-issue.
        pushToast({
          tone: "warn",
          text: "Session expired · sign in again to re-issue the approval.",
        });
        useSpireStore.getState().signOut();
      } else {
        pushToast({ tone: "error", text: `Approval failed: ${formatApiError(e)}` });
      }
    } finally {
      setPendingApproval(null);
    }
  }

  if (error) {
    return (
      <ErrorState
        variant="inline"
        title="Recommendation engine unavailable"
        detail={error}
      />
    );
  }
  if (!data) {
    return <LoadingState size="panel" label="Computing recommended actions …" />;
  }
  if (data.length === 0) {
    return (
      <EmptyState
        glyph="✓"
        title="No high-risk assets"
        description="Recommendation engine has nothing to do right now."
      />
    );
  }

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
      {!hideHeader && (
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-2.5">
          <div>
            <div
              className="font-mono text-xs uppercase text-[var(--color-primary)] tracking-widest"
            >
              Recommended Actions · Auto Replenishment
            </div>
            <div className="mt-0.5 spire-body-muted text-base">
              Top {data.length} at-risk assets. Each action ranked by impact-per-dollar-per-day.
            </div>
          </div>
          <div
            className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest"
          >
            {unit ? `Scope: ${unit}` : "Fleet-wide"}
          </div>
        </div>
      )}
      <div className="flex flex-col gap-3 p-3">
        {data.map((asset) => (
          <AssetActionGroup
            key={asset.asset_id}
            asset={asset}
            executed={executed}
            pendingApproval={pendingApproval}
            queuedActions={queuedActions}
            queuedIds={queuedIds}
            onApprove={approve}
          />
        ))}
      </div>
    </div>
  );
}

function AssetActionGroup({
  asset,
  executed,
  pendingApproval,
  queuedActions,
  queuedIds,
  onApprove,
}: {
  asset: RecommendActionsAsset;
  executed: Set<string>;
  pendingApproval: string | null;
  queuedActions: Record<string, string>;
  queuedIds: Set<string>;
  onApprove: (a: RecommendActionsAsset, act: RecommendedAction) => void;
}) {
  if (asset.actions.length === 0) {
    return (
      <div className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-3 font-mono text-sm text-[var(--color-text-muted)] tracking-wide">
        {asset.asset_id} — no actions available
      </div>
    );
  }
  return (
    <div className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
      <div className="mb-2 flex items-baseline gap-2 font-mono text-sm tracking-wide">
        <span className="font-semibold text-[var(--color-text)]">{asset.asset_id}</span>
        <span className="text-[var(--color-text-muted)]">{asset.equipment_type}</span>
        <span className="text-[var(--color-text-muted)]">· {asset.unit_name}</span>
        {asset.risk_score != null && (
          <span className="ml-auto rounded-sm border border-[var(--color-danger-muted)] px-1.5 py-[1px] text-xs uppercase text-[var(--color-danger)] tracking-widest">
            Risk {asset.risk_score.toFixed(0)}
          </span>
        )}
      </div>
      {asset.primary_factor && (
        <div className="mb-2 font-mono text-xs text-[var(--color-text-secondary)] tracking-wide">
          Primary factor: {asset.primary_factor}
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        {asset.actions.map((action, i) => {
          const key = `${asset.asset_id}:${action.kind}:${action.title}`;
          const done = executed.has(key);
          const pending = pendingApproval === key;
          const color = KIND_COLOR[action.kind] ?? "var(--color-text-secondary)";
          // Task #133 — DDIL-aware row state. A queued local id that is
          // still in the global ddilQueue renders as "Queued · DDIL"
          // (warning border); once CommsControl drains the queue the
          // local id falls out and the badge auto-flips to "Replayed"
          // (success border) with no extra useEffect.
          const queuedLocalId = queuedActions[key];
          const stillQueued = queuedLocalId !== undefined && queuedLocalId !== "" && queuedIds.has(queuedLocalId);
          const wasReplayed = queuedLocalId !== undefined && !stillQueued;
          const buttonBorder = stillQueued
            ? "var(--color-warning)"
            : done
              ? "var(--color-success)"
              : "var(--color-primary)";
          const buttonColor = buttonBorder;
          const buttonBg = stillQueued
            ? "color-mix(in oklab, var(--color-warning) 12%, transparent)"
            : done
              ? "color-mix(in oklab, var(--color-success-muted) 30%, transparent)"
              : "transparent";
          const buttonLabel = stillQueued
            ? "Queued · DDIL"
            : wasReplayed
              ? "✓ Replayed"
              : done
                ? "✓ Approved"
                : "Approve";
          return (
            <div
              key={i}
              className="flex items-center gap-3 rounded-sm border bg-[var(--color-surface)] px-3 py-2 transition-colors"
              style={{
                borderColor: stillQueued
                  ? "color-mix(in oklab, var(--color-warning) 50%, var(--color-border))"
                  : done
                    ? "color-mix(in oklab, var(--color-success) 40%, var(--color-border))"
                    : "var(--color-border)",
                background: stillQueued
                  ? "color-mix(in oklab, var(--color-warning) 10%, var(--color-surface))"
                  : done
                    ? "color-mix(in oklab, var(--color-success-muted) 18%, var(--color-surface))"
                    : "var(--color-surface)",
              }}
            >
              <span
                className="rounded-sm border px-1.5 py-[1px] font-mono text-xs font-semibold uppercase tracking-widest"
                style={{
                  color,
                  borderColor: `color-mix(in oklab, ${color} 40%, var(--color-border))`,
                  background: `color-mix(in oklab, ${color} 12%, transparent)`,
                  minWidth: "8.5rem",
                  textAlign: "center",
                }}
              >
                {KIND_LABEL[action.kind]}
              </span>
              <div className="flex-1 min-w-0">
                <div className="font-mono text-sm font-semibold text-[var(--color-text)] tracking-wide">
                  {action.title}
                </div>
                <div className="truncate font-mono text-xs text-[var(--color-text-secondary)] tracking-wide">
                  {action.description}
                </div>
              </div>
              <div className="flex items-center gap-3 font-mono text-xs tabular-nums text-[var(--color-text-muted)] tracking-wide">
                {/* mc_delta_pct is 0..1; render as "+NN" percentage points. */}
                <Stat label="MC%" value={`+${(action.mc_delta_pct * 100).toFixed(0)}`} tone="ok" />
                <Stat label="Cost" value={`$${action.cost_usd.toLocaleString("en-US")}`} />
                <Stat label="ETA" value={`${action.time_to_effect_hours}h`} />
                <Stat label="Conf" value={`${(action.confidence * 100).toFixed(0)}%`} />
              </div>
              <Button
                onClick={() => onApprove(asset, action)}
                disabled={done || pending}
                pending={pending}
                variant="secondary"
                size="sm"
                style={{
                  borderColor: buttonBorder,
                  color: buttonColor,
                  background: buttonBg,
                }}
              >
                {buttonLabel}
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "ok" }) {
  const color = tone === "ok" ? "var(--color-success)" : "var(--color-text)";
  return (
    <div className="flex flex-col items-end leading-tight" style={{ minWidth: "3.5rem" }}>
      <span className="text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
        {label}
      </span>
      <span style={{ color }}>{value}</span>
    </div>
  );
}
