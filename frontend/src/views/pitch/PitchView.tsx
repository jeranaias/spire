/**
 * PitchView — `/pitch`
 *
 * The 8-minute Shark-Tank pitch deck rendered inside SPIRE itself. Built
 * as an in-app surface so the presenter never jumps out to PowerPoint
 * mid-demo — the credibility cost of "this is a working tool" survives.
 *
 * Surface contract
 *   - One slide on screen at a time, 16:9-ish content frame.
 *   - Keyboard nav: ← / → / Space / PageUp / PageDown for clicker.
 *     Shift+Home / Shift+End jump to first / last slide. The bare
 *     Home / End / P keys are deliberately *not* live — those are too
 *     easy to fat-finger on stage (a bare 'p' used to dump speaker
 *     notes onto the projector; see Task #58).
 *   - Slide counter + dot strip in the footer.
 *   - Presenter mode toggle (Shift+P) opens speaker notes in a *separate
 *     window* via `window.open` so the audience screen never sees them.
 *     If the browser blocks the pop-up, we surface a styled in-app
 *     banner ("Show on this screen" / "Try popup again" / "Cancel")
 *     instead of `window.confirm` — the native dialog is jarring on
 *     stage (browser chrome flashes, focus jumps, and on some Linux
 *     setups it appears off-center on the secondary monitor; see
 *     Task #157). The banner is an alertdialog: Escape cancels,
 *     focus is parked on the safe "Try popup again" action.
 *   - Slide 4 (live demo handoff) has the "Start demo" button that
 *     opens `/demo` in the same tab. After the demo, "Return to pitch
 *     — slide 5" jumps to slide 5.
 *   - Source of truth for copy is `slides.ts` — no strings hardcoded
 *     in this component.
 *
 * Architecture notes
 *   - This view sits inside the App shell, so the ClassificationBannerStrip
 *     stays visible (per the W2 brief: "Deck is part of the app").
 *   - We use the `?slide=N` query param so the presenter can deep-link
 *     into a specific slide (rehearsal jump, /demo's "back to pitch
 *     slide 5" affordance once lane A1 lands).
 *   - URL is the source of truth for current slide — the timer state
 *     resets when the slide index changes (see effect below).
 *   - Failsafe / Rehearsal buttons in the header are gated to presenter
 *     mode — they telegraph low confidence to the audience otherwise.
 *     The hidden F9 hotkey (App.tsx) remains the always-on trigger so
 *     a true panic still works without pre-arming presenter mode.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
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

/**
 * Presenter-mode placement.
 *  - "off"     — no notes anywhere (default, safe for stage).
 *  - "popup"   — notes rendered in a separate `window.open` window,
 *                which the presenter drags to a confidence monitor.
 *                The audience screen shows nothing presenter-facing.
 *  - "inline"  — notes rendered below the slide on the active monitor.
 *                Only reached after an explicit confirm when the popup
 *                was blocked. The header still warns by toggling state.
 */
