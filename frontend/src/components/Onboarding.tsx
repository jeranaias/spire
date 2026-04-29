/**
 * Onboarding — judge-facing 60-second intro.
 *
 * Replaces the prior feature-walkthrough overlay (wrong audience: that one
 * spoke to a Marine learning the menus). This one lands the warfighter
 * customer, the contested-fight problem, and the four views, then drops the
 * judge into the hero dashboard ready to drill.
 *
 * Four screens, ≤60s total:
 *   1. "Logistics or loss"  — H+72 contested-fight problem
 *   2. "Your customer"      — names the warfighter unit + billet (from the
 *                             signed-in identity, since judges sign in as a
 *                             specific Marine to demo)
 *   3. "Four views, one OS" — BASTION / PULSE / SENTRY / ADMIN one-liners
 *   4. "You're signed in as ..." — drops into the hero dashboard with a
 *                                  role-appropriate next action
 *
 * Auto-advances every 12s but tap-through is faster. Skippable from screen 1.
 *
 * Per-identity "don't show again" preference is persisted to the backend
 * (DODID-keyed, see `/api/system/prefs/onboarding-intro`) so a re-sign-in
 * remembers. A localStorage cache mirrors the server pref for instant first-
 * paint without an extra round-trip on every mount.
 *
 * Re-launchable: any component (e.g. HelpOverlay's "Replay intro") can
 * dispatch `window.dispatchEvent(new CustomEvent("spire:replay-intro"))`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSpireStore, type Role, type User } from "../state/store";
import { api } from "../api";
import { Button, Pressable } from "./ui";

const SCREEN_DURATION_MS = 12_000;
const TOTAL_SCREENS = 4;

// localStorage cache of the server pref. Mirrors the backend value so a
// re-sign-in skips the modal without waiting on /prefs/onboarding-intro.
// Key includes DODID so identity changes flip behavior correctly.
function lsKey(dodid: string): string {
  return `spire.onboarding.intro.seen.${dodid}`;
}
function loadSeenCache(dodid: string): boolean {
  try {
    return window.localStorage.getItem(lsKey(dodid)) === "1";
  } catch {
    return false;
  }
}
function saveSeenCache(dodid: string, seen: boolean): void {
  try {
    if (seen) window.localStorage.setItem(lsKey(dodid), "1");
    else window.localStorage.removeItem(lsKey(dodid));
  } catch {
    /* private mode tolerant */
  }
}

// "Here's your day" copy keyed by role. One-line CTA pointing at the surface
// the role lands on by default. Cut-line: anything more is screen 2 of a
// tutorial, not a 60-second intro.
const ROLE_NEXT_ACTION: Record<Role, { surface: string; action: string }> = {
  maintenance_chief: {
    surface: "PULSE Risk Board",
    action: "review the deadlined assets and approve a cannibalization donor.",
  },
  g4: {
    surface: "BASTION command summary",
    action: "glance unit MC% and drill into the day's top fused-threat correlation.",
  },
  mef_commander: {
    surface: "BASTION Common Operating Picture",
    action: "watch the multi-source fusion stream across all 10 units.",
  },
  data_custodian: {
    surface: "SENTRY Upload",
    action: "process the canonical batch and preview a coalition release package.",
  },
  security_manager: {
    surface: "BASTION + ADMIN",
    action: "verify the audit chain and resolve any pending vector-clock conflicts.",
  },
};

// Display label = rank + last name when we have rank, otherwise full name.
// Falls back to a generic placeholder if currentUser is somehow null
// (defensive — App.tsx normally only renders Onboarding while signed in).
function judgeIdentity(user: User | null): string {
  if (!user) return "Operator";
  if (user.rank && user.last_name) return `${user.rank} ${user.last_name}`;
  return user.name || "Operator";
}

