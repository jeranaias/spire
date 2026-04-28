/**
 * ScenarioPlayerHost — imperative side of the scripted scenario player
 * (lane W2 / Task #37).
 *
 * The player store (`state/scenarioPlayer.ts`) keeps the declarative
 * state — what beat we're on, are we playing, etc. This component is the
 * sole imperative consumer:
 *
 *   * Watches `currentBeatIndex` and navigates the router to the beat's
 *     declared view (resolved through `VIEW_ROUTE_MAP`).
 *   * Calls the backend mission-clock `seek` so the H+offset matches the
 *     beat — this is what fires the inject side-effects (audit rows,
 *     alerts, forecasts) for the underlying view to render.
 *   * Runs the auto-advance timer when `status === "playing"` and
 *     `autoAdvance === true`.
 *   * Listens for the global "spacebar to advance" hotkey (and a few
 *     companion bindings: ←/→ to step, P to play/pause, N to toggle
 *     narration). Honors text-input focus so we don't hijack typing.
 *
 * Mounted once at the App shell. Renders no DOM.
 */
import { useEffect, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { api, ApiError } from "../api";
import { useSpireStore } from "../state/store";
import {
  useScenarioPlayer,
  resolveViewRoute,
  type PlayerStatus,
} from "../state/scenarioPlayer";

// We only force navigation when the resolved route differs from where
// the operator already is. A presenter who hand-drove to PULSE during a
// pause shouldn't snap back to the beat's view on a second pause click;
// this guard kicks in only when the beat ITSELF changes.
function targetForBeatView(view: string | undefined): string {
  return resolveViewRoute(view);
}

export function ScenarioPlayerHost() {
  const navigate = useNavigate();
  const location = useLocation();
  const pushToast = useSpireStore((s) => s.pushToast);

  const status = useScenarioPlayer((s) => s.status);
  const autoAdvance = useScenarioPlayer((s) => s.autoAdvance);
  const beats = useScenarioPlayer((s) => s.beats);
  const currentBeatIndex = useScenarioPlayer((s) => s.currentBeatIndex);
  const beatDwellMs = useScenarioPlayer((s) => s.beatDwellMs);
  const next = useScenarioPlayer((s) => s.next);
  const prev = useScenarioPlayer((s) => s.prev);
  const togglePlay = useScenarioPlayer((s) => s.togglePlay);
  const pause = useScenarioPlayer((s) => s.pause);
  const toggleNarration = useScenarioPlayer((s) => s.toggleNarration);

  // Track the beat we last fanned out (navigated for + seeked to). On
  // change, run the side-effects exactly once — both for explicit
  // jumps and timer-driven advances.
  const lastDispatchedRef = useRef<{ beatIndex: number; status: PlayerStatus } | null>(null);

  useEffect(() => {
    if (!beats.length) return;
    if (status === "idle" || status === "ready") return;

    const beat = beats[currentBeatIndex];
    if (!beat) return;

    const last = lastDispatchedRef.current;
    if (last && last.beatIndex === currentBeatIndex && last.status === status) return;
    lastDispatchedRef.current = { beatIndex: currentBeatIndex, status };

    // 1. Navigate. Only if we're not already on the target route — see
    // `targetForBeatView` rationale; lets the operator wander mid-pause
    // without being yanked back unless a fresh beat fires.
    const target = targetForBeatView(beat.view);
    const currentPath = location.pathname;
    // Fuzzy match — beat targets like `/sentry/coalition` should also
    // satisfy `/sentry/coalition?…`. We compare path prefix-ish.
    const onTarget =
      currentPath === target ||
      (target !== "/" && currentPath.startsWith(target));
    if (!onTarget) {
      navigate(target);
    }

    // 2. Seek the mission clock so the backend injectors fire for this
    // beat. The control endpoint is gated to operator roles — for
    // non-operator identities (maintenance_chief, data_custodian) this
    // 403s; surface a one-shot toast and keep the player going (the
    // narration + view nav are still useful for a read-only walkthrough).
    api.system
      .scenarioControl("seek", { offset_min: beat.offset_min })
      .then(() => {
        // Auto-pause the backend clock between beats so injectors don't
        // fire ahead of the scripted narration — the player owns the
        // cadence, not wall-time.
        return api.system.scenarioControl("pause");
      })
      .catch((e) => {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          // Only toast once per scenario play — repeat 403s during a
          // run would spam the lane.
          if (!seekErrorShownRef.current) {
            seekErrorShownRef.current = true;
            pushToast({
              tone: "warn",
              text: "Demo player: this role can't drive the mission clock — narration + nav only.",
              ttlMs: 5000,
            });
          }
        }
        // Non-auth failures are tolerable too — the FE walkthrough still
        // proceeds, the backend timeline just won't sync.
      });
    // location.pathname intentionally omitted from deps — re-running the
    // dispatch on every router transition would cause a navigation loop
    // when the user manually nav'd away mid-pause and we re-applied the
    // beat target on the next render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentBeatIndex, status, beats, navigate]);

  // Reset the "already shown a 403 toast" flag on a fresh scenario load.
  const seekErrorShownRef = useRef(false);
  useEffect(() => {
    seekErrorShownRef.current = false;
  }, [beats]);

  // ---- Auto-advance timer -------------------------------------------------
  useEffect(() => {
    if (status !== "playing" || !autoAdvance) return;
    if (!beats.length) return;
    const dwell = beatDwellMs > 0 ? beatDwellMs : 30_000;
    const id = window.setTimeout(() => {
      next();
    }, dwell);
    return () => window.clearTimeout(id);
    // currentBeatIndex is a dep so the timer restarts on every beat
    // change (manual or otherwise).
  }, [status, autoAdvance, beatDwellMs, currentBeatIndex, beats, next]);

  // ---- Hotkeys ------------------------------------------------------------
  useEffect(() => {
    function inField(target: EventTarget | null): boolean {
      return (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      );
    }

    function onKey(e: KeyboardEvent) {
      // Hotkeys only matter while a scenario is loaded. Idle = leave
      // the user's keyboard alone.
      const playerStatus = useScenarioPlayer.getState().status;
      if (playerStatus === "idle") return;
      if (inField(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // Spacebar — advance. Pressed during play, also pauses the timer
      // (so a presenter can re-anchor cadence on the spot). The spec
      // calls this "advance with spacebar".
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        // If playing, pause first (operator wants control). If paused
        // or complete (replay), advance.
        if (playerStatus === "playing") {
          pause();
        } else {
          next();
        }
        return;
      }
      switch (e.key.toLowerCase()) {
        case "arrowright":
          e.preventDefault();
          next();
          return;
        case "arrowleft":
          e.preventDefault();
          prev();
          return;
        case "p":
          e.preventDefault();
          togglePlay();
          return;
        case "n":
          // 'n' toggles narration overlay — handy if a presenter wants
          // to clear the screen for a screenshot mid-beat.
          e.preventDefault();
          toggleNarration();
          return;
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, prev, pause, togglePlay, toggleNarration]);

  return null;
}
