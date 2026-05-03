/**
 * HelpOverlay — keyboard shortcut + role/scope reference card.
 *
 * Press `?` to open from anywhere in the app. Closes on Esc or click-out.
 * The CWO + SSgts use this to remember the keyboard nav we wired into the
 * Review Queue, the air-gap toggle, and so on. Updated whenever a new
 * shortcut lands.
 */
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useSpireStore, ROLE_LABELS, VIEW_SCOPE } from "../state/store";
import { DemoOnly } from "../state/buildMode";
import { IconButton, Pressable } from "./ui";

const SHORTCUTS = [
  { keys: ["?"],          label: "Open this help" },
  { keys: ["Esc"],         label: "Close any modal" },
  { keys: ["/"],           label: "Focus alert search (BASTION)" },
  { keys: ["Ctrl", "/"], label: "Toggle SPIRO copilot" },
  { keys: ["g", "f"], label: "Open feedback drawer" },
  // Vimium-style chord nav. Mirrors the App-level useGoToShortcuts hook;
  // routes the active role can't see fall back to that role's default
  // landing surface so the shortcut never throws an InsufficientPrivilege.
  { keys: ["g", "s"],     label: "Go to SENTRY" },
  { keys: ["g", "p"],     label: "Go to PULSE" },
  { keys: ["g", "b"],     label: "Go to BASTION" },
  { keys: ["g", "a"],     label: "Go to ADMIN (Security Manager only)" },
  { keys: ["A"],           label: "Approve flagged record (Review Queue)" },
  { keys: ["R"],           label: "Reject flagged record (Review Queue)" },
  { keys: ["↑", "↓"],     label: "Navigate flagged records (Review Queue)" },
  { keys: ["+", "-"],     label: "Zoom map (BASTION)" },
  { keys: ["0"],           label: "Reset view (BASTION)" },
  { keys: ["←", "→", "↑", "↓"], label: "Pan map (BASTION)" },
];

// Demo-only shortcut. Failsafe is the panic-button behind /demo and
// /pitch routes (presenter-only) — surface in the help overlay only
// for the demo build so pilots don't see a shortcut they can't use.
const DEMO_KEYBINDS: ReadonlyArray<{ keys: string[]; label: string }> = [
  { keys: ["F9"], label: "Failsafe — recorded backup (presenter only, /demo & /pitch)" },
];