export function Onboarding() {
  const currentUser = useSpireStore((s) => s.currentUser);
  const role = useSpireStore((s) => s.role);

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  // Tracked so the progress bar can animate per-screen; reset whenever
  // step changes or the operator manually advances.
  const [stepStartedAt, setStepStartedAt] = useState<number>(() => Date.now());
  // Explicit "don't show on next sign-in" preference. Default to true so the
  // typical flow (judge watches once, then it never bothers them again) is
  // a single click. Unchecking persists "show again" so a re-sign-in pops
  // the intro fresh — useful for cohort demos with multiple judges sharing
  // a Marine identity.
  const [dontShowAgain, setDontShowAgain] = useState(true);
  // Mirror into a ref so the dismiss callback (and any setTimeout that
  // captures it) always reads the freshest value, even if React batches a
  // late checkbox toggle with the click that triggered dismissal. Without
  // this the auto-dismiss path on screen 4 was occasionally persisting the
  // pre-toggle value when the click + timer fired close together.
  const dontShowAgainRef = useRef(dontShowAgain);
  useEffect(() => {
    dontShowAgainRef.current = dontShowAgain;
  }, [dontShowAgain]);

  const dodid = currentUser?.dodid ?? null;

  // First-mount: decide whether to show. We always reconcile against the
  // server because that's the source of truth — the cache only exists to
  // avoid a flash-of-modal when the server confirms "already seen".
  //
  //   server seen=true  → cache=true, never show
  //   server seen=false → cache=false, show (cache miss case, OR cache said
  //                       true but server has been reset/changed)
  //   server unreachable, no cache → show (judge experience first)
  //   server unreachable, cache=true → trust cache, don't show
  //
  // This matters because the "Don't show again" pref is per-identity and
  // can be cleared (e.g. another tab unchecking it). We reconcile on every
  // mount so the intro behavior matches the server.
  useEffect(() => {
    if (!dodid) {
      setOpen(false);
      return;
    }
    let cancelled = false;
    const cached = loadSeenCache(dodid);
    api.system.getOnboardingIntroSeen().then(
      (r) => {
        if (cancelled) return;
        saveSeenCache(dodid, r.seen);
        if (!r.seen) {
          setStep(0);
          setStepStartedAt(Date.now());
          setDontShowAgain(true);
          setOpen(true);
        }
      },
      () => {
        if (cancelled) return;
        // Server unreachable — fall back to the cache. If we've never seen
        // this identity before (no cache entry), show the intro so the
        // judge experience isn't sacrificed to a transient backend blip.
        if (!cached) {
          setStep(0);
          setStepStartedAt(Date.now());
          setDontShowAgain(true);
          setOpen(true);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [dodid]);

  // Re-launch hook for the help menu / any other surface.
  useEffect(() => {
    function onReplay() {
      setStep(0);
      setStepStartedAt(Date.now());
      // On replay we default the checkbox back to "don't show again" so the
      // judge's repeat watch doesn't accidentally re-enable the prompt.
      setDontShowAgain(true);
      setOpen(true);
    }
    window.addEventListener("spire:replay-intro", onReplay);
    return () => window.removeEventListener("spire:replay-intro", onReplay);
  }, []);

  // Persist (or clear) the per-identity "seen" pref according to the
  // operator's explicit checkbox state. seen=true → don't show again.
  // seen=false → show on every sign-in until they opt out. The local cache
  // is kept in sync so the next mount paints correctly without a round-trip.
  const persistSeen = useCallback(
    (seen: boolean) => {
      if (!dodid) return;
      saveSeenCache(dodid, seen);
      api.system.setOnboardingIntroSeen(seen).catch(() => {
        /* tolerant — cache holds for the current tab */
      });
    },
    [dodid],
  );

  const dismiss = useCallback(() => {
    setOpen(false);
    persistSeen(dontShowAgainRef.current);
  }, [persistSeen]);

  const advance = useCallback(() => {
    setStep((prev) => {
      if (prev >= TOTAL_SCREENS - 1) return prev;
      setStepStartedAt(Date.now());
      return prev + 1;
    });
  }, []);

  // Auto-advance timer — 12s per screen, including the last one. The last
  // screen auto-DISMISSES (instead of advancing) so the intro obeys the
  // 60-second hard cap — judges who walk away mid-demo still land on the
  // dashboard. Whatever the checkbox says at that moment is persisted.
  useEffect(() => {
    if (!open) return;
    if (step < TOTAL_SCREENS - 1) {
      const t = window.setTimeout(advance, SCREEN_DURATION_MS);
      return () => window.clearTimeout(t);
    }
    const t = window.setTimeout(dismiss, SCREEN_DURATION_MS);
    return () => window.clearTimeout(t);
  }, [open, step, advance, dismiss, stepStartedAt]);

  // Esc closes from any screen.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        dismiss();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, dismiss]);

  // Lock body scroll while open so wheel/touch gestures don't yank the
  // underlying view.
  useEffect(() => {
    if (!open) return;
    const prior = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prior;
    };
  }, [open]);

  if (!open) return null;

  const isLast = step === TOTAL_SCREENS - 1;

  return (
    <div
      className="fixed inset-0 z-[9100] flex items-center justify-center bg-black/75 backdrop-blur-md"
      onClick={dismiss}
      role="presentation"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="m-4 flex w-full max-w-[42rem] flex-col gap-5 rounded-md border border-[var(--color-primary)] bg-[var(--color-surface)] p-6 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="spire-intro-title"
      >
        <ProgressHeader
          step={step}
          stepStartedAt={stepStartedAt}
          totalDurationMs={SCREEN_DURATION_MS}
          onSkip={dismiss}
        />

        {step === 0 && <ScreenLogisticsOrLoss />}
        {step === 1 && <ScreenYourCustomer user={currentUser} />}
        {step === 2 && <ScreenFourViews />}
        {step === 3 && <ScreenSignedIn user={currentUser} role={role} />}

        <Footer
          step={step}
          isLast={isLast}
          dontShowAgain={dontShowAgain}
          onToggleDontShowAgain={(v) => setDontShowAgain(v)}
          onBack={() => {
            if (step > 0) {
              setStep((s) => s - 1);
              setStepStartedAt(Date.now());
            }
          }}
          onNext={() => {
            if (isLast) dismiss();
            else advance();
          }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header — segmented progress bar with per-screen 12s fill animation
// ---------------------------------------------------------------------------

function ProgressHeader({
  step,
  stepStartedAt,
  totalDurationMs,
  onSkip,
}: {
  step: number;
  stepStartedAt: number;
  totalDurationMs: number;
  onSkip: () => void;
}) {
  // Drives the per-segment fill via inline width transitions. We snapshot
  // 'now' once per step change so the CSS transition runs the full 12s
  // without restarting on every parent re-render.
  const fillRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = fillRef.current;
    if (!el) return;
    // Reset to 0 instantly, then transition to 100%. Two RAFs so the
    // browser commits the 0% style before applying the transition.
    el.style.transition = "none";
    el.style.width = "0%";
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!fillRef.current) return;
        fillRef.current.style.transition = `width ${totalDurationMs}ms linear`;
        fillRef.current.style.width = "100%";
      });
    });
  }, [step, stepStartedAt, totalDurationMs]);

  return (
    <div className="flex items-center justify-between">
      <div className="flex flex-1 items-center gap-2">
        {Array.from({ length: TOTAL_SCREENS }).map((_, i) => {
          const isActive = i === step;
          const isPast = i < step;
          return (
            <div
              key={i}
              className="relative h-1 flex-1 overflow-hidden rounded-full"
              style={{ background: "var(--color-border)" }}
              aria-label={`Screen ${i + 1} of ${TOTAL_SCREENS}`}
            >
              {isPast && (
                <div
                  className="absolute inset-0 rounded-full"
                  style={{ background: "var(--color-primary)" }}
                />
              )}
              {isActive && (
                <div
                  ref={fillRef}
                  className="absolute inset-y-0 left-0 rounded-full"
                  style={{ background: "var(--color-primary)", width: "0%" }}
                />
              )}
            </div>
          );
        })}
        <span className="ml-3 shrink-0 font-mono text-xs uppercase tracking-widest text-[var(--color-text-muted)]">
          {String(step + 1).padStart(2, "0")} / {String(TOTAL_SCREENS).padStart(2, "0")}
        </span>
      </div>
      <Pressable
        onClick={onSkip}
        block={false}
        aria-label="Skip intro"
        className="!min-h-0 ml-4 shrink-0 font-mono text-xs uppercase tracking-widest text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
      >
        Skip
      </Pressable>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Footer — back / next
// ---------------------------------------------------------------------------

function Footer({
  step,
  isLast,
  dontShowAgain,
  onToggleDontShowAgain,
  onBack,
  onNext,
}: {
  step: number;
  isLast: boolean;
  dontShowAgain: boolean;
  onToggleDontShowAgain: (next: boolean) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <div className="mt-1 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-border)] pt-4">
      <div className="flex items-center gap-3">
        <Button
          onClick={onBack}
          disabled={step === 0}
          variant="secondary"
          size="sm"
        >
          Back
        </Button>
        {/* Explicit per-identity preference — defaults to ON so the typical
         * judge flow is a single watch then never bothers them again.
         * Visible from any screen (not just the last) so the operator can
         * decide on their first interaction. The current value is committed
         * on dismiss / completion via persistSeen(). */}
        <label
          className="inline-flex cursor-pointer items-center gap-2 select-none font-mono text-[11px] uppercase tracking-widest text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
          title="Persist this choice for this identity (DODID-keyed, server-side)"
        >
          <input
            type="checkbox"
            checked={dontShowAgain}
            onChange={(e) => onToggleDontShowAgain(e.target.checked)}
            className="h-3.5 w-3.5 cursor-pointer accent-[var(--color-primary)]"
            aria-label="Don't show this intro on next sign-in"
          />
          Don&apos;t show on next sign-in
        </label>
      </div>
      <Button
        onClick={onNext}
        autoFocus
        variant="primary"
        size="md"
      >
        {isLast ? "Drop into dashboard" : "Next"}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-mono text-xs uppercase tracking-widest text-[var(--color-primary)]">
      {children}
    </div>
  );
}

function ScreenLogisticsOrLoss() {
  return (
    <section className="flex flex-col gap-4">
      <div>
        <Eyebrow>Why SPIRE exists</Eyebrow>
        <h2
          id="spire-intro-title"
          className="mt-1 font-sans text-2xl font-semibold tracking-tight text-[var(--color-text)]"
        >
          In a contested fight, logistics is the fight.
        </h2>
      </div>
      <p className="text-sm leading-relaxed text-[var(--color-text-secondary)]">
        Inside the first 72 hours of a Pacific contingency, the side that
        moves fuel, parts, blood, and ammo wins. The side that doesn&apos;t,
        loses — regardless of how many platforms it owns.
      </p>
      <div className="rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] p-4">
        <div className="font-mono text-xs uppercase tracking-widest text-[var(--color-text-muted)]">
          Today&apos;s reality
        </div>
        <ul className="mt-2 space-y-1.5 text-sm text-[var(--color-text-secondary)]">
          <li>
            <span className="text-[var(--color-text)]">A dozen tabs</span>,
            three phone calls, and a spreadsheet to find one cannibalization donor.
          </li>
          <li>
            <span className="text-[var(--color-text)]">SATCOM denial</span>{" "}
            blacks out half the tools the moment a peer adversary jams.
          </li>
          <li>
            <span className="text-[var(--color-text)]">Cloud-only AI</span>{" "}
            doesn&apos;t survive the first hop into a contested theater.
          </li>
        </ul>
      </div>
      <p className="text-sm leading-relaxed text-[var(--color-text-secondary)]">
        SPIRE is one local-first operating surface for the contested logistics
        fight. One laptop. Works without internet. Built for the Marine doing
        the work, not the headquarters watching from a wall display.
      </p>
    </section>
  );
}

function ScreenYourCustomer({ user }: { user: User | null }) {
  const unit = user?.unit ?? "CLB-6";
  const parent = user?.parent_command ?? "2d MLG";
  const billet = user?.billet ?? "Logistics Operator";
  return (
    <section className="flex flex-col gap-4">
      <div>
        <Eyebrow>Who SPIRE is for</Eyebrow>
        <h2 className="mt-1 font-sans text-2xl font-semibold tracking-tight text-[var(--color-text)]">
          The {billet} at {unit}, not the slide deck.
        </h2>
      </div>
      <p className="text-sm leading-relaxed text-[var(--color-text-secondary)]">
        SPIRE&apos;s customer is the Marine on shift — the maintenance chief
        chasing a deadlined MTVR, the data custodian releasing intel to a
        coalition partner, the watch officer correlating a perimeter alert at
        0230. Every screen is built around the decision they need to make in
        the next ten minutes.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] p-3">
          <div className="font-mono text-xs uppercase tracking-widest text-[var(--color-text-muted)]">
            Customer unit
          </div>
          <div className="mt-1 font-sans text-base font-semibold text-[var(--color-text)]">
            {unit}
          </div>
          <div className="mt-0.5 font-mono text-[11px] uppercase tracking-widest text-[var(--color-text-secondary)]">
            {parent}
          </div>
        </div>
        <div className="rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] p-3">
          <div className="font-mono text-xs uppercase tracking-widest text-[var(--color-text-muted)]">
            Customer billet
          </div>
          <div className="mt-1 font-sans text-base font-semibold text-[var(--color-text)]">
            {billet}
          </div>
          <div className="mt-0.5 font-mono text-[11px] uppercase tracking-widest text-[var(--color-text-secondary)]">
            On the deck, not the deck brief
          </div>
        </div>
      </div>
      <p className="text-xs italic text-[var(--color-text-muted)]">
        Built by Marines, on duty time. Tested against real workflows, not
        synthetic personas.
      </p>
    </section>
  );
}

