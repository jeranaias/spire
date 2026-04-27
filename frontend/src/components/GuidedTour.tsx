/**
 * GuidedTour — spotlight-style first-run walkthrough.
 *
 * Built in response to operator feedback: "the screen has a lot going on,
 * walk me through one piece at a time." A modal explainer (Onboarding.tsx)
 * fired once on first load but never *pointed at* the chrome it was
 * describing — operators read the copy then went hunting for the role
 * selector / classification banner / alert badge with no idea where any
 * of it lived.
 *
 * This component dims the rest of the screen, cuts a "spotlight" hole
 * around one element at a time, and shows a plain-language card next to
 * it. Targets are looked up by `data-tour-id` attribute, so the tour
 * doesn't bind to brittle CSS selectors.
 *
 * Triggers (any of):
 *   - First-run, after Onboarding modal dismissed (auto, gated by
 *     localStorage `spire.tour.v1.seen`)
 *   - "Take the tour" button in HelpOverlay footer
 *   - "Show me around" CTA on Onboarding's last slide
 *   - window event `spire:start-tour` (programmatic)
 *
 * Persistence: localStorage `spire.tour.v1.seen`. Cleared by the "Replay
 * tour" button in HelpOverlay so operators can re-run it any time.
 *
 * Steps are role-aware: a step that targets an element the current role
 * can't see (e.g. AIR-GAP toggle outside security_manager / mef_commander)
 * is silently skipped.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSpireStore, type Role } from "../state/store";

const SEEN_KEY = "spire.tour.v1.seen";
export const TOUR_START_EVENT = "spire:start-tour";

// Pixel padding around the spotlight cutout so highlighted elements have
// a little breathing room from the dim overlay.
const SPOTLIGHT_PAD = 8;
// Extra room reserved for the tooltip card when computing placement.
const CARD_GAP = 16;
const CARD_WIDTH = 360;
const CARD_HEIGHT_ESTIMATE = 220;

interface TourStep {
  id: string;
  // Element selector (looked up via data-tour-id).
  target: string;
  title: string;
  body: string;
  // If present, only show this step when the current role is in the list.
  // Steps absent from the DOM at runtime are skipped automatically too.
  roles?: Role[];
}

const STEPS: TourStep[] = [
  {
    id: "classification",
    target: "classification",
    title: "Classification banner",
    body:
      "This green strip across the top tells you what level of information you're working with. It stays visible everywhere so you always know what you can — and can't — share. Today's session is unclassified demo data.",
  },
  {
    id: "brand",
    target: "brand",
    title: "Welcome to SPIRE",
    body:
      "Think of SPIRE as one screen for the things that normally take a dozen tabs — readiness, parts, sensors, paperwork. Built by Marines, runs on a laptop, works without internet.",
  },
  {
    id: "nav-tabs",
    target: "nav-tabs",
    title: "The three workspaces",
    body:
      "SENTRY handles the data side (classify, redact, release). PULSE is your readiness picture (what's broken, what's at risk). BASTION is the live map of base, units, and threats. Click a tab to switch — or press G then S, P, or B on the keyboard.",
  },
  {
    id: "role-selector",
    target: "role-selector",
    title: "Switch your role",
    body:
      "Different jobs see different things. Pick your role here and SPIRE lands you on the screen built for that job. You can always switch back without losing anything.",
  },
  {
    id: "alert-badge",
    target: "alert-badge",
    title: "What needs your attention",
    body:
      "The number tells you how many things SPIRE thinks you should look at — equipment going red, threats on the map, paperwork waiting. Green means clear, yellow means watch, red means act.",
  },
  {
    id: "airgap",
    target: "airgap",
    title: "Air-gap mode (offline operations)",
    body:
      "Tap this to cut outbound writes when comms go down. SPIRE keeps working, queues your changes locally, and replays them when you reconnect. Confirmation required — this is a posture decision.",
    roles: ["security_manager", "mef_commander"],
  },
  {
    id: "main",
    target: "main",
    title: "Your main workspace",
    body:
      "This is where you'll spend most of your time. The layout changes based on the tab and your role — but everything important is no more than two clicks deep.",
  },
  {
    id: "help",
    target: "help-button",
    title: "Quick help, anytime",
    body:
      "Press the ? key — or click this button — for keyboard shortcuts, what your role can do, and the FAQ. You can also restart this tour from there.",
  },
  {
    id: "feedback",
    target: "feedback-button",
    title: "Tell us what's broken",
    body:
      "Press G then F, or click here, to file feedback — defect, idea, or question. SPIRE attaches diagnostics automatically and sends it as a ticket. We read every one.",
  },
];

interface Rect { top: number; left: number; width: number; height: number; }

function findTarget(id: string): HTMLElement | null {
  if (typeof document === "undefined") return null;
  // Special case: id "main" matches the <main id="main"> landmark.
  if (id === "main") return document.getElementById("main");
  return document.querySelector<HTMLElement>(`[data-tour-id="${id}"]`);
}

function rectOf(el: HTMLElement): Rect {
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

export function startTour() {
  window.dispatchEvent(new CustomEvent(TOUR_START_EVENT));
}

export function GuidedTour() {
  const role = useSpireStore((s) => s.role);
  const [active, setActive] = useState(false);
  const [stepIdx, setStepIdx] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  // Steps applicable to the current role + currently mounted in the DOM.
  // Recomputed every time `active` or `role` changes (when starting / when
  // operator switches role mid-tour, which we tolerate).
  const visibleSteps = STEPS.filter((s) => {
    if (s.roles && !s.roles.includes(role)) return false;
    return true;
  });

  // First-run autostart — kicked off ~1.2s after the Onboarding modal would
  // have already been dismissed (Onboarding sets its own seen key on close).
  // We only autostart if both the onboarding-seen flag AND the tour-seen
  // flag agree it's a fresh seat.
  useEffect(() => {
    let cancelled = false;
    try {
      const tourSeen = localStorage.getItem(SEEN_KEY);
      const onboardingSeen = localStorage.getItem("spire.onboarding.v1.seen");
      // Autostart only if onboarding has been seen (so the modal isn't on
      // top of the spotlight) and the tour itself hasn't been seen yet.
      if (!tourSeen && onboardingSeen) {
        const t = window.setTimeout(() => {
          if (!cancelled) setActive(true);
        }, 600);
        return () => {
          cancelled = true;
          window.clearTimeout(t);
        };
      }
    } catch { /* tolerant */ }
  }, []);

  // External trigger (HelpOverlay button, Onboarding final-slide CTA).
  useEffect(() => {
    function onStart() {
      setStepIdx(0);
      setActive(true);
    }
    window.addEventListener(TOUR_START_EVENT, onStart);
    return () => window.removeEventListener(TOUR_START_EVENT, onStart);
  }, []);

  const currentStep = visibleSteps[stepIdx];

  // Recompute spotlight rect on step change, viewport resize, and scroll.
  // useLayoutEffect so the cutout appears in sync with the card placement
  // — a one-frame delay shows the card floating before the spotlight
  // catches up.
  useLayoutEffect(() => {
    if (!active || !currentStep) return;
    function update() {
      const el = findTarget(currentStep.target);
      if (!el) {
        setRect(null);
        return;
      }
      // Best-effort scroll-into-view if the target is off-screen. Auto
      // smooth-scroll is too slow for a Next click; we use 'instant'.
      const r = el.getBoundingClientRect();
      const off =
        r.bottom < 0 || r.top > window.innerHeight ||
        r.right < 0 || r.left > window.innerWidth;
      if (off) {
        try { el.scrollIntoView({ block: "center", inline: "center", behavior: "auto" }); } catch { /* noop */ }
      }
      setRect(rectOf(el));
    }
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [active, currentStep, stepIdx]);

  // If the current step's target isn't in the DOM (e.g. AIRGAP for a role
  // that can't see it), advance past it. Done in an effect so we don't
  // setState during render.
  useEffect(() => {
    if (!active || !currentStep) return;
    if (!findTarget(currentStep.target)) {
      // Skip forward.
      setStepIdx((i) => Math.min(i + 1, visibleSteps.length - 1));
    }
  }, [active, currentStep, visibleSteps.length]);

  const finish = useCallback(() => {
    setActive(false);
    setStepIdx(0);
    try { localStorage.setItem(SEEN_KEY, "1"); } catch { /* tolerant */ }
  }, []);

  const next = useCallback(() => {
    if (stepIdx >= visibleSteps.length - 1) {
      finish();
      return;
    }
    setStepIdx((i) => i + 1);
  }, [stepIdx, visibleSteps.length, finish]);

  const prev = useCallback(() => {
    setStepIdx((i) => Math.max(0, i - 1));
  }, []);

  // ESC to dismiss, ←/→ to navigate.
  useEffect(() => {
    if (!active) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        finish();
      } else if (e.key === "ArrowRight" || e.key === "Enter") {
        e.preventDefault();
        next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        prev();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, next, prev, finish]);

  if (!active || !currentStep) return null;

  // Compute card placement: prefer below, fall back to above, then to
  // centered. Falls back gracefully when rect is null (target not yet
  // measured) by centering the card.
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 720;
  const cardWidth = Math.min(CARD_WIDTH, vw - 32);

  let cardTop: number;
  let cardLeft: number;

  if (rect) {
    const spaceBelow = vh - (rect.top + rect.height) - CARD_GAP - 16;
    const spaceAbove = rect.top - CARD_GAP - 16;

    if (spaceBelow >= CARD_HEIGHT_ESTIMATE) {
      cardTop = rect.top + rect.height + CARD_GAP;
    } else if (spaceAbove >= CARD_HEIGHT_ESTIMATE) {
      cardTop = rect.top - CARD_HEIGHT_ESTIMATE - CARD_GAP;
    } else {
      // Center vertically as last resort.
      cardTop = Math.max(16, vh / 2 - CARD_HEIGHT_ESTIMATE / 2);
    }
    // Horizontally try to center on the target; clamp to viewport.
    cardLeft = rect.left + rect.width / 2 - cardWidth / 2;
    cardLeft = Math.max(16, Math.min(cardLeft, vw - cardWidth - 16));
  } else {
    cardTop = vh / 2 - CARD_HEIGHT_ESTIMATE / 2;
    cardLeft = vw / 2 - cardWidth / 2;
  }

  // Spotlight: a single absolutely-positioned div sitting over the target
  // rect with a giant box-shadow that blacks out everything outside it.
  // This is the classic "cutout" pattern and avoids needing SVG masks or
  // clip-paths that fight Tailwind container queries.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="tour-card-title"
      className="fixed inset-0 z-[9500] pointer-events-none"
    >
      {/* Click-catcher behind the spotlight — absorbs clicks so the
       * underlying app isn't accidentally interacted with mid-tour. */}
      <div
        className="absolute inset-0 pointer-events-auto"
        onClick={(e) => {
          // Click outside the highlighted area = next step. Operators
          // expect a tour-overlay to advance on click.
          e.stopPropagation();
        }}
      />
      {/* Spotlight cutout */}
      {rect && (
        <div
          className="absolute pointer-events-none transition-all duration-200"
          style={{
            top: rect.top - SPOTLIGHT_PAD,
            left: rect.left - SPOTLIGHT_PAD,
            width: rect.width + SPOTLIGHT_PAD * 2,
            height: rect.height + SPOTLIGHT_PAD * 2,
            borderRadius: 6,
            // The shadow is what dims everything *outside* the rect.
            boxShadow: "0 0 0 9999px rgba(4, 7, 12, 0.78)",
            // Subtle ring so the highlighted region pops.
            outline: "2px solid var(--color-primary)",
            outlineOffset: 2,
          }}
        />
      )}
      {/* Fallback dim when no rect — the whole screen darkens so the
       * card has contrast even if the target failed to mount. */}
      {!rect && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ background: "rgba(4, 7, 12, 0.78)" }}
        />
      )}
      {/* Tooltip card */}
      <div
        ref={cardRef}
        className="absolute pointer-events-auto rounded-md border border-[var(--color-primary)] bg-[var(--color-surface)] p-5 shadow-2xl transition-all duration-200"
        style={{
          top: cardTop,
          left: cardLeft,
          width: cardWidth,
        }}
      >
        <div className="flex items-center justify-between">
          <div className="font-mono text-xs uppercase text-[var(--color-primary)] tracking-widest">
            Tour · Step {stepIdx + 1} of {visibleSteps.length}
          </div>
          <button
            onClick={finish}
            className="font-mono text-xs uppercase text-[var(--color-text-muted)] hover:text-[var(--color-text)] tracking-widest"
            aria-label="Skip tour"
          >
            Skip
          </button>
        </div>
        <h3 id="tour-card-title" className="mt-2 font-sans text-lg font-semibold text-[var(--color-text)] tracking-tight">
          {currentStep.title}
        </h3>
        <p className="mt-2 text-sm leading-relaxed text-[var(--color-text-secondary)]">
          {currentStep.body}
        </p>
        {/* Step pips */}
        <div className="mt-4 flex items-center gap-1">
          {visibleSteps.map((_, i) => (
            <span
              key={i}
              className="h-1 w-4 rounded-full transition-colors"
              style={{ background: i <= stepIdx ? "var(--color-primary)" : "var(--color-border)" }}
              aria-hidden
            />
          ))}
        </div>
        <div className="mt-4 flex items-center justify-between">
          <button
            onClick={prev}
            disabled={stepIdx === 0}
            className="rounded-sm border border-[var(--color-border-active)] px-3 py-1.5 font-mono text-xs uppercase tracking-widest text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-30"
          >
            Back
          </button>
          <button
            onClick={next}
            className="rounded-sm border border-[var(--color-primary)] bg-[var(--color-primary)] px-4 py-1.5 font-mono text-xs font-semibold uppercase text-white tracking-widest hover:bg-[var(--color-primary-hover)]"
          >
            {stepIdx === visibleSteps.length - 1 ? "Got it" : "Next"}
          </button>
        </div>
        <div className="mt-3 font-mono text-[10px] uppercase text-[var(--color-text-muted)] tracking-widest">
          ← / → to navigate · Esc to close
        </div>
      </div>
    </div>,
    document.body,
  );
}
