/**
 * HelpOverlay — keyboard shortcut + role/scope reference card.
 *
 * Press `?` to open from anywhere in the app. Closes on Esc or click-out.
 * The CWO + SSgts use this to remember the keyboard nav we wired into the
 * Review Queue, the air-gap toggle, and so on. Updated whenever a new
 * shortcut lands.
 */
import { useEffect, useState } from "react";
import { useSpireStore, ROLE_LABELS, VIEW_SCOPE } from "../state/store";
import { AboutFaq } from "./AboutFaq";
import { startTour } from "./GuidedTour";

// Tagged so we can dim chord rows when the seat has shortcuts disabled.
const SHORTCUTS: { keys: string[]; label: string; chord?: boolean }[] = [
  { keys: ["?"],          label: "Open this help" },
  { keys: ["Esc"],         label: "Close any modal" },
  { keys: ["/"],           label: "Focus alert search (BASTION)" },
  { keys: ["Ctrl", "/"], label: "Toggle SPIRO copilot" },
  { keys: ["g", "f"], label: "Open feedback drawer", chord: true },
  // Vimium-style chord nav. Mirrors the App-level useGoToShortcuts hook;
  // routes the active role can't see fall back to that role's default
  // landing surface so the shortcut never throws an InsufficientPrivilege.
  { keys: ["g", "s"],     label: "Go to SENTRY",      chord: true },
  { keys: ["g", "p"],     label: "Go to PULSE",       chord: true },
  { keys: ["g", "b"],     label: "Go to BASTION",     chord: true },
  { keys: ["g", "a"],     label: "Go to ADMIN (Security Manager only)", chord: true },
  { keys: ["A"],           label: "Approve flagged record (Review Queue)" },
  { keys: ["R"],           label: "Reject flagged record (Review Queue)" },
  { keys: ["↑", "↓"],     label: "Navigate flagged records (Review Queue)" },
  { keys: ["+", "-"],     label: "Zoom map (BASTION)" },
  { keys: ["0"],           label: "Reset view (BASTION)" },
  { keys: ["←", "→", "↑", "↓"], label: "Pan map (BASTION)" },
];

export function HelpOverlay() {
  const role = useSpireStore((s) => s.role);
  const shortcutsEnabled = useSpireStore((s) => s.shortcutsEnabled);
  const setShortcutsEnabled = useSpireStore((s) => s.setShortcutsEnabled);
  const [open, setOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);

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
      //
      // The `?` opener is intentionally exempt from `shortcutsEnabled`:
      // even an operator who silenced chord nav still needs a way to
      // discover the toggle, and the toggle lives on the Help overlay.
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
          <button
            onClick={() => setOpen(false)}
            className="rounded px-2 py-1 font-mono text-sm text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
          >
            ✕
          </button>
        </div>

        <div className="grid grid-cols-2 gap-6">
          <section>
            <div
              className="mb-2 font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest"
            >
              Shortcuts
            </div>
            <ul className="flex flex-col gap-1.5">
              {SHORTCUTS.map((s, i) => {
                const dimmed = !!s.chord && !shortcutsEnabled;
                return (
                  <li
                    key={i}
                    className="flex items-center justify-between"
                    style={{ opacity: dimmed ? 0.4 : 1 }}
                    title={dimmed ? "Disabled — re-enable global keyboard chords below" : undefined}
                  >
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
                );
              })}
            </ul>

            {/* Toggle for global keyboard chords. The pilot cohort flagged
             * the original Shift+F shortcut as firing on people typing
             * capital F's mid-sentence (#20–#22). The chord was rebuilt
             * as a vimium-style `g f`, dampened to ignore form-control
             * focus, and now also kill-switchable from this overlay so
             * an operator who never wants chords can just turn them off.
             * The `?` Help opener stays live so the toggle stays
             * discoverable. */}
            <div
              className="mt-4 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5"
              role="group"
              aria-labelledby="spire-shortcut-toggle-label"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div
                    id="spire-shortcut-toggle-label"
                    className="font-mono text-xs font-semibold uppercase text-[var(--color-text)] tracking-widest"
                  >
                    Global keyboard chords
                  </div>
                  <div className="mt-0.5 font-mono text-xs text-[var(--color-text-muted)]">
                    Silences the <kbd className="px-1 text-[10px]">g</kbd>+letter chord nav and the <kbd className="px-1 text-[10px]">g</kbd> <kbd className="px-1 text-[10px]">f</kbd> feedback opener. <kbd className="px-1 text-[10px]">?</kbd> stays live.
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShortcutsEnabled(!shortcutsEnabled)}
                  role="switch"
                  aria-checked={shortcutsEnabled}
                  className="inline-flex h-9 min-w-[5.5rem] items-center justify-center rounded-sm border px-3 font-mono text-xs font-semibold uppercase tracking-widest transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
                  style={{
                    borderColor: shortcutsEnabled ? "var(--color-success)" : "var(--color-border-active)",
                    background: shortcutsEnabled
                      ? "color-mix(in oklab, var(--color-success-muted) 22%, transparent)"
                      : "transparent",
                    color: shortcutsEnabled ? "var(--color-success)" : "var(--color-text-muted)",
                  }}
                >
                  {shortcutsEnabled ? "ON" : "OFF"}
                </button>
              </div>
            </div>
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

        <div
          className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-border)] pt-3 font-mono text-xs text-[var(--color-text-muted)] tracking-wider"
        >
          <span>
            File issues with the floating button bottom-right (or press g then f) ·
            See SPIRE_INSTALL.md + CONTRIBUTING.md in the repo root for setup
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                // Clear the seen flag so the tour treats this as a fresh
                // run, then close help and start. The 120ms gap lets the
                // help modal animation finish before the spotlight cuts
                // in, otherwise the cutout falls under the modal backdrop.
                try { localStorage.removeItem("spire.tour.v1.seen"); } catch { /* tolerant */ }
                setOpen(false);
                window.setTimeout(() => startTour(), 120);
              }}
              className="inline-flex h-9 items-center gap-1.5 rounded-sm border border-[var(--color-border-active)] px-3 font-mono text-xs font-semibold uppercase text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-primary)] hover:text-[var(--color-text)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] tracking-widest"
              title="Walk me through the screen one piece at a time"
            >
              ◎ Take the tour
            </button>
            <button
              type="button"
              onClick={() => setAboutOpen(true)}
              className="inline-flex h-9 items-center gap-1.5 rounded-sm border border-[var(--color-primary)] px-3 font-mono text-xs font-semibold uppercase text-[var(--color-primary)] transition-colors hover:bg-[color-mix(in_oklab,var(--color-primary)_15%,transparent)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] tracking-widest"
            >
              About SPIRE · FAQ →
            </button>
          </div>
        </div>
      </div>
      {aboutOpen && <AboutFaq onClose={() => setAboutOpen(false)} />}
    </div>
  );
}
