/**
 * Live-demo failsafe store (lane W2 / Task #39).
 *
 * The failsafe is the presenter's escape hatch when the live demo goes
 * sideways on stage — backend cycles, a chunk fails to load, a refresh
 * wipes scenario state, network dies. Instead of staring at a hung
 * spinner during the 3:15 demo slot, the presenter triggers the failsafe
 * and a pre-recorded MP4 of the same scripted scenario takes over,
 * fullscreen, with its own player controls so they can scrub if the
 * cut-over happens mid-beat.
 *
 * Three modes:
 *   - "off"        — failsafe is dormant; nothing rendered.
 *   - "fullscreen" — recording covers the entire viewport; presenter
 *                    pretends nothing went wrong.
 *   - "rehearsal"  — small floating PIP pinned to a corner so the
 *                    presenter can run the live demo and the recording
 *                    side-by-side to spot drift during prep.
 *
 * State is intentionally separate from the main SpireStore — this is
 * presenter-only theatre and never touches operator data flows. Lives
 * in its own zustand slice (mirrors `scenarioPlayer.ts`).
 *
 * Path to the recording is centralised here so the player component and
 * the README sidecar both reference the same constant.
 */
import { create } from "zustand";

export type FailsafeMode = "off" | "fullscreen" | "rehearsal";

/**
 * Public paths to the failsafe recording — ordered by browser preference.
 * Both files live under `frontend/public/` and Vite serves them as static
 * assets. The MP4 (H.264) is the canonical take that ships to stage; the
 * WebM (VP9) is a fallback so the player works in browsers / CI runners
 * that lack proprietary H.264 codecs (e.g. Playwright's bundled
 * Chromium). Both files should be re-encoded together when the live
 * recording is refreshed — see frontend/public/demo-failsafe.README.md.
 */
export const FAILSAFE_VIDEO_SOURCES: ReadonlyArray<{ src: string; type: string }> = [
  { src: "/demo-failsafe.mp4", type: "video/mp4" },
  { src: "/demo-failsafe.webm", type: "video/webm" },
] as const;

/** Back-compat single-src export (used by tests / docs). */
export const FAILSAFE_VIDEO_SRC = FAILSAFE_VIDEO_SOURCES[0].src;

interface FailsafeState {
  mode: FailsafeMode;
  /**
   * Open the fullscreen failsafe player. The presenter-affordance call
   * site is responsible for the confirm dialog — this setter is the
   * unconditional commit.
   */
  openFullscreen: () => void;
  /** Open the rehearsal-mode PIP so the presenter can drift-check. */
  openRehearsal: () => void;
  /** Close whichever mode is active. */
  close: () => void;
  /** Toggle rehearsal PIP without confirm (rehearsal is non-destructive). */
  toggleRehearsal: () => void;
}

export const useFailsafe = create<FailsafeState>((set, get) => ({
  mode: "off",
  openFullscreen: () => set({ mode: "fullscreen" }),
  openRehearsal: () => set({ mode: "rehearsal" }),
  close: () => set({ mode: "off" }),
  toggleRehearsal: () =>
    set({ mode: get().mode === "rehearsal" ? "off" : "rehearsal" }),
}));
