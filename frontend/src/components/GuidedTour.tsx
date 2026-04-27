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
 * Expanded in v2 to walk through every page, not just the chrome:
 * each step optionally specifies a `route`, the tour navigates there
 * before measuring the target rect, and steps that the current role
 * can't reach (out-of-scope routes, role-only chrome) are silently
 * skipped. The tour now covers the operator's full workspace, not just
 * the global header.
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
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import { useSpireStore, VIEW_SCOPE, type Role } from "../state/store";

const SEEN_KEY = "spire.tour.v1.seen";
export const TOUR_START_EVENT = "spire:start-tour";

// Pixel padding around the spotlight cutout so highlighted elements have
// a little breathing room from the dim overlay.
const SPOTLIGHT_PAD = 8;
// Extra room reserved for the tooltip card when computing placement.
const CARD_GAP = 16;
const CARD_WIDTH = 360;
const CARD_HEIGHT_ESTIMATE = 240;
// How long to poll for a target element after navigating to a route
// before giving up and either skipping the step or rendering the card
// without a spotlight.
const TARGET_POLL_MS = 100;
const TARGET_POLL_MAX_MS = 2500;

interface TourStep {
  id: string;
  // Element selector (looked up via data-tour-id, or by id="main").
  target: string;
  title: string;
  body: string;
  // If present, only show this step when the current role is in the list.
  // Steps absent from the DOM at runtime are skipped automatically too.
  roles?: Role[];
  // Optional route to navigate to *before* measuring the target. If the
  // current location already matches, no navigation happens. Steps with
  // a route whose top-level scope (/sentry, /pulse, /bastion, /admin)
  // is out-of-bounds for the current role are silently skipped.
  route?: string;
}

