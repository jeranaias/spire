/**
 * StageCluster — single-bordered cluster for the Failsafe / Reset Demo /
 * Audit affordances. Replaces three side-by-side pills with one rounded
 * container so the right group reads as a single "stage controls" slot.
 *
 * The cluster honours each button's original gating so the operator
 * surface stays byte-equivalent to before the declutter:
 *
 *   - Failsafe: visible when a scenario is loaded and the failsafe is
 *     off (independent of stage mode).
 *   - Reset:    visible for `role === "g4"` outside stage mode; visible
 *     for any role inside stage mode (mirrors original ResetDemoButton).
 *   - Audit:    visible only in stage mode. The pre-declutter chrome
 *     guarded `AuditPill` with `{stageMode && <AuditPill />}`, so the
 *     icon is stage-only here too. (AuditView itself is reachable via
 *     direct nav in operator mode for g4 — the chrome chip was always
 *     stage-only.)
 *
 * The cluster renders nothing when none of its buttons are visible (so a
 * non-g4 operator with no scenario loaded never sees an empty rounded
 * shell). In operator mode for `role === "g4"` only the Reset button
 * renders inside the cluster, exactly mirroring the pre-declutter
 * `<ResetDemoButton />` chrome slot.
 *
 * The cluster sits in one slot of the right group's visual budget — the
 * task's "at most 5 visible chips" target counts this container as one,
 * not three.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { formatApiError } from "../api-retry";
import { useFailsafe } from "../state/failsafe";
import { useScenarioPlayer } from "../state/scenarioPlayer";
import { useSpireStore, type Role } from "../state/store";
import { useIdempotentAction } from "./ui";

export function StageCluster({ role }: { role: Role }) {
  const stageMode = useSpireStore((s) => s.stageMode);
  const setAlertCount = useSpireStore((s) => s.setAlertCount);
  const setAirGap = useSpireStore((s) => s.setAirGap);
  const setQueueDepth = useSpireStore((s) => s.setQueueDepth);
  const pushToast = useSpireStore((s) => s.pushToast);
  const nav = useNavigate();
  const scenarioLoaded = useScenarioPlayer((s) => s.scenarioId !== null);
  const failsafeMode = useFailsafe((s) => s.mode);
  const openFullscreen = useFailsafe((s) => s.openFullscreen);
  const [resetConfirm, setResetConfirm] = useState(false);

  const resetAction = useIdempotentAction(
    "stage-cluster:reset-demo",
    async () => {
      try {
        const r = await api.system.resetDemo();
        setAlertCount(0);
        setAirGap(false);
        setQueueDepth(0);
        const seconds = (r.duration_ms / 1000).toFixed(2);
        if (r.ok) {
          pushToast({
            tone: "ok",
            text: `SPIRE reset to clean demo state in ${seconds}s — alerts cleared, simulator reset, mission clock at H+0.`,
            ttlMs: 5000,
          });
        } else {
          const stepNames = r.failed_steps.map((s) => s.step).join(", ") || "unknown";
          pushToast({
            tone: "warn",
            text: `Demo reset partial (${seconds}s) — ${r.failed_steps.length} step${r.failed_steps.length === 1 ? "" : "s"} failed: ${stepNames}.`,
            ttlMs: 9000,
          });
        }
        nav("/", { replace: true });
      } catch (e) {
        pushToast({ tone: "error", text: `Reset failed: ${formatApiError(e)}` });
      } finally {
        setResetConfirm(false);
      }
    },
    { lockoutMs: 750 },
  );

  function activateFailsafe() {
    if (!scenarioLoaded || failsafeMode !== "off") return;
    const ok = window.confirm(
      "Activate failsafe? The recorded backup will replace the live demo. Press OK only if the live demo has failed.",
    );
    if (ok) openFullscreen();
  }

  // Original gating preserved exactly. See file header for the table.
  const showFailsafe = scenarioLoaded && failsafeMode === "off";
  const showReset = stageMode || role === "g4";
  const showAudit = stageMode;

  if (!showFailsafe && !showReset && !showAudit) return null;

  // Stage mode shows the warning-bordered cluster (matches pre-declutter
  // dramatic chrome). Operator mode uses the standard border so the
  // cluster doesn't shout at non-presenters who only ever click Audit.
  const borderClass = stageMode
    ? "border-[var(--color-warning)]"
    : "border-[var(--color-border)]";
  const dividerClass = stageMode
    ? "bg-[color-mix(in_oklab,var(--color-warning)_40%,transparent)]"
    : "bg-[var(--color-border)]";

  // Build the children list so we can interleave dividers without leaving
  // a leading or trailing separator when buttons are hidden.
  const children: React.ReactNode[] = [];
  if (showFailsafe) {
    children.push(
      <button
        key="failsafe"
        type="button"
        onClick={activateFailsafe}
        aria-label="Activate failsafe — replace live demo with recorded backup (F9)"
        title="Failsafe — replace the live demo with the recorded backup (F9)"
        data-testid="stage-cluster-failsafe"
        className="flex items-center gap-1.5 px-2.5 transition-colors text-[var(--color-warning)] hover:bg-[color-mix(in_oklab,var(--color-warning)_20%,var(--color-surface))]"
      >
        <span aria-hidden>◉</span>
        <span className="hidden xl:inline">Failsafe</span>
      </button>,
    );
  }
  if (showReset) {
    if (children.length > 0) {
      children.push(
        <span key="div-reset" className={`w-px self-stretch ${dividerClass}`} aria-hidden />,
      );
    }
    children.push(
      <button
        key="reset"
        type="button"
        onClick={() => setResetConfirm(true)}
        disabled={resetAction.pending}
        aria-label="Reset SPIRE to clean demo state"
        title="Return SPIRE to a known t=0 demo state"
        data-testid="stage-cluster-reset"
        className="flex items-center gap-1.5 px-2.5 text-[var(--color-danger)] transition-colors hover:bg-[color-mix(in_oklab,var(--color-danger-muted)_25%,var(--color-surface))] disabled:opacity-60"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M3 12a9 9 0 1 0 3-6.7" />
          <polyline points="3 4 3 10 9 10" />
        </svg>
        <span className="hidden xl:inline">{resetAction.pending ? "Resetting…" : "Reset"}</span>
      </button>,
    );
  }
  if (showAudit) {
    if (children.length > 0) {
      children.push(
        <span key="div-audit" className={`w-px self-stretch ${dividerClass}`} aria-hidden />,
      );
    }
    children.push(
      <button
        key="audit"
        type="button"
        onClick={() => nav("/admin/audit")}
        aria-label="Open audit chain — SOC view"
        title="Audit · SOC view (hash-chained, append-only)"
        data-testid="stage-cluster-audit"
        className="flex items-center gap-1.5 px-2.5 text-[var(--color-text-secondary)] transition-colors hover:bg-[color-mix(in_oklab,var(--color-success-muted)_22%,var(--color-surface))] hover:text-[var(--color-text)]"
      >
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: "var(--color-success)", boxShadow: "0 0 6px var(--color-success)" }}
          aria-hidden
        />
        <span className="hidden xl:inline">Audit</span>
      </button>,
    );
  }

  return (
    <div
      role="group"
      aria-label="Stage controls — failsafe, reset, audit"
      data-testid="stage-cluster"
      data-stage-mode={stageMode ? "1" : "0"}
      className={`inline-flex h-9 shrink-0 items-stretch overflow-hidden rounded-sm border ${borderClass} bg-[var(--color-surface)] font-mono text-[11px] uppercase tracking-widest`}
    >
      {children}

      {resetConfirm && (
        <div
          className="fixed inset-0 z-[8800] flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => !resetAction.pending && setResetConfirm(false)}
          role="presentation"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="m-4 max-w-md rounded-md border border-[var(--color-warning)] bg-[var(--color-surface)] p-5 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="stage-cluster-reset-title"
          >
            <div id="stage-cluster-reset-title" className="font-mono text-xs uppercase text-[var(--color-warning)] tracking-widest">
              Reset SPIRE
            </div>
            <h2 className="mt-1 font-sans text-lg font-semibold text-[var(--color-text)]">
              Return to clean demo state?
            </h2>
            <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
              Clears alerts, restarts mission clock, re-seeds simulator. Continue?
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setResetConfirm(false)}
                disabled={resetAction.pending}
                className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 font-mono text-xs uppercase tracking-widest text-[var(--color-text-secondary)] hover:border-[var(--color-border-active)]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => resetAction.run()}
                disabled={resetAction.pending}
                className="rounded-sm border border-[var(--color-warning)] bg-[color-mix(in_oklab,var(--color-warning)_18%,var(--color-surface))] px-3 py-1.5 font-mono text-xs uppercase tracking-widest text-[var(--color-warning)] hover:bg-[color-mix(in_oklab,var(--color-warning)_30%,var(--color-surface))] disabled:opacity-60"
              >
                {resetAction.pending ? "Resetting…" : "Reset demo"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
