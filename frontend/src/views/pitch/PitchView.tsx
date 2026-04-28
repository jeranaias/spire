/**
 * PitchView — `/pitch`
 *
 * The 8-minute Shark-Tank pitch deck rendered inside SPIRE itself. Built
 * as an in-app surface so the presenter never jumps out to PowerPoint
 * mid-demo — the credibility cost of "this is a working tool" survives.
 *
 * Surface contract
 *   - One slide on screen at a time, 16:9-ish content frame.
 *   - Keyboard nav: ← / → / Space / PageUp / PageDown / Home / End.
 *   - Slide counter + dot strip in the footer.
 *   - Presenter mode toggle (P) shows speaker notes + a per-slide timer
 *     with a pacing badge against the slide's `targetSeconds` budget.
 *   - Slide 4 (live demo handoff) has the "Start demo" button that
 *     opens `/demo` in the same tab. After the demo, "Return to pitch
 *     — slide 5" jumps to slide 5.
 *   - Source of truth for copy is `slides.ts` — no strings hardcoded
 *     in this component.
 *
 * Architecture notes
 *   - This view sits inside the App shell, so the ClassificationBand
 *     stays visible (per the W2 brief: "Deck is part of the app").
 *   - We use the `?slide=N` query param so the presenter can deep-link
 *     into a specific slide (rehearsal jump, /demo's "back to pitch
 *     slide 5" affordance once lane A1 lands).
 *   - URL is the source of truth for current slide — the timer state
 *     resets when the slide index changes (see effect below).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import clsx from "clsx";
import { Button } from "../../components/ui";
import { useFailsafe } from "../../state/failsafe";
import {
  SLIDES,
  TOTAL_BUDGET_SECONDS,
  POST_DEMO_INDEX,
} from "./slides";
import { PitchVisual } from "./PitchVisual";

const SLIDE_PARAM = "slide";
const PRESENTER_KEY = "spire.pitch.presenter";

// Helpers ─────────────────────────────────────────────────────────────────
function clampIndex(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n >= SLIDES.length) return SLIDES.length - 1;
  return n;
}

function formatMmSs(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

// Inline detection for typing surfaces — mirrors App.tsx's chord guard so
// we don't hijack arrow keys while a presenter is editing the URL bar or
// a future text input on the deck.
function inField(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLInputElement ||
    t instanceof HTMLTextAreaElement ||
    t instanceof HTMLSelectElement ||
    (t instanceof HTMLElement && t.isContentEditable)
  );
}

export function PitchView() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();

  // W2 Task #39 — failsafe affordances on the deck. Same contract as
  // /demo: rehearsal is a non-destructive PIP toggle for drift checks;
  // failsafe is the panic key (confirm-gated) that swaps the live deck
  // for the recorded backup fullscreen.
  const failsafeMode = useFailsafe((s) => s.mode);
  const openFullscreenFailsafe = useFailsafe((s) => s.openFullscreen);
  const toggleRehearsalFailsafe = useFailsafe((s) => s.toggleRehearsal);
  const activateFailsafe = useCallback(() => {
    const ok = window.confirm(
      "Activate failsafe? The recorded backup will replace the live demo. Press OK only if the live demo has failed.",
    );
    if (ok) openFullscreenFailsafe();
  }, [openFullscreenFailsafe]);

  // 1-indexed in the URL (`?slide=1`) so the presenter sees slide numbers
  // matching the on-screen counter; 0-indexed in the array.
  const urlIndex = clampIndex(Number(params.get(SLIDE_PARAM) ?? "1") - 1);
  const slide = SLIDES[urlIndex];

  // Persist presenter-mode preference per browser — a presenter who toggles
  // it on during rehearsal expects it on during the live talk too.
  const [presenter, setPresenter] = useState<boolean>(() => {
    try {
      return localStorage.getItem(PRESENTER_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(PRESENTER_KEY, presenter ? "1" : "0");
    } catch {
      // Private mode / quota — non-fatal; preference reverts on reload.
    }
  }, [presenter]);

  const goToIndex = useCallback(
    (i: number) => {
      const next = clampIndex(i);
      // Preserve any other query params (none today, but future-proof).
      const merged = new URLSearchParams(params);
      merged.set(SLIDE_PARAM, String(next + 1));
      setParams(merged, { replace: false });
    },
    [params, setParams],
  );

  const next = useCallback(() => goToIndex(urlIndex + 1), [goToIndex, urlIndex]);
  const prev = useCallback(() => goToIndex(urlIndex - 1), [goToIndex, urlIndex]);

  // Keyboard navigation. We listen at window level so the slide responds
  // even when focus is on the slide chrome's buttons. Skip when typing,
  // and skip when the user is using a modifier (don't fight Cmd-Left).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (inField(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case "ArrowRight":
        case "PageDown":
        case " ": // Spacebar advances per the brief.
          e.preventDefault();
          next();
          break;
        case "ArrowLeft":
        case "PageUp":
          e.preventDefault();
          prev();
          break;
        case "Home":
          e.preventDefault();
          goToIndex(0);
          break;
        case "End":
          e.preventDefault();
          goToIndex(SLIDES.length - 1);
          break;
        case "p":
        case "P":
          // Presenter toggle. Lowercase only so a 'g p' chord routing to
          // PULSE (handled in App.tsx) still resolves first.
          if (e.key === "p") {
            e.preventDefault();
            setPresenter((v) => !v);
          }
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, prev, goToIndex]);

  // Per-slide timer. Reset to 0 when the slide changes; tick every 1s.
  // We run the interval regardless of presenter mode so toggling on
  // mid-slide shows accurate elapsed time, not zero.
  const [elapsedSec, setElapsedSec] = useState(0);
  const slideEnteredAt = useRef<number>(performance.now());
  useEffect(() => {
    slideEnteredAt.current = performance.now();
    setElapsedSec(0);
    const id = window.setInterval(() => {
      setElapsedSec(Math.floor((performance.now() - slideEnteredAt.current) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [urlIndex]);

  const startDemo = useCallback(() => {
    // Same-tab navigation per the brief. We use react-router so the
    // back button returns to /pitch with the same slide. Lane A1's
    // /demo isn't routed yet — when it lands, this hand-off works
    // unchanged. Until then, the back button still gets the presenter
    // home.
    nav("/demo");
  }, [nav]);

  const goToPostDemo = useCallback(() => {
    goToIndex(POST_DEMO_INDEX);
  }, [goToIndex]);

  const totalBudget = TOTAL_BUDGET_SECONDS;
  const slideNumber = urlIndex + 1;

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg)]">
      {/* Header — slide counter, mode toggle, total budget */}
      <PitchHeader
        slideNumber={slideNumber}
        slideCount={SLIDES.length}
        presenter={presenter}
        onTogglePresenter={() => setPresenter((v) => !v)}
        totalBudget={totalBudget}
        failsafeRehearsal={failsafeMode === "rehearsal"}
        onToggleRehearsal={toggleRehearsalFailsafe}
        onActivateFailsafe={activateFailsafe}
      />

      {/* Slide canvas — fills remaining space; presenter notes live below. */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 items-center justify-center px-8 py-6">
          <SlideCanvas
            slide={slide}
            onStartDemo={startDemo}
            onReturnToPostDemo={goToPostDemo}
          />
        </div>

        {presenter && (
          <PresenterPanel
            slide={slide}
            elapsedSec={elapsedSec}
          />
        )}
      </div>

      {/* Footer — dot-strip + prev/next */}
      <PitchFooter
        slideNumber={slideNumber}
        slideCount={SLIDES.length}
        onPrev={prev}
        onNext={next}
        onJump={goToIndex}
      />
    </div>
  );
}

