/**
 * Scripted scenario player (lane W2 / Task #37).
 *
 * The "player" is the engine that walks the FE through a scenario's beats:
 * it navigates to each beat's declared view, asks the backend mission-clock
 * to seek to the beat's H+offset (so backend injectors fire and the audit
 * lineage gets written), and renders a narration overlay anchored to the
 * bottom of the viewport.
 *
 *   * Read-only on app state. The player never mutates a domain entity
 *     directly; every side-effect is dispatched through the existing
 *     mission-clock control endpoint (lane B4) so the backend remains
 *     the source of truth.
 *   * Two cadences:
 *       - 1× / 4× / 16× speed picker. Per-beat dwell = the beat's
 *         `expected_duration_seconds_at_1x` divided by the speed factor.
 *         A 16× rehearsal of the 6-beat blood vignette completes in
 *         ~22.5s (well under the 90s rehearsal target the scenario file
 *         declares in `speed_validation`).
 *       - Manual / "spacebar to advance" mode. When `autoAdvance=false`
 *         the player pauses on each beat until the operator hits SPACE
 *         (or clicks Next).
 *   * Resume. The current beat index + auto-advance + speed + narration
 *     visibility are persisted to sessionStorage. A page refresh (or a
 *     return-trip via /demo) drops the player back where it left off so
 *     a presenter doesn't lose their place mid-rehearsal.
 *
 * The store is Zustand (matches `state/store.ts` for consistency) but
 * deliberately separate so the demo player's transient bookkeeping
 * doesn't pollute the main app store. `<ScenarioPlayerHost>` is the only
 * imperative consumer — it watches the store, navigates on beat change,
 * runs the auto-advance timer, and listens for the spacebar hotkey.
 */
import { create } from "zustand";
import { type BloodScenarioBeatMeta, type BloodScenarioMeta } from "../api";

// ---------------------------------------------------------------------------
// View resolution. The scenario JSON authors target views as dotted slugs
// (`bastion.map`, `pulse.forecast`). The router knows about /-paths. This
// map is the single source of truth for that translation; new beats that
// reference an unknown slug fall back to the BASTION root so the demo
// always lands somewhere coherent.
//
// Why this lives here (not in the scenario JSON): the JSON is data the
// content team edits. Concrete React-Router paths are FE concerns; if a
// route is renamed / restructured, the slug stays the same and only this
// table changes.
// ---------------------------------------------------------------------------
export const VIEW_ROUTE_MAP: Record<string, string> = {
  // BASTION — alerts, COP, mission acceptance all live under one tab.
  "bastion.map": "/bastion",
  "bastion.mission": "/bastion",
  "bastion.alerts": "/bastion",
  // PULSE — alerts surface on the Risk Board, forecast on its own tab.
  "pulse.alerts": "/pulse/risk",
  "pulse.forecast": "/pulse/forecast",
  "pulse.risk": "/pulse/risk",
  "pulse.cannib": "/pulse/cannib",
  // SENTRY — Coalition tab is the destination for the H+36 release scrub.
  "sentry.coalition": "/sentry/coalition",
  "sentry.review": "/sentry/review",
  "sentry.upload": "/sentry/upload",
  // System / cross-cutting.
  "system.audit": "/admin/audit",
  "decision.bridge": "/",
};

export function resolveViewRoute(view: string | undefined): string {
  if (!view) return "/bastion";
  return VIEW_ROUTE_MAP[view] ?? "/bastion";
}

// ---------------------------------------------------------------------------
// Player state machine
// ---------------------------------------------------------------------------

export type PlayerStatus =
  | "idle"      // no scenario loaded
  | "ready"     // scenario loaded, not yet started
  | "playing"   // auto-advancing through beats
  | "paused"    // halted on the current beat (manual advance)
  | "complete"; // walked past the last beat

export type PlayerSpeed = 1 | 4 | 16;

export interface ScenarioPlayerState {
  scenarioId: string | null;
  scenario: BloodScenarioMeta | null;
  beats: BloodScenarioBeatMeta[];
  currentBeatIndex: number;
  status: PlayerStatus;
  speed: PlayerSpeed;
  /** When true, beat dwell timer auto-advances. When false, the player
   *  waits for spacebar / Next click. Independent of `status` so a paused
   *  state can still resume in either mode. */
  autoAdvance: boolean;
  /** Narration overlay visibility — operator-toggleable. The overlay's
   *  on-screen hint button also flips this. */
  narrationVisible: boolean;
  /** When the current beat was entered (epoch ms). The host turns this
   *  + the per-beat dwell into a CSS progress bar. */
  beatEnteredAt: number | null;
  /** Computed per-beat dwell in milliseconds at the current speed.
   *  Re-derived on every beat change / speed change. */
  beatDwellMs: number;
  /** Last load error so the picker / overlay can surface it. */
  loadError: string | null;

  /** Last successful backend seek offset (in scenario minutes). Set by
   *  the host whenever a `scenario.control seek` resolves; null until
   *  the first successful sync. The sync banner uses this to show how
   *  far the backend's mission clock has drifted from the player. */
  lastSyncedOffsetMin: number | null;

