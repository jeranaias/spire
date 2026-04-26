/**
 * Onboarding — first-run welcome + per-role 3-step tour.
 *
 * Triggered when localStorage.spire.onboarding.v1 is unset.
 *
 * Three slides (skip-able at any point, persisted to localStorage):
 *   1. What SPIRE is — what an operator does with it, in 4 lines
 *   2. Your role + what you do here — role-shaped landing surface
 *   3. The three things you should know — `?` for help, Shift+F for
 *      feedback, ask SPIRO anytime via Ctrl+/
 *
 * Re-runnable via TopBar `?` overlay → "Show me the tour again" (handled
 * by exposing the modal via a flag on the Zustand store).
 */
import { useEffect, useState } from "react";
import { useSpireStore, ROLE_LABELS, type Role } from "../state/store";

const SEEN_KEY = "spire.onboarding.v1.seen";

// Role-specific copy for slide 2 — what THIS role does on landing.
const ROLE_BRIEF: Record<Role, { lands_on: string; first_action: string; second_action: string; third_action: string }> = {
  maintenance_chief: {
    lands_on: "PULSE Risk Board, scoped to your unit (CLB-6)",
    first_action: "Review the top-risk assets — SPIRE pre-ranks by deadline urgency.",
    second_action: "Click 'Draft Action' on a deadlined asset to find a cannib donor.",
    third_action: "Approve recommendations one click; everything writes to the audit chain.",
  },
  g4: {
    lands_on: "BASTION command summary — your three subordinate units at a glance",
    first_action: "Glance the unit MC% panel and fused-threat correlations.",
    second_action: "Drill into PULSE Forecast for Monte Carlo readiness projections.",
    third_action: "Approve replenishment actions ranked by impact-per-dollar-per-day.",
  },
  mef_commander: {
    lands_on: "BASTION — full Common Operating Picture across all 10 units",
    first_action: "Watch the ThermalHawk + PACS + SCADA fusion stream for cross-sensor threats.",
    second_action: "Toggle AIR-GAP from the TopBar to demonstrate offline-capable operations.",
    third_action: "Switch role anytime to drill into a subordinate's view.",
  },
  data_custodian: {
    lands_on: "SENTRY — the classification + release engine",
    first_action: "Run the canonical batch through the Tier-1 / Tier-2 sanitization pipeline.",
    second_action: "Use Coalition tab to preview what JSDF / AUS / PHL / FVEY partners would see.",
    third_action: "Generate a release package — audit-chained, real ZIP with redacted manifest.",
  },
  security_manager: {
    lands_on: "BASTION + the ADMIN tab (telemetry, audit chain integrity)",
    first_action: "Verify the audit chain SHA-256 fingerprint matches across nodes.",
    second_action: "Resolve any pending vector-clock conflicts (Node Status chip in TopBar).",
    third_action: "Watch SENTRY's classification flywheel — operator decisions feed model retraining.",
  },
};