// ─── Header ────────────────────────────────────────────────────────────────

interface HeaderProps {
  slideNumber: number;
  slideCount: number;
  presenter: boolean;
  onTogglePresenter: () => void;
  totalBudget: number;
  failsafeRehearsal: boolean;
  onToggleRehearsal: () => void;
  onActivateFailsafe: () => void;
}
function PitchHeader({
  slideNumber, slideCount, presenter, onTogglePresenter, totalBudget,
  failsafeRehearsal, onToggleRehearsal, onActivateFailsafe,
}: HeaderProps) {
  return (
    <header className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-6 py-3">
      <div className="flex items-baseline gap-3">
        <div className="font-mono text-xs uppercase tracking-[0.22em] text-[var(--color-primary)]">
          SPIRE · Pitch
        </div>
        <div className="font-mono text-xs text-[var(--color-text-muted)]">
          8-minute deck · target {formatMmSs(totalBudget)} total
        </div>
      </div>
      <div className="flex items-center gap-3">
        <div
          className="font-mono text-sm text-[var(--color-text)]"
          aria-live="polite"
          aria-atomic="true"
        >
          <span className="text-[var(--color-text-muted)]">slide </span>
          <span className="font-semibold tabular-nums">{slideNumber}</span>
          <span className="text-[var(--color-text-muted)]"> / {slideCount}</span>
        </div>
        <Button
          variant={presenter ? "primary" : "secondary"}
          size="sm"
          onClick={onTogglePresenter}
          aria-pressed={presenter}
          title="Toggle presenter mode (P)"
        >
          {presenter ? "Presenter · ON" : "Presenter · off"}
        </Button>
        {/* W2 Task #39 — failsafe affordances. Same pair as /demo. */}
        <Button
          variant="secondary"
          size="sm"
          onClick={onToggleRehearsal}
          aria-pressed={failsafeRehearsal}
          title="Show recording side-by-side for drift checks"
        >
          {failsafeRehearsal ? "Rehearsal · ON" : "Rehearsal"}
        </Button>
        <Button
          variant="warning"
          size="sm"
          onClick={onActivateFailsafe}
          title="Replace the live demo with the recorded backup (F9)"
        >
          Failsafe
        </Button>
      </div>
    </header>
  );
}