type PresenterMode = "off" | "popup" | "inline";

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

  // Presenter mode is *not* persisted (Task #58). Each page load starts
  // "off" so a refresh on the projector can never auto-restore a state
  // that leaks speaker notes onto the audience screen. Operators
  // explicitly enable it with Shift+P or the header button at run time.
  const [presenter, setPresenter] = useState<PresenterMode>("off");
  // The opened presenter window AND the element inside it that holds the
  // React portal. We compute both in the user-gesture handler so the
  // child component never has to mutate a popup it received as a prop —
  // React 19's lint rules (correctly) treat that as a code smell.
  const [presenterPortal, setPresenterPortal] = useState<{
    win: Window;
    root: HTMLElement;
  } | null>(null);
  // Banner state for the popup-blocked recovery prompt. We surface a
  // styled in-app alertdialog instead of `window.confirm` (Task #157).
  // The banner is only ever visible when the popup attempt failed AND
  // the operator hasn't yet decided how to recover.
  const [popupBlockedPrompt, setPopupBlockedPrompt] = useState(false);

  // Refs let togglePresenter stay stable across renders so the keyboard
  // listener doesn't have to rebind every time presenter state shifts.
  const presenterRef = useRef(presenter);
  const presenterPortalRef = useRef(presenterPortal);
  useEffect(() => {
    presenterRef.current = presenter;
  }, [presenter]);
  useEffect(() => {
    presenterPortalRef.current = presenterPortal;
  }, [presenterPortal]);

  // On unmount (route change, full reload), close any presenter popup we
  // own so we don't leave an orphaned window that re-binds to a fresh
  // PitchView mount with stale slide data.
  useEffect(() => {
    return () => {
      const w = presenterPortalRef.current?.win;
      if (w && !w.closed) {
        try {
          w.close();
        } catch {
          /* tab closing — non-fatal */
        }
      }
    };
  }, []);

  const closePresenter = useCallback(() => {
    const w = presenterPortalRef.current?.win;
    if (w && !w.closed) {
      try {
        w.close();
      } catch {
        /* non-fatal */
      }
    }
    setPresenterPortal(null);
    setPresenter("off");
    // Defensive cleanup: a stale popup-blocked banner should never
    // outlive the presenter session it was offered for.
    setPopupBlockedPrompt(false);
  }, []);

  // Pure side-effecty helper: try to open the presenter popup window
  // and wire it up. Returns true on success, false when the browser
  // blocked the popup or refused the cross-origin write. Must be
  // invoked from a user-gesture handler (click / keydown), otherwise
  // window.open will be blocked even on a permissive browser.
  const attemptOpenPresenterPopup = useCallback((): boolean => {
    const opened = window.open(
      "",
      "spire-presenter-notes",
      "width=560,height=780,menubar=no,toolbar=no,location=no,status=no,resizable=yes",
    );
    if (opened && !opened.closed) {
      // Set the document up *here*, in the gesture handler, so the
      // portal child is pure-render: it only reads `root` and renders
      // into it, never mutates the cross-window document.
      try {
        const root = preparePresenterDocument(opened);
        setPresenterPortal({ win: opened, root });
        setPresenter("popup");
        // Any successful popup-open clears the recovery banner — covers
        // both the banner's own "Try popup again" path AND the case
        // where the operator dismissed the banner, unblocked popups,
        // and re-toggled presenter mode from the header / Shift+P.
        setPopupBlockedPrompt(false);
        return true;
      } catch {
        // Cross-origin / write-blocked popup — close it and report
        // failure so the caller can offer the inline fallback banner.
        try {
          opened.close();
        } catch {
          /* non-fatal */
        }
      }
    }
    return false;
  }, []);

  const togglePresenter = useCallback(() => {
    if (presenterRef.current !== "off") {
      closePresenter();
      return;
    }
    // First choice: open a *separate* window so the audience screen
    // never sees presenter notes. The named target lets the same
    // window be reused if the presenter toggles off then on again.
    if (attemptOpenPresenterPopup()) return;
    // Pop-up blocker fired (or write-blocked). The native confirm
    // dialog used to be jarring on stage (focus jumps, off-center on
    // some Linux setups). Surface a styled in-app banner instead so
    // the operator can pick a recovery path calmly. The inline
    // fallback is the dangerous one — banner default focus is on
    // "Try popup again" so a stray Enter doesn't dump notes onto the
    // projector. See Task #157.
    setPopupBlockedPrompt(true);
  }, [closePresenter, attemptOpenPresenterPopup]);

  // Banner action handlers. Defined here (not inline) so the banner
  // component stays pure-render and the retry path can re-attempt the
  // popup from inside its own user-gesture click handler — the second
  // attempt is what most browsers actually allow once the operator
  // unblocks popups for the site.
  const dismissPopupPrompt = useCallback(() => {
    setPopupBlockedPrompt(false);
  }, []);
  const acceptInlineFallback = useCallback(() => {
    setPresenter("inline");
    setPopupBlockedPrompt(false);
  }, []);
  const retryPresenterPopup = useCallback(() => {
    // attemptOpenPresenterPopup clears popupBlockedPrompt on success,
    // so we don't have to here. If the retry also fails, we leave the
    // banner up so the operator can either try once more after
    // unblocking, or fall back inline.
    attemptOpenPresenterPopup();
  }, [attemptOpenPresenterPopup]);

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
  // and skip when the user is using ctrl/meta/alt (don't fight Cmd-Left).
  // Shift IS allowed because Shift is the guard for the dangerous keys
  // (Home/End/P) — see Task #58.
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
          // Shift-guarded — bare Home on a clicker is a misfire risk.
          if (e.shiftKey) {
            e.preventDefault();
            goToIndex(0);
          }
          break;
        case "End":
          // Shift-guarded — symmetrical with Home.
          if (e.shiftKey) {
            e.preventDefault();
            goToIndex(SLIDES.length - 1);
          }
          break;
        case "p":
        case "P":
          // Presenter toggle is the highest-risk shortcut on this view:
          // a stray bare 'p' used to dump the entire speaker script onto
          // the projector. Shift required (Task #58). Lowercase 'p' is
          // also tolerated *only* when shift is held (caps-lock + shift
          // can flip casing on some layouts).
          if (e.shiftKey) {
            e.preventDefault();
            togglePresenter();
          }
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, prev, goToIndex, togglePresenter]);

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
        onTogglePresenter={togglePresenter}
        totalBudget={totalBudget}
        failsafeRehearsal={failsafeMode === "rehearsal"}
        onToggleRehearsal={toggleRehearsalFailsafe}
        onActivateFailsafe={activateFailsafe}
      />

      {/* Slide canvas — fills remaining space; presenter notes only
       * render below in inline-fallback mode. */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 items-center justify-center px-8 py-6">
          <SlideCanvas
            slide={slide}
            onStartDemo={startDemo}
            onReturnToPostDemo={goToPostDemo}
          />
        </div>

        {presenter === "inline" && (
          <PresenterPanel slide={slide} elapsedSec={elapsedSec} />
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

      {/* Out-of-tree presenter window. Renders nothing into the audience
       * DOM; the portal target lives in a separate browser window. */}
      {presenter === "popup" && presenterPortal && (
        <PresenterNotesWindow
          slide={slide}
          elapsedSec={elapsedSec}
          win={presenterPortal.win}
          containerEl={presenterPortal.root}
          onClosed={closePresenter}
        />
      )}

      {/* In-app recovery banner shown when the browser blocked the
       * presenter-notes popup. Replaces the old `window.confirm` so
       * stage focus / chrome doesn't lurch (Task #157). */}
      {popupBlockedPrompt && (
        <PopupBlockedBanner
          onShowOnThisScreen={acceptInlineFallback}
          onRetryPopup={retryPresenterPopup}
          onCancel={dismissPopupPrompt}
        />
      )}
    </div>
  );
}

// ─── Header ────────────────────────────────────────────────────────────────

interface HeaderProps {
  slideNumber: number;
  slideCount: number;
  presenter: PresenterMode;
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
  const presenterOn = presenter !== "off";
  const presenterLabel =
    presenter === "popup"
      ? "Presenter · window"
      : presenter === "inline"
        ? "Presenter · ON SCREEN"
        : "Presenter · off";
  return (
    <header className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-6 py-3">
      <div className="flex items-baseline gap-3">
        <div className="font-mono text-xs uppercase tracking-[0.22em] text-[var(--color-primary)]">
          SPIRE · Pitch
        </div>
        <div className="font-mono text-xs text-[var(--color-text-muted)]">
          {Math.round(totalBudget / 60)}-minute deck · target {formatMmSs(totalBudget)} total
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
          variant={presenterOn ? "primary" : "secondary"}
          size="sm"
          onClick={onTogglePresenter}
          aria-pressed={presenterOn}
          title="Toggle presenter mode (Shift+P) — opens speaker notes in a separate window"
        >
          {presenterLabel}
        </Button>
        {/* W2 Task #39 / #58 — failsafe affordances are presenter-only.
         * Keeping them visible all the time telegraphs low confidence
         * before the demo even starts, and a stray click activates the
         * failsafe. F9 (App.tsx) remains the always-on hidden trigger
         * so a true panic still works even without presenter mode. */}
        {presenterOn && (
          <>
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
          </>
        )}
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

// ─── Presenter notes panel (inline-fallback only) ──────────────────────────
//
// Reached only when popups are blocked AND the operator explicitly
// confirms they want the notes on the audience screen. Kept visually
// distinct (warning band) so it is obvious notes are live-on-stage.

interface PresenterProps {
  slide: typeof SLIDES[number];
  elapsedSec: number;
}
function PresenterPanel({ slide, elapsedSec }: PresenterProps) {
  const target = slide.targetSeconds;
  const ratio = elapsedSec / Math.max(1, target);
  const tone = useMemo(() => {
    if (ratio < 1) return { label: "on pace", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40" };
    if (ratio < 1.25) return { label: "slightly long", cls: "bg-amber-500/15 text-amber-300 border-amber-500/40" };
    return { label: "over budget", cls: "bg-red-500/15 text-red-300 border-red-500/50" };
  }, [ratio]);

  return (
    <section
      aria-label="Speaker notes (visible to audience)"
      className="border-t-2 border-amber-500/60 bg-[var(--color-surface-raised)] px-6 py-4"
    >
      <header className="mb-2 flex flex-wrap items-center gap-3">
        <div className="font-mono text-xs uppercase tracking-[0.22em] text-amber-300">
          Speaker notes · ON AUDIENCE SCREEN
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

// ─── Popup-blocked recovery banner ─────────────────────────────────────────
//
// Replaces the old `window.confirm` fallback (Task #157). Shown only
// when the presenter popup was blocked or write-refused. Three explicit
// recovery paths so the operator never falls into the dangerous one
// (notes on the audience screen) by reflex:
//
//   - Try popup again — re-runs window.open from a fresh user gesture,
//     which usually succeeds the moment the operator unblocks popups.
//   - Show on this screen — opt-in to the inline fallback. The audience
//     will see the notes; copy is blunt about that.
//   - Cancel — leave presenter mode off. Escape also fires this path.
//
// Accessibility notes:
//   - role="alertdialog" + aria-modal so screen readers announce it as
//     a blocking decision rather than a passing toast.
//   - aria-labelledby / aria-describedby point at the title and body
//     so the announcement carries the full context.
//   - Default focus is parked on "Try popup again" — it's the safest
//     primary action; a stray Enter does not leak notes onto the
//     projector.
//   - Tab order is constrained to the three actions via a tiny focus
//     trap; the banner is small enough that a full focus-trap library
//     is overkill, but we still want Shift+Tab from the first button
//     to wrap to the last so keyboard users never get stuck.

interface PopupBlockedBannerProps {
  onShowOnThisScreen: () => void;
  onRetryPopup: () => void;
  onCancel: () => void;
}
function PopupBlockedBanner({
  onShowOnThisScreen,
  onRetryPopup,
  onCancel,
}: PopupBlockedBannerProps) {
  const retryRef = useRef<HTMLButtonElement>(null);
  const showHereRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Park focus on the safe primary action when the banner appears so
  // keyboard / screen-reader users land somewhere meaningful and a
  // stray Enter never triggers the dangerous "show on this screen"
  // path. We capture the previously-focused element and restore it
  // when the banner unmounts so the deck doesn't lose its tab anchor.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    retryRef.current?.focus();
    return () => {
      if (previouslyFocused && typeof previouslyFocused.focus === "function") {
        try {
          previouslyFocused.focus();
        } catch {
          /* element may have unmounted — non-fatal */
        }
      }
    };
  }, []);

  // Escape always cancels — matches the contract operators expect from
  // any modal-ish surface, and means a presenter who hits Esc on stage
  // never accidentally commits to the inline fallback.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // Tiny inline focus trap — three buttons in a fixed order. Tab from
  // the last wraps to the first; Shift+Tab from the first wraps to
  // the last. Anything else falls through unchanged.
  function onBannerKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Tab") return;
    const order = [retryRef.current, showHereRef.current, cancelRef.current].filter(
      (el): el is HTMLButtonElement => el !== null,
    );
    if (order.length === 0) return;
    const active = document.activeElement;
    const idx = order.findIndex((el) => el === active);
    if (idx === -1) return;
    const nextIdx = e.shiftKey
      ? (idx - 1 + order.length) % order.length
      : (idx + 1) % order.length;
    e.preventDefault();
    order[nextIdx]?.focus();
  }

  return (
    <div
      // Fixed top-center placement so the banner is visible regardless
      // of which slide / panel currently owns the canvas. pointer-events
      // gated to the inner card so the audience-visible deck stays
      // interactive for the next-slide button while the banner is up
      // (presenter still wants to advance).
      className="pointer-events-none fixed inset-x-0 top-4 z-[10000] flex justify-center px-4"
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="pitch-popup-blocked-title"
        aria-describedby="pitch-popup-blocked-desc"
        onKeyDown={onBannerKeyDown}
        className={clsx(
          "pointer-events-auto w-full max-w-xl rounded-md border-2 shadow-2xl",
          "border-amber-500/60 bg-[var(--color-surface-raised)]",
          "px-5 py-4",
        )}
      >
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="mt-1 inline-flex h-6 w-6 flex-none items-center justify-center rounded-full border border-amber-500/60 bg-amber-500/15 font-mono text-xs font-bold text-amber-300"
          >
            !
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h2
              id="pitch-popup-blocked-title"
              className="font-mono text-xs uppercase tracking-[0.22em] text-amber-300"
            >
              Presenter popup blocked
            </h2>
            <p
              id="pitch-popup-blocked-desc"
              className="text-sm leading-snug text-[var(--color-text)]"
            >
              Your browser blocked the separate presenter window. You can show
              speaker notes on{" "}
              <span className="font-semibold text-amber-300">this screen</span>{" "}
              (the audience will see them), or unblock popups for this site and
              try again. In Chrome, click the popup-blocked icon at the right
              edge of the address bar and choose &ldquo;Always allow&rdquo;.
            </p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          {/* Order matters: safest action is leftmost AND focused first
           * so a presenter pressing Enter under stage pressure picks the
           * non-destructive recovery, not the audience-visible one. */}
          <Button
            ref={retryRef}
            variant="primary"
            size="sm"
            onClick={onRetryPopup}
          >
            Try popup again
          </Button>
          <Button
            ref={showHereRef}
            variant="warning"
            size="sm"
            onClick={onShowOnThisScreen}
            title="Notes will be visible to the audience on this screen."
          >
            Show on this screen
          </Button>
          <Button
            ref={cancelRef}
            variant="ghost"
            size="sm"
            onClick={onCancel}
            aria-label="Cancel and leave presenter mode off (Escape)"
          >
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Presenter notes window (separate display) ─────────────────────────────
//
// Renders speaker notes via React.createPortal into a previously-prepared
// element living in a popup window's document. The popup setup happens
// in PitchView's gesture handler (`preparePresenterDocument` below) so
// this component is pure-render: it only reads its props.
//
// We inline the popup's CSS instead of cloning the host stylesheet —
// the panel is small, and decoupling it from Tailwind/Vite means the
// popup keeps working even after a dev-server hot reload that would
// otherwise shred a cloned <link rel="stylesheet">.

/**
 * Imperatively prepare a freshly-opened popup window: write title,
 * meta, inline CSS, and append a single root element we'll portal into.
 * Returns the root element. Throws if the popup's document is not
 * writable (cross-origin / extension blocked) so the caller can fall
 * back to the inline path.
 */
function preparePresenterDocument(win: Window): HTMLElement {
  win.document.title = "SPIRE — Presenter notes";
  win.document.head.innerHTML = `
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <style>
      html,body{margin:0;padding:0;background:#0b1220;color:#e6edf6;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}
      body{padding:20px 22px 64px;line-height:1.45;}
      .eyebrow{font-size:11px;letter-spacing:0.22em;text-transform:uppercase;color:#93c5fd;}
      .slide-title{font-size:22px;font-weight:600;margin:6px 0 14px;line-height:1.25;}
      .timer-row{display:flex;align-items:baseline;flex-wrap:wrap;gap:10px;margin:6px 0 4px;}
      .timer{font-size:38px;font-variant-numeric:tabular-nums;font-weight:600;}
      .target{font-size:12px;color:#94a3b8;}
      .badge{font-size:10px;letter-spacing:0.14em;text-transform:uppercase;padding:3px 8px;border:1px solid;border-radius:4px;}
      .badge-on{color:#6ee7b7;border-color:rgba(16,185,129,0.4);background:rgba(16,185,129,0.12);}
      .badge-warn{color:#fcd34d;border-color:rgba(245,158,11,0.4);background:rgba(245,158,11,0.12);}
      .badge-over{color:#fca5a5;border-color:rgba(239,68,68,0.5);background:rgba(239,68,68,0.12);}
      h2{font-size:12px;letter-spacing:0.22em;text-transform:uppercase;color:#93c5fd;margin:22px 0 8px;}
      ul{padding:0;margin:0;list-style:none;}
      li{display:flex;gap:10px;padding:6px 0;font-size:15px;color:#cbd5e1;align-items:flex-start;}
      li::before{content:"\u2022";color:#64748b;flex:none;}
      .footer{position:fixed;left:0;right:0;bottom:0;background:#0f172a;border-top:1px solid #1e293b;padding:8px 16px;font-size:11px;color:#64748b;display:flex;justify-content:space-between;gap:8px;}
    </style>
  `;
  // Wipe any prior body content (named-target reuse) and append our root.
  win.document.body.innerHTML = "";
  const root = win.document.createElement("div");
  win.document.body.appendChild(root);
  return root;
}

interface NotesWindowProps {
  slide: typeof SLIDES[number];
  elapsedSec: number;
  win: Window;
  containerEl: HTMLElement;
  onClosed: () => void;
}
function PresenterNotesWindow({
  slide, elapsedSec, win, containerEl, onClosed,
}: NotesWindowProps) {
  // Latest-onClosed ref so the polling loop never invokes a stale
  // callback (parent re-renders pass new closures every tick).
  const onClosedRef = useRef(onClosed);
  useEffect(() => {
    onClosedRef.current = onClosed;
  }, [onClosed]);

  useEffect(() => {
    // Detect manual close of the popup window so the parent state
    // syncs back to "off" and the header button reflects reality.
    const poll = window.setInterval(() => {
      if (win.closed) {
        window.clearInterval(poll);
        onClosedRef.current();
      }
    }, 400);

    // If the parent tab unloads, take the popup with it — orphaned
    // windows can't reach the React tree anymore and just confuse the
    // operator.
    const onParentUnload = () => {
      // Reading `win.closed` is safe (no mutation); we close the popup
      // via our own captured reference.
      const w = win;
      if (!w.closed) {
        try {
          w.close();
        } catch {
          /* non-fatal */
        }
      }
    };
    window.addEventListener("beforeunload", onParentUnload);

    return () => {
      window.clearInterval(poll);
      window.removeEventListener("beforeunload", onParentUnload);
    };
  }, [win]);

  const target = slide.targetSeconds;
  const ratio = elapsedSec / Math.max(1, target);
  const badgeClass = ratio < 1 ? "badge-on" : ratio < 1.25 ? "badge-warn" : "badge-over";
  const badgeLabel = ratio < 1 ? "on pace" : ratio < 1.25 ? "slightly long" : "over budget";

  return createPortal(
    <>
      {slide.eyebrow && <div className="eyebrow">{slide.eyebrow}</div>}
      <div className="slide-title">{slide.title}</div>
      <div className="timer-row">
        <span className="timer">{formatMmSs(elapsedSec)}</span>
        <span className={`badge ${badgeClass}`}>{badgeLabel}</span>
        <span className="target">target {formatMmSs(target)}</span>
      </div>
      <h2>Speaker notes</h2>
      <ul>
        {slide.speakerNotes.map((n, i) => (
          <li key={i}>{n}</li>
        ))}
      </ul>
      <div className="footer">
        <span>SPIRE · Presenter notes (separate window)</span>
        <span>Audience screen does not see this.</span>
      </div>
    </>,
    containerEl,
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
          ← / → / space · Shift+P presenter
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