export function Onboarding() {
  const role = useSpireStore((s) => s.role);
  const [open, setOpen] = useState<boolean>(false);
  const [step, setStep] = useState<0 | 1 | 2>(0);

  useEffect(() => {
    try {
      if (!localStorage.getItem(SEEN_KEY)) {
        // Defer 700ms after mount so the chrome paints first; modal feels
        // welcoming, not interruptive.
        const t = setTimeout(() => setOpen(true), 700);
        return () => clearTimeout(t);
      }
    } catch {}
  }, []);

  function dismiss() {
    setOpen(false);
    try { localStorage.setItem(SEEN_KEY, "1"); } catch {}
  }

  function next() {
    if (step < 2) setStep((s) => (s + 1) as 0 | 1 | 2);
    else dismiss();
  }

  function prev() {
    if (step > 0) setStep((s) => (s - 1) as 0 | 1 | 2);
  }

  if (!open) return null;

  const brief = ROLE_BRIEF[role];

  return (
    <div
      className="fixed inset-0 z-[9100] flex items-center justify-center bg-black/70 backdrop-blur-md"
      onClick={dismiss}
      role="presentation"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="m-4 flex w-full max-w-[40rem] flex-col gap-4 rounded-md border border-[var(--color-primary)] bg-[var(--color-surface)] p-6 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="spire-onboarding-title"
      >
        {/* Step indicator */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-1 w-8 rounded-full transition-colors"
                style={{ background: i <= step ? "var(--color-primary)" : "var(--color-border)" }}
                aria-label={`Step ${i + 1} of 3`}
              />
            ))}
            <span className="ml-2 font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
              Step {step + 1} of 3
            </span>
          </div>
          <button
            onClick={dismiss}
            className="font-mono text-xs uppercase text-[var(--color-text-muted)] hover:text-[var(--color-text)] tracking-widest"
            aria-label="Skip onboarding"
          >
            Skip
          </button>
        </div>

        {step === 0 && (
          <>
            <div>
              <div className="font-mono text-xs uppercase text-[var(--color-primary)] tracking-widest">
                Welcome to SPIRE
              </div>
              <h2 id="spire-onboarding-title" className="mt-1 font-sans text-2xl font-semibold text-[var(--color-text)] tracking-tight">
                Contested Logistics Operating System
              </h2>
            </div>
            <p className="text-sm leading-relaxed text-[var(--color-text-secondary)]">
              SPIRE is a single screen for the things that take a Marine a dozen tabs and three phone calls today.
              See unit readiness, find a cannib donor, draft a TMR, mark CUI, watch the gate cameras. One laptop.
              Works without internet. Built by Marines, on duty time.
            </p>
            <div className="rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] p-3">
              <div className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
                What you can do here
              </div>
              <ul className="mt-2 space-y-1 font-mono text-xs text-[var(--color-text-secondary)] tracking-wide">
                <li>· See your unit's readiness, by asset, in real time</li>
                <li>· Forecast where readiness is heading 7-30 days out</li>
                <li>· Find a cannibalization donor, draft the TMR, send it</li>
                <li>· Mark a record CUI / NOFORN / coalition-releasable</li>
                <li>· Watch base sensors (gate, perimeter, drone) on one map</li>
              </ul>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <div>
              <div className="font-mono text-xs uppercase text-[var(--color-primary)] tracking-widest">
                Your role
              </div>
              <h2 className="mt-1 font-sans text-xl font-semibold text-[var(--color-text)] tracking-tight">
                {ROLE_LABELS[role]}
              </h2>
              <p className="mt-2 font-mono text-xs text-[var(--color-text-muted)] tracking-wide">
                Lands on: <span className="text-[var(--color-text)]">{brief.lands_on}</span>
              </p>
            </div>
            <div className="rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] p-4">
              <div className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest mb-3">
                Your first three actions
              </div>
              <ol className="space-y-2 text-sm text-[var(--color-text-secondary)]">
                <li className="flex gap-3">
                  <span className="font-mono text-xs font-semibold text-[var(--color-primary)] tracking-widest mt-0.5">01</span>
                  <span>{brief.first_action}</span>
                </li>
                <li className="flex gap-3">
                  <span className="font-mono text-xs font-semibold text-[var(--color-primary)] tracking-widest mt-0.5">02</span>
                  <span>{brief.second_action}</span>
                </li>
                <li className="flex gap-3">
                  <span className="font-mono text-xs font-semibold text-[var(--color-primary)] tracking-widest mt-0.5">03</span>
                  <span>{brief.third_action}</span>
                </li>
              </ol>
            </div>
            <p className="text-xs italic text-[var(--color-text-muted)]">
              Switch role anytime via the dropdown in the top-right. Out-of-scope views render an
              "Out of Scope" overlay — SPIRE enforces role-based access at the UI and API layers.
            </p>
          </>
        )}

        {step === 2 && (
          <>
            <div>
              <div className="font-mono text-xs uppercase text-[var(--color-primary)] tracking-widest">
                Three things to remember
              </div>
              <h2 className="mt-1 font-sans text-xl font-semibold text-[var(--color-text)] tracking-tight">
                You don't have to learn the menus
              </h2>
            </div>
            <div className="space-y-3">
              <div className="flex gap-3 rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] p-3">
                <div className="flex h-9 w-12 shrink-0 items-center justify-center rounded-sm border border-[var(--color-primary)] bg-[var(--color-surface)] font-mono text-xs font-semibold text-[var(--color-primary)] tracking-widest">
                  ◆ Spiro
                </div>
                <div className="flex-1">
                  <div className="font-mono text-xs uppercase text-[var(--color-text)] tracking-widest">Ask SPIRO anytime · Ctrl+/</div>
                  <div className="mt-0.5 font-mono text-xs text-[var(--color-text-muted)]">
                    Type what you want in plain English. SPIRO plans, you approve.
                    <span className="ml-1 text-[var(--color-text-secondary)]">"find a cannib donor for M21670-MTVR_CARGO-006"</span>
                  </div>
                </div>
              </div>
              <div className="flex gap-3 rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] p-3">
                <kbd className="flex h-9 w-12 shrink-0 items-center justify-center rounded-sm border border-[var(--color-border-active)] bg-[var(--color-surface)] font-mono text-base font-semibold text-[var(--color-text)]">
                  ?
                </kbd>
                <div className="flex-1">
                  <div className="font-mono text-xs uppercase text-[var(--color-text)] tracking-widest">Press ? for keyboard reference</div>
                  <div className="mt-0.5 font-mono text-xs text-[var(--color-text-muted)]">
                    Shortcuts, role scope, capabilities. Press anywhere outside an input.
                  </div>
                </div>
              </div>
              <div className="flex gap-3 rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] p-3">
                <div className="flex h-9 w-12 shrink-0 items-center justify-center rounded-sm border border-[var(--color-border-active)] bg-[var(--color-surface)] font-mono text-xs font-semibold text-[var(--color-text)] tracking-widest">
                  ⇧F
                </div>
                <div className="flex-1">
                  <div className="font-mono text-xs uppercase text-[var(--color-text)] tracking-widest">Shift+F to file feedback</div>
                  <div className="mt-0.5 font-mono text-xs text-[var(--color-text-muted)]">
                    Defect, idea, question, or praise — auto-attaches diagnostics + lands as a GitHub issue.
                  </div>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Footer nav */}
        <div className="mt-2 flex items-center justify-between border-t border-[var(--color-border)] pt-4">
          <button
            onClick={prev}
            disabled={step === 0}
            className="rounded-sm border border-[var(--color-border-active)] px-4 py-2 font-mono text-xs uppercase tracking-widest text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-30"
          >
            Back
          </button>
          <button
            onClick={next}
            className="rounded-sm border border-[var(--color-primary)] bg-[var(--color-primary)] px-6 py-2 font-mono text-xs font-semibold uppercase text-white tracking-widest hover:bg-[var(--color-primary-hover)]"
          >
            {step === 2 ? "Get started" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