function ScreenFourViews() {
  const views: Array<{ key: string; tag: string; one_liner: string }> = [
    {
      key: "BASTION",
      tag: "Common Operating Picture",
      one_liner: "Live unit readiness, fused sensors, alerts — the wall display in your hand.",
    },
    {
      key: "PULSE",
      tag: "Predictive Logistics",
      one_liner: "Risk Board, forecasts, cannib donors — what fails next and what to do about it.",
    },
    {
      key: "SENTRY",
      tag: "Classification & Release",
      one_liner: "Auto-mark CUI/NOFORN, preview coalition releases, generate audit-chained packages.",
    },
    {
      key: "ADMIN",
      tag: "Audit & Telemetry",
      one_liner: "Hash-chained audit, telemetry, secure-wipe — the integrity surface for the SOC.",
    },
  ];
  return (
    <section className="flex flex-col gap-4">
      <div>
        <Eyebrow>What SPIRE is</Eyebrow>
        <h2 className="mt-1 font-sans text-2xl font-semibold tracking-tight text-[var(--color-text)]">
          Four views, one operating system.
        </h2>
      </div>
      <p className="text-sm leading-relaxed text-[var(--color-text-secondary)]">
        SPIRE is not four products bolted together. It&apos;s one local
        operating surface with four scoped views — the same data, the same
        identity, the same audit chain — shaped to the decision each role
        owns.
      </p>
      <ul className="grid grid-cols-1 gap-2">
        {views.map((v) => (
          <li
            key={v.key}
            className="flex gap-3 rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] p-3"
          >
            <div className="flex h-9 w-20 shrink-0 items-center justify-center rounded-sm border border-[var(--color-primary)] bg-[var(--color-surface)] font-mono text-xs font-semibold uppercase tracking-widest text-[var(--color-primary)]">
              {v.key}
            </div>
            <div className="flex-1">
              <div className="font-mono text-xs uppercase tracking-widest text-[var(--color-text)]">
                {v.tag}
              </div>
              <div className="mt-0.5 text-sm text-[var(--color-text-secondary)]">
                {v.one_liner}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ScreenSignedIn({ user, role }: { user: User | null; role: Role }) {
  const next = ROLE_NEXT_ACTION[role];
  const identity = judgeIdentity(user);
  const unit = user?.unit ?? "CLB-6";
  return (
    <section className="flex flex-col gap-4">
      <div>
        <Eyebrow>You&apos;re signed in as</Eyebrow>
        <h2 className="mt-1 font-sans text-2xl font-semibold tracking-tight text-[var(--color-text)]">
          {identity} · {unit}
        </h2>
      </div>
      <div className="rounded-sm border border-[var(--color-primary)] bg-[var(--color-bg)] p-4">
        <div className="font-mono text-xs uppercase tracking-widest text-[var(--color-text-muted)]">
          Here&apos;s your day
        </div>
        <p className="mt-2 text-sm leading-relaxed text-[var(--color-text)]">
          You&apos;ll land on{" "}
          <span className="font-semibold text-[var(--color-primary)]">
            {next.surface}
          </span>
          . First action: {next.action}
        </p>
      </div>
      <ul className="space-y-1 font-mono text-[11px] uppercase tracking-widest text-[var(--color-text-muted)]">
        <li>
          · Switch identity from the top-right at any time
        </li>
        <li>
          · Press <span className="text-[var(--color-text)]">?</span> for the help and shortcut reference
        </li>
        <li>
          · Press <span className="text-[var(--color-text)]">Ctrl + /</span> to ask SPIRO in plain English
        </li>
      </ul>
    </section>
  );
}