  /** Sticky desync record. The host sets this on ANY non-success seek
   *  (DDIL drop, 401/403, 5xx, network blip). Cleared on the next
   *  successful seek. The cockpit reads this to render the sticky
   *  "backend out of sync" banner instead of pretending the timeline
   *  advanced. */
  syncError: {
    message: string;
    attemptedOffsetMin: number;
    failedAt: number;
  } | null;

  // Derived getters used by UI.
  currentBeat: () => BloodScenarioBeatMeta | null;

  // Lifecycle.
  loadScenario: (scenario: BloodScenarioMeta) => void;
  setLoadError: (msg: string | null) => void;
  noteSyncSuccess: (offsetMin: number) => void;
  setSyncError: (err: { message: string; attemptedOffsetMin: number }) => void;
  clearSyncError: () => void;

  // Playback.
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  next: () => void;
  prev: () => void;
  jumpTo: (beatIndex: number) => void;
  setSpeed: (speed: PlayerSpeed) => void;
  setAutoAdvance: (b: boolean) => void;
  setNarrationVisible: (b: boolean) => void;
  toggleNarration: () => void;
  reset: () => void;
}

// Per-beat dwell. The `expected_duration_seconds_at_1x` field is the
// presenter's narration time at 1×; faster speeds compress it. At 16× we
// floor at 1.5s so the player doesn't strobe past beats faster than the
// view can re-render.
function computeDwellMs(beat: BloodScenarioBeatMeta | undefined, speed: PlayerSpeed): number {
  const base = (beat?.expected_duration_seconds_at_1x ?? 30) * 1000;
  const compressed = base / speed;
  return Math.max(1500, compressed);
}

// ---------------------------------------------------------------------------
// sessionStorage persistence — survives a refresh so a rehearsal doesn't
// lose its place. We only persist the small set of fields a presenter
// would care about restoring; the scenario itself is re-fetched from the
// backend on next mount (it's already cached server-side).
// ---------------------------------------------------------------------------

const STORAGE_KEY = "spire.demoPlayer.v1";

interface PersistedShape {
  scenarioId: string | null;
  currentBeatIndex: number;
  status: PlayerStatus;
  speed: PlayerSpeed;
  autoAdvance: boolean;
  narrationVisible: boolean;
}

function loadPersisted(): Partial<PersistedShape> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<PersistedShape>;
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed;
  } catch {
    return {};
  }
}

function savePersisted(s: ScenarioPlayerState): void {
  if (typeof window === "undefined") return;
  try {
    const payload: PersistedShape = {
      scenarioId: s.scenarioId,
      currentBeatIndex: s.currentBeatIndex,
      // Don't persist "playing" — a refresh shouldn't auto-resume the
      // timer; drop to "paused" so the presenter has to consciously
      // resume. Walkthrough rationale: nobody wants an unattended tab to
      // tick through a scripted demo by itself after a reload.
      status: s.status === "playing" ? "paused" : s.status,
      speed: s.speed,
      autoAdvance: s.autoAdvance,
      narrationVisible: s.narrationVisible,
    };
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* sessionStorage full / private mode — tolerant */
  }
}

const persisted = loadPersisted();