export function HelpOverlay() {
  const role = useSpireStore((s) => s.role);
  const nav = useNavigate();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const inField =
        e.target instanceof HTMLInputElement
        || e.target instanceof HTMLTextAreaElement
        || (e.target instanceof HTMLElement && e.target.isContentEditable);

      // "?" is a regular character produced by Shift+/ on US keyboards.
      // If the operator is typing, they get to type "?". Only open the
      // help modal when no input has focus. (Previously "always opens"
      // meant typing "?" inside the SPIRO prompt yanked the help modal —
      // worse than not having a shortcut at all.)
      if (!inField && (e.key === "?" || (e.shiftKey && e.key === "/"))) {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }

      // Walkthrough audit: Escape always closes when open. The prior
      // !inField guard meant Escape did nothing if the operator had
      // focused the SPIRO textarea before opening Help.
      if (e.key === "Escape" && open) {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Lock body scroll while open so wheel/touch gestures don't slip past
  // the modal and yank the underlying view. Restored on unmount/close.
  useEffect(() => {
    if (!open) return;
    const prior = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prior;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[8900] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={() => setOpen(false)}
    >
      <div
        className="m-4 max-h-[85vh] w-[44rem] overflow-y-auto rounded-md border border-[var(--color-primary)] bg-[var(--color-surface)] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-baseline justify-between">
          <div>
            <div
              className="font-mono text-xs uppercase text-[var(--color-primary)] tracking-widest"
            >
              SPIRE · Help & Reference
            </div>
            <div className="mt-1 font-mono text-lg font-semibold text-[var(--color-text)] tracking-wide">
              Keyboard shortcuts + role scope
            </div>
          </div>
          <IconButton onClick={() => setOpen(false)} aria-label="Close help" variant="ghost" size="sm">
            <span aria-hidden>✕</span>
          </IconButton>
        </div>

        <div className="grid grid-cols-2 gap-6">
          <section>
            <div
              className="mb-2 font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest"
            >
              Shortcuts
            </div>
            <ul className="flex flex-col gap-1.5">
              {SHORTCUTS.map((s, i) => (
                <li key={i} className="flex items-center justify-between">
                  <div className="flex items-center gap-1">
                    {s.keys.map((k, j) => (
                      <kbd
                        key={j}
                        className="rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] px-1.5 py-[1px] font-mono text-xs text-[var(--color-text)] tracking-wide"
                      >
                        {k}
                      </kbd>
                    ))}
                  </div>
                  <span className="font-mono text-sm text-[var(--color-text-secondary)]">
                    {s.label}
                  </span>
                </li>
              ))}
              <DemoOnly>
                {DEMO_KEYBINDS.map((s, i) => (
                  <li key={`demo-${i}`} className="flex items-center justify-between">
                    <div className="flex items-center gap-1">
                      {s.keys.map((k, j) => (
                        <kbd
                          key={j}
                          className="rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] px-1.5 py-[1px] font-mono text-xs text-[var(--color-text)] tracking-wide"
                        >
                          {k}
                        </kbd>
                      ))}
                    </div>
                    <span className="font-mono text-sm text-[var(--color-text-secondary)]">
                      {s.label}
                    </span>
                  </li>
                ))}
              </DemoOnly>
            </ul>
          </section>

          <section>
            <div
              className="mb-2 font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest"
            >
              Your role · {ROLE_LABELS[role]}
            </div>
            <div className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-3 font-mono text-sm">
              <div className="mb-2 text-[var(--color-text-secondary)]">In scope:</div>
              <ul className="flex flex-col gap-0.5">
                {Object.entries(VIEW_SCOPE).map(([view, roles]) => {
                  const inScope = roles.includes(role);
                  return (
                    <li key={view} className="flex items-center gap-2">
                      <span className={inScope ? "text-[var(--color-success)]" : "text-[var(--color-text-muted)]"}>
                        {inScope ? "✓" : "—"}
                      </span>
                      <span className={inScope ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}>
                        {view.toUpperCase().replace("/", "")}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>

          </section>
        </div>

        {/* Integrations · system-of-record adapter contracts. Surfaced
         * in Help so a judge asking "where does this live?" can find
         * the GCSS-MC contract page without learning the URL. */}
        <section className="mt-5 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
          <div className="mb-2 font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
            Integrations · System of record
          </div>
          <ul className="flex flex-col gap-1.5">
            <li className="flex items-center justify-between gap-3">
              <div className="flex flex-col">
                <span className="font-mono text-sm text-[var(--color-text)]">GCSS-MC</span>
                <span className="font-mono text-[10px] text-[var(--color-text-muted)] tracking-wider uppercase">
                  Marine Corps logistics SoR · adapter contract
                </span>
              </div>
              <Pressable
                onClick={() => {
                  setOpen(false);
                  nav("/integrations/gcss-mc");
                }}
                block={false}
                title="Open the GCSS-MC adapter contract page"
                className="!min-h-0 shrink-0 rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] px-3 py-1.5 font-mono text-xs uppercase tracking-widest text-[var(--color-text-secondary)] hover:border-[var(--color-primary)] hover:text-[var(--color-text)]"
              >
                Open contract
              </Pressable>
            </li>
          </ul>
        </section>

        <div className="mt-5 flex items-center justify-between gap-3 border-t border-[var(--color-border)] pt-3 font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
          <span>
            File issues with the floating button bottom-right (or press g then f) ·
            See SPIRE_INSTALL.md + CONTRIBUTING.md in the repo root for setup ·{" "}
            <Link
              to="/about/team"
              onClick={() => setOpen(false)}
              className="text-[var(--color-primary)] underline-offset-2 hover:underline"
            >
              Warfighter customer & team →
            </Link>
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <Link
              to="/about/transition"
              onClick={() => setOpen(false)}
              title="SBIR Phase II → MTA-Rapid Prototyping pathway, IP, sustainment, fielding plan, risks"
              className="rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] px-3 py-1.5 font-mono text-xs uppercase tracking-widest text-[var(--color-text-secondary)] hover:border-[var(--color-primary)] hover:text-[var(--color-text)]"
            >
              Transition pathway
            </Link>
            <Pressable
              onClick={() => {
                setOpen(false);
                window.dispatchEvent(new CustomEvent("spire:replay-intro"));
              }}
              block={false}
              title="Re-run the 60-second SPIRE intro"
              className="!min-h-0 rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] px-3 py-1.5 font-mono text-xs uppercase tracking-widest text-[var(--color-text-secondary)] hover:border-[var(--color-primary)] hover:text-[var(--color-text)]"
            >
              Replay intro
            </Pressable>
          </div>
        </div>
      </div>
    </div>
  );
}