const STEPS: TourStep[] = [
  // ── Section 1 — global chrome (visible from any route) ────────────
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

  // ── Section 2 — BASTION (live map) ────────────────────────────────
  {
    id: "bastion-overview",
    target: "bastion-content",
    title: "BASTION · the live map",
    body:
      "Your situational picture: every unit, every alert, every sensor on one map. The left column streams alerts (gate cameras, perimeter, drone feeds). Click an alert to fly the map to it.",
    route: "/bastion",
  },

  // ── Section 3 — PULSE (readiness) ─────────────────────────────────
  {
    id: "pulse-overview",
    target: "pulse-overview-content",
    title: "PULSE · Overview",
    body:
      "The big picture for readiness — KPIs across your unit, a 7-day trend, and the heatmap that lights up when an asset class is sliding. Start here when you want a one-glance answer to 'how are we doing?'",
    route: "/pulse/overview",
  },
  {
    id: "pulse-risk",
    target: "pulse-risk-content",
    title: "PULSE · Risk Board",
    body:
      "Asset-by-asset risk, ranked by deadline urgency. Predicted Failures (top), Risk Assets (middle), and the action recommendations (bottom). Click any asset to drill into its history.",
    route: "/pulse/risk",
  },
  {
    id: "pulse-cannib",
    target: "pulse-cannib-content",
    title: "PULSE · Cannibalization",
    body:
      "When a part's on backorder, SPIRE looks across your fleet for a donor — same NSN, lower priority, similar age. Pick the donor, draft the TMR, and the audit chain catches the swap automatically.",
    route: "/pulse/cannib",
  },
  {
    id: "pulse-forecast",
    target: "pulse-forecast-content",
    title: "PULSE · Forecast",
    body:
      "Monte Carlo readiness projection 7-30 days out. The fan chart shows the range; the recommended actions panel below tells you which interventions buy you the most readiness per dollar per day.",
    route: "/pulse/forecast",
  },

  // ── Section 4 — SENTRY (data pipeline) ────────────────────────────
  {
    id: "sentry-upload",
    target: "sentry-upload-content",
    title: "SENTRY · Upload",
    body:
      "The start of the classification pipeline. Drop a CSV / XLSX / JSON export from GCSS-MC or DRRS-MC and SPIRE seeds the canonical synthetic dataset for the demo.",
    route: "/sentry/upload",
  },
  {
    id: "sentry-review",
    target: "sentry-review-content",
    title: "SENTRY · Review Queue",
    body:
      "Records the auto-classifier wasn't sure about land here. Approve (A) or reject (R) — keyboard nav with ↑↓. Every decision feeds the model retraining loop.",
    route: "/sentry/review",
  },
  {
    id: "sentry-coalition",
    target: "sentry-coalition-content",
    title: "SENTRY · Coalition Preview",
    body:
      "See what JSDF, AUS, PHL, and FVEY partners would receive if you released this batch. Anything not releasable to a partner is blacked out in their preview.",
    route: "/sentry/coalition",
  },
  {
    id: "sentry-export",
    target: "sentry-export-content",
    title: "SENTRY · Export / Release",
    body:
      "Generate the audit-chained release package — a real ZIP with the redacted manifest, partner-specific views, and a tamper-evident hash. This is the artifact you hand off.",
    route: "/sentry/export",
  },

  // ── Section 5 — ADMIN (security manager only) ─────────────────────
  {
    id: "admin",
    target: "admin-content",
    title: "ADMIN · Audit + Telemetry",
    body:
      "The security manager's surface: audit-chain integrity, node-status fingerprints, and the training-flywheel telemetry that watches operator decisions feed the classifier.",
    route: "/admin",
    roles: ["security_manager"],
  },

  // ── Section 6 — closing utilities ─────────────────────────────────
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

// Top-level scope check: a step that targets /sentry, /pulse, /bastion,
// or /admin should only fire if the operator's role can reach it. Maps
// to the same VIEW_SCOPE the TopBar uses for tab gating.
function routeAllowedForRole(route: string | undefined, role: Role): boolean {
  if (!route) return true;
  const top = "/" + route.split("/")[1];
  const allowed = VIEW_SCOPE[top];
  if (!allowed) return true;
  return allowed.includes(role);
}

export function startTour() {
  window.dispatchEvent(new CustomEvent(TOUR_START_EVENT));
}

export function GuidedTour() {
  const role = useSpireStore((s) => s.role);
  const navigate = useNavigate();
  const location = useLocation();
  const [active, setActive] = useState(false);
  const [stepIdx, setStepIdx] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  // Steps applicable to the current role + route scope. Recomputed every
  // time `active` or `role` changes.
  const visibleSteps = STEPS.filter((s) => {
    if (s.roles && !s.roles.includes(role)) return false;
    if (!routeAllowedForRole(s.route, role)) return false;
    return true;
  });

  // First-run autostart — see comment block below for the two triggers.
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    function scheduleAutostart(delayMs: number) {
      try {
        if (localStorage.getItem(SEEN_KEY)) return;
      } catch { /* tolerant */ }
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!cancelled) setActive(true);
      }, delayMs);
    }

    // Trigger 1: mount-time check.
    try {
      const onboardingSeen = localStorage.getItem("spire.onboarding.v1.seen");
      if (onboardingSeen) scheduleAutostart(600);
    } catch { /* tolerant */ }

    // Trigger 2: mid-session, after Onboarding fires its seen event.
    function onOnboardingSeen() {
      scheduleAutostart(900);
    }
    window.addEventListener("spire:onboarding-seen", onOnboardingSeen);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.removeEventListener("spire:onboarding-seen", onOnboardingSeen);
    };
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

  // When the current step asks for a different route, navigate first.
  // The next effect (target poll) waits for the page to mount before
  // measuring. Done in a separate effect so navigate() doesn't fire
  // on every re-render of the same step.
  useEffect(() => {
    if (!active || !currentStep) return;
    if (!currentStep.route) return;
    // Only navigate if we're not already there. HashRouter location
    // pathname is the path *after* the hash, so /pulse/risk compares
    // directly to currentStep.route.
    if (location.pathname !== currentStep.route) {
      navigate(currentStep.route);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, stepIdx]);

  // Recompute spotlight rect on step change, viewport resize, and scroll.
  // Polls for the target up to TARGET_POLL_MAX_MS — needed because a
  // step that just navigated has to wait for the new view's lazy chunk
  // to load and render before its data-tour-id appears in the DOM.
  useLayoutEffect(() => {
    if (!active || !currentStep) return;
    let cancelled = false;
    let attempts = 0;
    const maxAttempts = Math.ceil(TARGET_POLL_MAX_MS / TARGET_POLL_MS);
    let pollHandle: number | undefined;

    function tryMeasure() {
      if (cancelled) return;
      const el = findTarget(currentStep.target);
      if (el) {
        // Best-effort scroll-into-view if the target is off-screen.
        const r = el.getBoundingClientRect();
        const off =
          r.bottom < 0 || r.top > window.innerHeight ||
          r.right < 0 || r.left > window.innerWidth;
        if (off) {
          try { el.scrollIntoView({ block: "center", inline: "center", behavior: "auto" }); } catch { /* noop */ }
        }
        setRect(rectOf(el));
        return;
      }
      attempts += 1;
      if (attempts >= maxAttempts) {
        // Fallback: render the card without a spotlight (full-screen
        // dim). Better than blocking the tour entirely.
        setRect(null);
        return;
      }
      pollHandle = window.setTimeout(tryMeasure, TARGET_POLL_MS);
    }

    tryMeasure();

    function onResize() {
      const el = findTarget(currentStep.target);
      if (el) setRect(rectOf(el));
    }
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);

    return () => {
      cancelled = true;
      window.clearTimeout(pollHandle);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  }, [active, currentStep, stepIdx, location.pathname]);

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
      cardTop = Math.max(16, vh / 2 - CARD_HEIGHT_ESTIMATE / 2);
    }
    cardLeft = rect.left + rect.width / 2 - cardWidth / 2;
    cardLeft = Math.max(16, Math.min(cardLeft, vw - cardWidth - 16));
  } else {
    cardTop = vh / 2 - CARD_HEIGHT_ESTIMATE / 2;
    cardLeft = vw / 2 - cardWidth / 2;
  }

  // Spotlight: absolutely-positioned div over the target rect with a
  // giant box-shadow that blacks out everything outside it.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="tour-card-title"
      className="fixed inset-0 z-[9500] pointer-events-none"
    >
      {/* Click-catcher absorbs clicks so the underlying app isn't
       * accidentally interacted with mid-tour. */}
      <div
        className="absolute inset-0 pointer-events-auto"
        onClick={(e) => e.stopPropagation()}
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
            boxShadow: "0 0 0 9999px rgba(4, 7, 12, 0.78)",
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
        <div className="mt-4 flex flex-wrap items-center gap-1">
          {visibleSteps.map((_, i) => (
            <span
              key={i}
              className="h-1 w-3 rounded-full transition-colors"
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