// ─── Slide canvas ──────────────────────────────────────────────────────────

interface CanvasProps {
  slide: typeof SLIDES[number];
  onStartDemo: () => void;
  onReturnToPostDemo: () => void;
}
function SlideCanvas({ slide, onStartDemo, onReturnToPostDemo }: CanvasProps) {
  const hasVisual = slide.visual !== "none";
  return (
    <article
      className="grid h-full w-full max-w-6xl grid-rows-[auto_1fr_auto] rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-8 shadow-lg"
      aria-label={`Slide ${slide.title}`}
    >
      {/* Eyebrow + title */}
      <header className="border-b border-[var(--color-border)] pb-4">
        {slide.eyebrow && (
          <div className="font-mono text-xs uppercase tracking-[0.22em] text-[var(--color-text-muted)]">
            {slide.eyebrow}
          </div>
        )}
        <h1 className="mt-2 font-mono text-2xl font-semibold tracking-tight text-[var(--color-text)] md:text-3xl">
          {slide.title}
        </h1>
      </header>

      {/* Body — points (left) + visual (right) */}
      <div className={clsx(
        "min-h-0 grid items-center gap-8 py-6",
        hasVisual ? "md:grid-cols-[3fr_2fr]" : "grid-cols-1",
      )}>
        <ul className="flex flex-col gap-3">
          {slide.points.map((p, i) => (
            <li key={i} className="flex items-start gap-3 text-base text-[var(--color-text)] md:text-lg">
              <span
                aria-hidden="true"
                className="mt-2 inline-block h-1.5 w-1.5 flex-none rounded-full bg-[var(--color-primary)]"
              />
              <span className="leading-snug">{p}</span>
            </li>
          ))}
        </ul>
        {hasVisual && (
          <div className="flex h-full min-h-[200px] items-center justify-center">
            <PitchVisual kind={slide.visual} />
          </div>
        )}
      </div>

      {/* Slide-specific affordances (live demo handoff) */}
      {slide.isDemoHandoff && (
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-border)] pt-4">
          <div className="font-mono text-xs uppercase tracking-[0.18em] text-[var(--color-text-muted)]">
            Live-demo handoff
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" size="md" onClick={onStartDemo}>
              Start demo →
            </Button>
            <Button
              variant="secondary"
              size="md"
              onClick={onReturnToPostDemo}
              title="Use after the demo to skip to the tech-depth slide."
            >
              Return to pitch — slide {POST_DEMO_INDEX + 1}
            </Button>
          </div>
        </footer>
      )}
    </article>
  );
}

