/**
 * QuickHelpButton — floating "?" pill bottom-right.
 *
 * Operator feedback during pilot: "I keep forgetting how to open help."
 * The `?` keyboard shortcut is great for power users, but new operators
 * scan for a visible button. This is that button — a small, low-noise pill
 * paired visually with the Report-Issue button so the bottom-right corner
 * reads as a "where do I go for help / where do I report a problem" pair.
 *
 * Click → dispatches `?` keydown so HelpOverlay's existing handler toggles
 * open. We re-use the keyboard-handler path instead of bolting on a
 * second open mechanism.
 */
import { startTour } from "./GuidedTour";

export function QuickHelpButton() {
  function openHelp() {
    // Synthetic keydown so HelpOverlay's `?` toggle handler fires. Using
    // an event keeps the open/close state owned by HelpOverlay (single
    // source of truth) instead of forking it into a second store value.
    const ev = new KeyboardEvent("keydown", { key: "?", bubbles: true });
    window.dispatchEvent(ev);
  }

  return (
    <div
      className="pointer-events-none fixed bottom-12 right-[10.5rem] z-[8500] flex items-center gap-2"
      data-tour-id="help-button"
    >
      <button
        onClick={() => startTour()}
        className="pointer-events-auto inline-flex items-center gap-1.5 rounded-sm border border-[var(--color-border-active)] bg-[var(--color-surface)] px-2.5 py-2 font-mono text-xs font-semibold uppercase text-[var(--color-text-secondary)] shadow-lg backdrop-blur transition-colors hover:border-[var(--color-primary)] hover:text-[var(--color-text)] tracking-widest"
        title="Take the guided tour"
        aria-label="Take the guided tour"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M12 2a10 10 0 100 20 10 10 0 000-20zm1 15h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 11 13 11.5 13 13h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41a2 2 0 10-4 0H8a4 4 0 118 0c0 .88-.36 1.68-.93 2.25z" />
        </svg>
        <span>Tour</span>
      </button>
      <button
        onClick={openHelp}
        className="pointer-events-auto inline-flex items-center gap-1.5 rounded-sm border border-[var(--color-border-active)] bg-[var(--color-surface)] px-2.5 py-2 font-mono text-xs font-semibold uppercase text-[var(--color-text-secondary)] shadow-lg backdrop-blur transition-colors hover:border-[var(--color-primary)] hover:text-[var(--color-text)] tracking-widest"
        title="Open help · keyboard shortcuts + FAQ (?)"
        aria-label="Open help"
      >
        <span className="font-mono text-sm leading-none">?</span>
        <span>Help</span>
      </button>
    </div>
  );
}
