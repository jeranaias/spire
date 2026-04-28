/**
 * DemoView — `/demo` entry point for the scripted scenario player
 * (lane W2 / Task #37).
 *
 * The view is the "presenter cockpit" — it doesn't show the demo content
 * itself (that lives in the four module views the player navigates to);
 * it shows the controls a presenter needs:
 *
 *   * Scenario picker (currently "Blood H+72" only).
 *   * Beat list with current beat highlighted (click to jump).
 *   * Play / Pause / Prev / Next controls.
 *   * Speed picker (1× / 4× / 16×).
 *   * Auto-advance toggle (auto vs. spacebar-driven).
 *   * Narration overlay show/hide toggle.
 *   * Reset button.
 *   * Hotkey legend.
 *
 * Once the operator hits Play the player navigates them OUT of /demo
 * and into the first beat's view (e.g. /bastion). The narration overlay
 * follows. To return to the cockpit, the operator clicks back to /demo
 * via the URL or returns from the topbar.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../api";
import { formatApiError } from "../api-retry";
import { useSpireStore } from "../state/store";
import {
  useScenarioPlayer,
  resolveViewRoute,
  type PlayerSpeed,
} from "../state/scenarioPlayer";
import { useFailsafe } from "../state/failsafe";
import { Pressable, LoadingState, ErrorState, Button } from "../components/ui";

// Mirror of `backend/scoping.py SCENARIO_CONTROL_ROLES`. The mission-clock
// control endpoint (play / pause / seek / reset) returns 403 for any
// other role. Disabling Reset locally for those roles avoids the FE
// snapping back to beat 0 while the backend mission clock keeps the
// previous `fired_events` set — i.e. the cockpit pretending it ran a
// reset that the backend rejected.
const SCENARIO_CONTROL_ROLES = new Set([
  "security_manager",
  "mef_commander",
  "g4",
]);

// Static catalogue of available scenarios. Today only the blood vignette
// ships; the picker is still rendered so a follow-on lane can drop a new
// scenario in by extending this list and routing the loader.
const SCENARIO_CATALOGUE = [
  {
    id: "blood-h72",
    title: "Blood / Class VIII H+72",
    summary: "3d MLR forward — casualty event drives Class VIII demand spike under SATCOM-degraded conditions.",
    duration_minutes: 4320,
  },
] as const;

export function DemoView() {
  const navigate = useNavigate();
  const pushToast = useSpireStore((s) => s.pushToast);

  const [pickerScenarioId, setPickerScenarioId] = useState<string>("blood-h72");
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  // Bumped when the operator clicks Retry on a failed scenario load. The
  // load `useEffect` below depends on this so a Retry click triggers a
  // fresh fetch even when `pickerScenarioId` hasn't changed (the bug was
  // that `setPickerScenarioId(id => id)` is a no-op for React — same
  // reference, no re-run).
  const [retryNonce, setRetryNonce] = useState(0);

  const role = useSpireStore((s) => s.role);
  const canControlScenario = SCENARIO_CONTROL_ROLES.has(role);
  // Reset error surfaces inline next to the transport row when the
  // backend rejects the reset (or any other control round-trip the
  // operator initiates from the cockpit). Sticky until the next
  // successful action.
  const [resetError, setResetError] = useState<string | null>(null);

  // W2 Task #39 — failsafe affordances. Two distinct calls: fullscreen
  // is the panic key (confirm gated); rehearsal is a non-destructive
  // PIP for drift checks during prep.
  const failsafeMode = useFailsafe((s) => s.mode);
  const openFullscreenFailsafe = useFailsafe((s) => s.openFullscreen);
  const toggleRehearsalFailsafe = useFailsafe((s) => s.toggleRehearsal);
  function activateFailsafe() {
    const ok = window.confirm(
      "Activate failsafe? The recorded backup will replace the live demo. Press OK only if the live demo has failed.",
    );
    if (ok) openFullscreenFailsafe();
  }

  // Player store reads.
  const scenario = useScenarioPlayer((s) => s.scenario);
  const beats = useScenarioPlayer((s) => s.beats);
  const currentBeatIndex = useScenarioPlayer((s) => s.currentBeatIndex);
  const status = useScenarioPlayer((s) => s.status);
  const speed = useScenarioPlayer((s) => s.speed);
  const autoAdvance = useScenarioPlayer((s) => s.autoAdvance);
  const narrationVisible = useScenarioPlayer((s) => s.narrationVisible);
  const loadScenario = useScenarioPlayer((s) => s.loadScenario);
  const setLoadError = useScenarioPlayer((s) => s.setLoadError);

  const play = useScenarioPlayer((s) => s.play);
  const pause = useScenarioPlayer((s) => s.pause);
  const next = useScenarioPlayer((s) => s.next);
  const prev = useScenarioPlayer((s) => s.prev);
  const jumpTo = useScenarioPlayer((s) => s.jumpTo);
  const setSpeed = useScenarioPlayer((s) => s.setSpeed);
  const setAutoAdvance = useScenarioPlayer((s) => s.setAutoAdvance);
  const setNarrationVisible = useScenarioPlayer((s) => s.setNarrationVisible);
  const reset = useScenarioPlayer((s) => s.reset);

  // Lazy-load on mount (or on picker change). The store's loadScenario
  // is idempotent — re-loading the same scenario re-uses the persisted
  // beat index, so a refresh resumes where the presenter left off.
  // `retryNonce` is in deps so a Retry click forces a fresh fetch even
  // when the picker selection hasn't changed.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadErr(null);
    api.system
      .scenarioBloodVignette()
      .then((meta) => {
        if (!alive) return;
        if (meta.scenario_id !== pickerScenarioId) {
          // Backend only ships blood-h72 today; this guards a future
          // multi-scenario fan-out.
          throw new Error(`scenario_id mismatch (got ${meta.scenario_id})`);
        }
        loadScenario(meta);
      })
      .catch((e) => {
        if (!alive) return;
        const msg = formatApiError(e);
        setLoadErr(msg);
        setLoadError(msg);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [pickerScenarioId, retryNonce, loadScenario, setLoadError]);

  // After Play, send the operator out to the first beat's view so they
  // land on the demo content immediately.
  function handlePlay() {
    play();
    const beat = beats[useScenarioPlayer.getState().currentBeatIndex];
    if (beat) navigate(resolveViewRoute(beat.view));
  }

  // Reset wipes the backend mission-clock too — gives a clean run with no
  // residual fired events. Issues the backend call FIRST so the FE only
  // claims a reset that actually landed; on rejection the FE state stays
  // put and a sticky inline error names the failure. The Reset button is
  // additionally disabled in render for roles outside SCENARIO_CONTROL_ROLES,
  // so the only way into this catch block is a transient backend / DDIL
  // failure for an authorized operator.
  async function handleReset() {
    setResetError(null);
    try {
      await api.system.scenarioControl("reset");
    } catch (e) {
      const msg = formatApiError(e);
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        setResetError(
          `Reset blocked by backend (${e.status}). This role can't drive the mission clock — switch to MEF Commander, G4, or Security Manager to reset.`,
        );
      } else {
        setResetError(`Reset failed: ${msg}`);
        pushToast({ tone: "warn", text: `Mission clock reset: ${msg}` });
      }
      return;
    }
    // Backend confirmed the reset — only now is it safe to snap the FE
    // back to beat 0. Otherwise the cockpit would say "READY @ beat 0"
    // while the backend kept the previous beat's fired_events on the
    // alert / forecast / audit feeds.
    reset();
  }

  const totalDwellSeconds = useMemo(() => {
    if (!beats.length) return 0;
    const sum = beats.reduce((a, b) => a + (b.expected_duration_seconds_at_1x ?? 30), 0);
    return Math.round(sum / speed);
  }, [beats, speed]);

  const currentBeat = beats[currentBeatIndex];

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-[var(--color-bg)]">
      <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-4 px-6 py-5">
        {/* ---- Header --------------------------------------------------- */}
        <header className="flex flex-wrap items-end justify-between gap-3 border-b border-[var(--color-border)] pb-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-[var(--color-text-muted)]">
              Scenario player · /demo
            </p>
            <h1 className="mt-1 font-sans text-xl font-semibold text-[var(--color-text)]">
              Scripted demo cockpit
            </h1>
            <p className="mt-1 max-w-[80ch] font-sans text-[12px] text-[var(--color-text-secondary)]">
              Pilots SPIRE through a scripted scenario beat-by-beat. Select a scenario, pick auto-advance or
              spacebar mode, then Play. The narration overlay follows you across views.
            </p>
          </div>
          <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
            <span
              className={
                "rounded-sm border px-2 py-1 font-semibold " +
                (status === "playing"
                  ? "border-[var(--color-primary)] text-[var(--color-primary)]"
                  : status === "complete"
                  ? "border-[var(--color-success)] text-[var(--color-success)]"
                  : "border-[var(--color-border-active)] text-[var(--color-text)]")
              }
            >
              {status.toUpperCase()}
            </span>
            <span>· est. {totalDwellSeconds}s @ {speed}×</span>
            {/* W2 Task #39 — failsafe affordances. Rehearsal is a
              * non-destructive PIP toggle (drift check during prep);
              * Failsafe is the panic key (confirm-gated) that swaps
              * the live demo for the recorded backup fullscreen. */}
            <Button
              variant="secondary"
              size="sm"
              onClick={toggleRehearsalFailsafe}
              aria-pressed={failsafeMode === "rehearsal"}
              title="Show recording side-by-side for drift checks"
            >
              {failsafeMode === "rehearsal" ? "Rehearsal · ON" : "Rehearsal"}
            </Button>
            <Button
              variant="warning"
              size="sm"
              onClick={activateFailsafe}
              title="Replace the live demo with the recorded backup (F9)"
            >
              Failsafe
            </Button>
          </div>
        </header>

        {/* ---- Scenario picker + summary ------------------------------- */}
        <section className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
            <h2 className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
              Scenario
            </h2>
            <ul className="mt-2 space-y-1.5">
              {SCENARIO_CATALOGUE.map((s) => {
                const selected = pickerScenarioId === s.id;
                return (
                  <li key={s.id}>
                    <Pressable
                      onClick={() => setPickerScenarioId(s.id)}
                      block
                      aria-pressed={selected}
                      className={
                        "!min-h-0 flex w-full flex-col items-start gap-0.5 rounded-sm border px-2.5 py-2 text-left transition-colors " +
                        (selected
                          ? "border-[var(--color-primary)] bg-[color-mix(in_oklab,var(--color-primary)_12%,var(--color-surface))]"
                          : "border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-border-active)]")
                      }
                    >
                      <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text)]">
                        {s.title}
                      </span>
                      <span className="font-sans text-[11px] text-[var(--color-text-secondary)]">
                        {s.summary}
                      </span>
                      <span className="mt-0.5 font-mono text-[9px] uppercase tracking-widest text-[var(--color-text-muted)]">
                        {Math.round(s.duration_minutes / 60)}h scenario time
                      </span>
                    </Pressable>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
            {loading ? (
              <LoadingState size="panel" label="Loading scenario…" />
            ) : loadErr ? (
              <ErrorState
                title="Scenario load failed"
                description="The scripted scenario metadata could not be retrieved from the backend."
                detail={loadErr}
                onRetry={() => setRetryNonce((n) => n + 1)}
                variant="inline"
              />
            ) : scenario ? (
              <>
                <h2 className="font-sans text-sm font-semibold text-[var(--color-text)]">
                  {scenario.title}
                </h2>
                <p className="mt-1 max-w-[80ch] font-sans text-[12px] text-[var(--color-text-secondary)]">
                  {scenario.summary}
                </p>
                <div className="mt-2 flex flex-wrap gap-2 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
                  <span>v{scenario.version}</span>
                  <span>·</span>
                  <span>{beats.length} beats</span>
                  <span>·</span>
                  <span>4 phases</span>
                </div>
              </>
            ) : null}
          </div>
        </section>

        {/* ---- Transport + speed --------------------------------------- */}
        <section className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Pressable
                onClick={prev}
                block={false}
                disabled={!beats.length || (currentBeatIndex === 0 && status !== "complete")}
                aria-label="Previous beat (Left arrow)"
                title="Previous beat (←)"
                className="!min-h-0 flex h-9 items-center gap-1.5 rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] px-3 font-mono text-xs uppercase tracking-widest text-[var(--color-text)] hover:border-[var(--color-primary)] disabled:opacity-40"
              >
                ◀◀ Prev
              </Pressable>
              {status === "playing" ? (
                <Pressable
                  onClick={pause}
                  block={false}
                  disabled={!beats.length}
                  aria-label="Pause (P)"
                  title="Pause (P)"
                  className="!min-h-0 flex h-9 items-center gap-1.5 rounded-sm border border-[var(--color-primary)] bg-[color-mix(in_oklab,var(--color-primary)_15%,var(--color-surface))] px-4 font-mono text-xs font-semibold uppercase tracking-widest text-[var(--color-primary)] hover:bg-[color-mix(in_oklab,var(--color-primary)_25%,var(--color-surface))]"
                >
                  ❚❚ Pause
                </Pressable>
              ) : (
                <Pressable
                  onClick={handlePlay}
                  block={false}
                  disabled={!beats.length}
                  aria-label="Play scenario (P)"
                  title="Play (P)"
                  className="!min-h-0 flex h-9 items-center gap-1.5 rounded-sm border border-[var(--color-primary)] bg-[color-mix(in_oklab,var(--color-primary)_15%,var(--color-surface))] px-4 font-mono text-xs font-semibold uppercase tracking-widest text-[var(--color-primary)] hover:bg-[color-mix(in_oklab,var(--color-primary)_25%,var(--color-surface))]"
                >
                  {status === "complete" ? "⟲ Replay" : "▶ Play"}
                </Pressable>
              )}
              <Pressable
                onClick={next}
                block={false}
                disabled={!beats.length || status === "complete"}
                aria-label="Next beat (Right arrow / Space)"
                title="Next beat (→ or Space)"
                className="!min-h-0 flex h-9 items-center gap-1.5 rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] px-3 font-mono text-xs uppercase tracking-widest text-[var(--color-text)] hover:border-[var(--color-primary)] disabled:opacity-40"
              >
                Next ▶▶
              </Pressable>
              <Pressable
                onClick={handleReset}
                block={false}
                disabled={!beats.length || !canControlScenario}
                aria-label={
                  canControlScenario
                    ? "Reset to first beat"
                    : "Reset disabled — this role can't drive the mission clock"
                }
                title={
                  canControlScenario
                    ? "Reset to first beat (also resets the backend mission clock)"
                    : "Reset disabled — only MEF Commander, G4, or Security Manager can reset the mission clock"
                }
                className="!min-h-0 flex h-9 items-center gap-1.5 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-3 font-mono text-xs uppercase tracking-widest text-[var(--color-text-secondary)] hover:border-[var(--color-warning)] hover:text-[var(--color-warning)] disabled:opacity-40 disabled:hover:border-[var(--color-border)] disabled:hover:text-[var(--color-text-secondary)]"
              >
                ⟲ Reset
              </Pressable>
            </div>
            <div className="flex items-center gap-3">
              <fieldset className="flex items-center gap-1.5">
                <legend className="sr-only">Demo speed</legend>
                <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
                  Speed
                </span>
                {[1, 4, 16].map((r) => {
                  const sel = speed === r;
                  return (
                    <Pressable
                      key={r}
                      onClick={() => setSpeed(r as PlayerSpeed)}
                      block={false}
                      role="radio"
                      aria-checked={sel}
                      className={
                        "!min-h-0 flex h-8 w-10 items-center justify-center rounded-sm border font-mono text-xs font-semibold uppercase tracking-widest " +
                        (sel
                          ? "border-[var(--color-primary)] bg-[color-mix(in_oklab,var(--color-primary)_15%,var(--color-surface))] text-[var(--color-primary)]"
                          : "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-secondary)] hover:border-[var(--color-border-active)] hover:text-[var(--color-text)]")
                      }
                    >
                      {r}×
                    </Pressable>
                  );
                })}
              </fieldset>
            </div>
          </div>
          {/* Toggles row */}
          <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-[var(--color-border)] pt-3 font-mono text-[11px] uppercase tracking-widest text-[var(--color-text-secondary)]">
            <ToggleSwitch
              label="Auto-advance"
              checked={autoAdvance}
              onChange={setAutoAdvance}
              hint={autoAdvance ? "Beats advance on their own dwell" : "Spacebar / Next button advances"}
            />
            <ToggleSwitch
              label="Narration overlay"
              checked={narrationVisible}
              onChange={setNarrationVisible}
              hint={narrationVisible ? "Visible (bottom of viewport)" : "Hidden"}
            />
          </div>
          {resetError && (
            <div className="mt-3" role="alert">
              <ErrorState
                title="Mission clock reset rejected"
                description={resetError}
                onRetry={() => setResetError(null)}
                retryLabel="Dismiss"
                variant="inline"
              />
            </div>
          )}
        </section>

        {/* ---- Beat list ------------------------------------------------ */}
        <section className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <h2 className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
            Timeline
          </h2>
          <ol className="mt-2 space-y-1.5">
            {beats.map((b, i) => {
              const active = i === currentBeatIndex && status !== "idle";
              return (
                <li key={b.beat_id}>
                  <Pressable
                    onClick={() => jumpTo(i)}
                    block
                    aria-current={active ? "step" : undefined}
                    className={
                      "!min-h-0 grid w-full grid-cols-[80px_120px_1fr_120px] items-center gap-3 rounded-sm border px-3 py-2 text-left transition-colors " +
                      (active
                        ? "border-[var(--color-primary)] bg-[color-mix(in_oklab,var(--color-primary)_10%,var(--color-surface))]"
                        : "border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-border-active)]")
                    }
                  >
                    <span className="font-mono text-[11px] font-semibold tabular-nums text-[var(--color-text)]">
                      H+{String(Math.floor(b.offset_min / 60)).padStart(3, "0")}:{String(b.offset_min % 60).padStart(2, "0")}
                    </span>
                    <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
                      {b.phase}
                    </span>
                    <span className="font-sans text-[12px] font-medium text-[var(--color-text)]">
                      {b.title}
                    </span>
                    <span className="text-right font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-secondary)]">
                      {b.view} · {b.expected_duration_seconds_at_1x}s
                    </span>
                  </Pressable>
                </li>
              );
            })}
          </ol>
          {currentBeat && (
            <div className="mt-3 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
              <h3 className="font-sans text-[12px] font-semibold text-[var(--color-text)]">
                Current beat: {currentBeat.title}
              </h3>
              <p className="mt-1 max-w-[80ch] font-sans text-[12px] text-[var(--color-text-secondary)]">
                {currentBeat.narration}
              </p>
            </div>
          )}
        </section>

        {/* ---- Hotkey legend ------------------------------------------- */}
        <section className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
          <h2 className="text-[var(--color-text-muted)]">Hotkeys</h2>
          <ul className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
            <li><kbd className="rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] px-1.5 py-0.5 text-[var(--color-text)]">Space</kbd> · advance / pause</li>
            <li><kbd className="rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] px-1.5 py-0.5 text-[var(--color-text)]">→</kbd> · next beat</li>
            <li><kbd className="rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] px-1.5 py-0.5 text-[var(--color-text)]">←</kbd> · previous beat</li>
            <li><kbd className="rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] px-1.5 py-0.5 text-[var(--color-text)]">P</kbd> · play / pause</li>
            <li><kbd className="rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] px-1.5 py-0.5 text-[var(--color-text)]">N</kbd> · narration on / off</li>
            <li><kbd className="rounded-sm border border-[var(--color-warning)] bg-[var(--color-bg)] px-1.5 py-0.5 text-[var(--color-warning)]">F9</kbd> · failsafe (recorded backup)</li>
            <li><kbd className="rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] px-1.5 py-0.5 text-[var(--color-text)]">Esc</kbd> · close failsafe</li>
          </ul>
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small toggle-switch atom — the project's primitives don't ship a switch
// today, so this is a local one-off shaped to match the surrounding chrome.
// Built on Pressable so the focus / disabled affordances match the rest
// of the UI.
// ---------------------------------------------------------------------------
function ToggleSwitch({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (b: boolean) => void;
  hint?: string;
}) {
  return (
    <Pressable
      onClick={() => onChange(!checked)}
      block={false}
      role="switch"
      aria-checked={checked}
      className="!min-h-0 flex items-center gap-2 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1 text-[var(--color-text-secondary)] hover:border-[var(--color-border-active)]"
    >
      <span
        aria-hidden
        className="relative inline-flex h-4 w-7 items-center rounded-full border transition-colors"
        style={{
          borderColor: checked ? "var(--color-primary)" : "var(--color-border-active)",
          background: checked
            ? "color-mix(in oklab, var(--color-primary) 30%, transparent)"
            : "var(--color-surface)",
        }}
      >
        <span
          className="absolute h-3 w-3 rounded-full transition-transform"
          style={{
            background: checked ? "var(--color-primary)" : "var(--color-text-muted)",
            transform: checked ? "translateX(14px)" : "translateX(2px)",
          }}
        />
      </span>
      <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text)]">{label}</span>
      {hint && (
        <span className="font-sans text-[10px] normal-case text-[var(--color-text-muted)]" style={{ letterSpacing: 0 }}>
          {hint}
        </span>
      )}
    </Pressable>
  );
}