// ─── Presenter notes panel ─────────────────────────────────────────────────

interface PresenterProps {
  slide: typeof SLIDES[number];
  elapsedSec: number;
}
function PresenterPanel({ slide, elapsedSec }: PresenterProps) {
  // Pacing badge: green while under target, amber within 25% over,
  // red beyond. Numbers chosen so a 30s slide doesn't flip amber the
  // instant it goes 1s long — that's a 3% nudge, not a pace problem.
  const target = slide.targetSeconds;
  const ratio = elapsedSec / Math.max(1, target);
  const tone = useMemo(() => {
    if (ratio < 1) return { label: "on pace", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40" };
    if (ratio < 1.25) return { label: "slightly long", cls: "bg-amber-500/15 text-amber-300 border-amber-500/40" };
    return { label: "over budget", cls: "bg-red-500/15 text-red-300 border-red-500/50" };
  }, [ratio]);

  return (
    <section
      aria-label="Speaker notes"
      className="border-t border-[var(--color-border)] bg-[var(--color-surface-raised)] px-6 py-4"
    >
      <header className="mb-2 flex flex-wrap items-center gap-3">
        <div className="font-mono text-xs uppercase tracking-[0.22em] text-[var(--color-primary)]">
          Speaker notes
        </div>
        <div className="font-mono text-xs text-[var(--color-text-muted)]">
          target {formatMmSs(target)}
        </div>
        <div
          className="font-mono text-sm font-semibold tabular-nums text-[var(--color-text)]"
          aria-live="polite"
        >
          {formatMmSs(elapsedSec)}
        </div>
        <span
          className={clsx(
            "rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider",
            tone.cls,
          )}
        >
          {tone.label}
        </span>
      </header>
      <ul className="grid gap-2">
        {slide.speakerNotes.map((n, i) => (
          <li key={i} className="flex items-start gap-2 text-sm text-[var(--color-text-muted)]">
            <span className="mt-1.5 inline-block h-1 w-1 flex-none rounded-full bg-[var(--color-text-muted)]" aria-hidden="true" />
            <span className="leading-relaxed">{n}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ─── Footer (dot strip + prev/next) ────────────────────────────────────────

interface FooterProps {
  slideNumber: number;
  slideCount: number;
  onPrev: () => void;
  onNext: () => void;
  onJump: (i: number) => void;
}
function PitchFooter({ slideNumber, slideCount, onPrev, onNext, onJump }: FooterProps) {
  return (
    <footer className="flex items-center justify-between gap-3 border-t border-[var(--color-border)] px-6 py-3">
      <Button
        variant="ghost"
        size="sm"
        onClick={onPrev}
        disabled={slideNumber <= 1}
        aria-label="Previous slide"
      >
        ← Prev
      </Button>

      <div className="flex items-center gap-1.5" role="tablist" aria-label="Slide navigation">
        {Array.from({ length: slideCount }).map((_, i) => {
          const active = i + 1 === slideNumber;
          return (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={active}
              aria-label={`Go to slide ${i + 1}`}
              onClick={() => onJump(i)}
              className={clsx(
                "h-2 rounded-full transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]",
                active
                  ? "w-6 bg-[var(--color-primary)]"
                  : "w-2 bg-[var(--color-border-active)] hover:bg-[var(--color-text-muted)]",
              )}
            />
          );
        })}
      </div>

      <div className="flex items-center gap-3">
        <span className="hidden font-mono text-[10px] uppercase tracking-wider text-[var(--color-text-muted)] md:inline">
          ← / → / space · P presenter
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onNext}
          disabled={slideNumber >= slideCount}
          aria-label="Next slide"
        >
          Next →
        </Button>
      </div>
    </footer>
  );
}
