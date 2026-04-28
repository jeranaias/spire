/**
 * NarrationOverlay — bottom-anchored beat narration banner (W2 / Task #37).
 *
 * Renders the current scenario beat's title, narration prose, and overlay
 * callouts as a transparent strip pinned to the bottom of the viewport.
 *
 * Design constraints from the task spec:
 *   * Unobtrusive — bottom 15% of the screen, not a modal.
 *   * Doesn't block clicks on the underlying view. The wrapper is
 *     `pointer-events: none`; only the close button + speed badge are
 *     `pointer-events: auto`. A presenter can still demo the underlying
 *     surfaces (drag the map, click a row) while narration is showing.
 *   * Dismissable — clicking ✕ flips the player's `narrationVisible` so
 *     the strip hides until toggled back on from /demo or the keyboard.
 *
 * Mounted once at the App shell (next to ToastLane) so it's visible
 * regardless of which view the player has navigated into.
 */
import { useEffect, useState } from "react";
import { useScenarioPlayer } from "../state/scenarioPlayer";
import { Pressable } from "./ui";

export function NarrationOverlay() {
  const status = useScenarioPlayer((s) => s.status);
  const visible = useScenarioPlayer((s) => s.narrationVisible);
  const beats = useScenarioPlayer((s) => s.beats);
  const idx = useScenarioPlayer((s) => s.currentBeatIndex);
  const speed = useScenarioPlayer((s) => s.speed);
  const autoAdvance = useScenarioPlayer((s) => s.autoAdvance);
  const beatEnteredAt = useScenarioPlayer((s) => s.beatEnteredAt);
  const beatDwellMs = useScenarioPlayer((s) => s.beatDwellMs);
  const setNarrationVisible = useScenarioPlayer((s) => s.setNarrationVisible);
  const next = useScenarioPlayer((s) => s.next);
  const togglePlay = useScenarioPlayer((s) => s.togglePlay);

  // Hide whenever the player has nothing to say. "ready" is the loaded-
  // but-not-started state; we still hide there so the operator's first
  // interaction with the surface isn't a chunk of text covering the
  // intro view.
  const beat = beats[idx];
  const shouldRender =
    visible && beat && (status === "playing" || status === "paused" || status === "complete");

  // Tick a redraw at ~10Hz so the per-beat progress bar advances
  // smoothly without the store re-rendering on every wall tick. The
  // hook is mounted unconditionally so React doesn't trip the
  // "different number of hooks" rule when `shouldRender` flips.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!shouldRender || status !== "playing" || !autoAdvance || !beatEnteredAt) return;
    const id = window.setInterval(() => setTick((t) => (t + 1) % 1000), 100);
    return () => window.clearInterval(id);
  }, [shouldRender, status, autoAdvance, beatEnteredAt]);

  if (!shouldRender) return null;

  const elapsed = beatEnteredAt ? Date.now() - beatEnteredAt : 0;
  const pct = beatDwellMs > 0 ? Math.min(100, (elapsed / beatDwellMs) * 100) : 0;
  const showProgress = status === "playing" && autoAdvance && beatEnteredAt !== null;

  const callouts = beat.overlay?.callouts ?? [];
  const total = beats.length;

  return (
    <div
      // Wrapper claims the bottom 15% of the viewport but lets clicks
      // through to the underlying view. Aria-live polite announces beat
      // transitions to assistive tech without being assertive.
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[7800] flex justify-center px-4 pb-4"
      style={{ maxHeight: "15vh" }}
      role="status"
      aria-live="polite"
      aria-label="Demo narration"
    >
      <div
        className="pointer-events-auto relative w-full max-w-[1280px] overflow-hidden rounded-md border border-[var(--color-border-active)] shadow-2xl"
        style={{
          // Translucent so the underlying view is still partially
          // legible — the operator's eyes can saccade between them.
          background: "color-mix(in oklab, var(--color-surface) 90%, transparent)",
          backdropFilter: "blur(8px)",
        }}
      >
        {/* Top progress bar — only visible during auto-advance play. */}
        {showProgress && (
          <div
            className="absolute inset-x-0 top-0 h-[2px] overflow-hidden"
            aria-hidden
          >
            <div
              className="h-full transition-[width] duration-100 ease-linear"
              style={{
                width: `${pct}%`,
                background: "var(--color-primary)",
                boxShadow: "0 0 6px var(--color-primary)",
              }}
            />
          </div>
        )}

        <div className="flex items-start gap-4 px-4 py-3">
          {/* Beat counter + phase pill */}
          <div className="flex shrink-0 flex-col items-center gap-1 pt-0.5 font-mono text-[10px] uppercase tracking-widest">
            <span
              className="rounded-sm border border-[var(--color-primary)] bg-[color-mix(in_oklab,var(--color-primary)_15%,var(--color-surface))] px-1.5 py-0.5 font-semibold text-[var(--color-primary)] tabular-nums"
              aria-label={`Beat ${idx + 1} of ${total}`}
            >
              {String(idx + 1).padStart(2, "0")} / {String(total).padStart(2, "0")}
            </span>
            <span className="text-[var(--color-text-muted)]">{beat.phase}</span>
          </div>

          {/* Beat title + narration prose */}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-2">
              <h2 className="font-sans text-sm font-semibold text-[var(--color-text)]">
                {beat.title}
              </h2>
              <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
                {speed}× · {autoAdvance ? "auto" : "spacebar to advance"}
              </span>
            </div>
            <p className="mt-1 max-w-[80ch] font-sans text-[13px] leading-snug text-[var(--color-text-secondary)]">
              {beat.narration}
            </p>
            {callouts.length > 0 && (
              <ul className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
                {callouts.map((c, i) => (
                  <li key={i} className="flex items-center gap-1">
                    <span aria-hidden style={{ color: "var(--color-primary)" }}>·</span>
                    {c}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Right rail — controls + dismiss. Only the dismiss is on by
           * default; the next/play buttons mirror the /demo controls so
           * the presenter doesn't have to nav back to /demo to advance. */}
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <Pressable
              onClick={() => setNarrationVisible(false)}
              block={false}
              aria-label="Hide narration overlay"
              title="Hide narration · toggle back on from /demo"
              className="!min-h-0 flex h-6 w-6 items-center justify-center rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] font-mono text-[11px] text-[var(--color-text-muted)] hover:border-[var(--color-border-active)] hover:text-[var(--color-text)]"
            >
              ✕
            </Pressable>
            <div className="flex items-center gap-1">
              <Pressable
                onClick={togglePlay}
                block={false}
                aria-label={status === "playing" ? "Pause demo" : "Play demo"}
                title={status === "playing" ? "Pause" : "Play"}
                className="!min-h-0 flex h-7 w-7 items-center justify-center rounded-sm border border-[var(--color-border-active)] bg-[var(--color-surface)] font-mono text-[11px] uppercase tracking-widest text-[var(--color-text)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]"
              >
                {status === "playing" ? "❚❚" : "▶"}
              </Pressable>
              <Pressable
                onClick={next}
                block={false}
                disabled={status === "complete"}
                aria-label="Advance to next beat"
                title="Next beat (Space)"
                className="!min-h-0 flex h-7 w-7 items-center justify-center rounded-sm border border-[var(--color-border-active)] bg-[var(--color-surface)] font-mono text-[11px] uppercase tracking-widest text-[var(--color-text)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] disabled:opacity-40"
              >
                ▶▶
              </Pressable>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