export const useScenarioPlayer = create<ScenarioPlayerState>((set, get) => ({
  scenarioId: persisted.scenarioId ?? null,
  scenario: null,
  beats: [],
  // currentBeatIndex is restored only after a scenario is loaded — until
  // then it stays at the persisted value and the player runs `loadScenario`
  // which clamps it to the available range.
  currentBeatIndex: typeof persisted.currentBeatIndex === "number" ? persisted.currentBeatIndex : 0,
  status: persisted.status ?? "idle",
  speed: (persisted.speed === 4 || persisted.speed === 16) ? persisted.speed : 1,
  autoAdvance: persisted.autoAdvance ?? false,
  narrationVisible: persisted.narrationVisible ?? true,
  beatEnteredAt: null,
  beatDwellMs: 0,
  loadError: null,
  lastSyncedOffsetMin: null,
  syncError: null,

  currentBeat: () => {
    const { beats, currentBeatIndex } = get();
    if (!beats.length) return null;
    return beats[Math.max(0, Math.min(beats.length - 1, currentBeatIndex))] ?? null;
  },

  loadScenario: (scenario) => {
    const beats = Array.isArray(scenario.beats) ? scenario.beats : [];
    // Clamp the persisted index against the loaded beat count (a config
    // edit could have shrunk the timeline since the last session).
    const persistedIdx = get().currentBeatIndex;
    const idx = beats.length === 0 ? 0 : Math.max(0, Math.min(beats.length - 1, persistedIdx));
    // If the persisted scenarioId doesn't match the freshly-loaded one,
    // reset to the first beat — a different scenario should not inherit
    // the previous one's progress.
    const matchesPersisted = get().scenarioId === scenario.scenario_id;
    const finalIdx = matchesPersisted ? idx : 0;
    const dwell = computeDwellMs(beats[finalIdx], get().speed);
    set({
      scenarioId: scenario.scenario_id,
      scenario,
      beats,
      currentBeatIndex: finalIdx,
      // Stay at the persisted status if it's a recognized post-load state
      // (paused / complete / ready); idle is upgraded to "ready".
      status: get().status === "idle" ? "ready" : get().status,
      beatEnteredAt: null,
      beatDwellMs: dwell,
      loadError: null,
      // Fresh load = fresh sync state; a desync from a prior session
      // shouldn't carry into a new scenario load.
      lastSyncedOffsetMin: null,
      syncError: null,
    });
    savePersisted(get());
  },

  setLoadError: (msg) => set({ loadError: msg }),

  noteSyncSuccess: (offsetMin) => {
    // Record the latest backend-confirmed offset and clear any sticky
    // desync banner. Called after each successful seek round-trip.
    set({ lastSyncedOffsetMin: offsetMin, syncError: null });
  },

  setSyncError: ({ message, attemptedOffsetMin }) => {
    // Sticky — we deliberately overwrite an existing error so the most
    // recent attempt is what the operator sees, but we never silently
    // clear it on a subsequent failure.
    set({
      syncError: {
        message,
        attemptedOffsetMin,
        failedAt: Date.now(),
      },
    });
  },

  clearSyncError: () => set({ syncError: null }),

  play: () => {
    const { beats, currentBeatIndex, status } = get();
    if (!beats.length) return;
    // Replaying from "complete" rewinds to the first beat. Ergonomic — a
    // presenter who just finished and wants another pass shouldn't have
    // to hunt for a Reset button.
    const idx = status === "complete" ? 0 : currentBeatIndex;
    const dwell = computeDwellMs(beats[idx], get().speed);
    set({
      status: "playing",
      currentBeatIndex: idx,
      beatEnteredAt: Date.now(),
      beatDwellMs: dwell,
    });
    savePersisted(get());
  },

  pause: () => {
    if (get().status === "playing") {
      set({ status: "paused" });
      savePersisted(get());
    }
  },

  togglePlay: () => {
    const s = get();
    if (s.status === "playing") s.pause();
    else s.play();
  },

  next: () => {
    const { beats, currentBeatIndex } = get();
    if (!beats.length) return;
    const nextIdx = currentBeatIndex + 1;
    if (nextIdx >= beats.length) {
      set({ status: "complete", beatEnteredAt: null });
      savePersisted(get());
      return;
    }
    const dwell = computeDwellMs(beats[nextIdx], get().speed);
    set({
      currentBeatIndex: nextIdx,
      beatEnteredAt: Date.now(),
      beatDwellMs: dwell,
    });
    savePersisted(get());
  },

  prev: () => {
    const { beats, currentBeatIndex } = get();
    if (!beats.length) return;
    const prevIdx = Math.max(0, currentBeatIndex - 1);
    if (prevIdx === currentBeatIndex && get().status !== "complete") return;
    const dwell = computeDwellMs(beats[prevIdx], get().speed);
    set({
      currentBeatIndex: prevIdx,
      // If we were "complete" and stepped back, drop to paused so the
      // operator can choose to play again.
      status: get().status === "complete" ? "paused" : get().status,
      beatEnteredAt: Date.now(),
      beatDwellMs: dwell,
    });
    savePersisted(get());
  },

  jumpTo: (beatIndex) => {
    const { beats } = get();
    if (!beats.length) return;
    const idx = Math.max(0, Math.min(beats.length - 1, beatIndex));
    const dwell = computeDwellMs(beats[idx], get().speed);
    set({
      currentBeatIndex: idx,
      status: "paused",
      beatEnteredAt: Date.now(),
      beatDwellMs: dwell,
    });
    savePersisted(get());
  },

  setSpeed: (speed) => {
    const { beats, currentBeatIndex } = get();
    const dwell = computeDwellMs(beats[currentBeatIndex], speed);
    // Restart the beat timer on speed change so the new dwell takes
    // effect immediately (rather than honoring the old deadline).
    const enteredAt = get().status === "playing" ? Date.now() : get().beatEnteredAt;
    set({ speed, beatDwellMs: dwell, beatEnteredAt: enteredAt });
    savePersisted(get());
  },

  setAutoAdvance: (autoAdvance) => {
    set({ autoAdvance });
    savePersisted(get());
  },

  setNarrationVisible: (narrationVisible) => {
    set({ narrationVisible });
    savePersisted(get());
  },

  toggleNarration: () => {
    set({ narrationVisible: !get().narrationVisible });
    savePersisted(get());
  },

  reset: () => {
    const { beats } = get();
    const dwell = computeDwellMs(beats[0], get().speed);
    set({
      currentBeatIndex: 0,
      status: beats.length > 0 ? "ready" : "idle",
      beatEnteredAt: null,
      beatDwellMs: dwell,
      // Operator-initiated reset clears the desync banner: the next
      // beat dispatch will re-seek the backend and either re-confirm
      // sync or set a fresh error.
      lastSyncedOffsetMin: null,
      syncError: null,
    });
    savePersisted(get());
  },
}));
