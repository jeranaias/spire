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

const SHORTCUTS = [
  { keys: ["?"],          label: "Open this help" },
  { keys: ["Esc"],         label: "Close any modal" },
  { keys: ["Shift", "F"], label: "Open feedback drawer" },
  { keys: ["A"],           label: "Approve flagged record (Review Queue)" },
  { keys: ["R"],           label: "Reject flagged record (Review Queue)" },
  { keys: ["↑", "↓"],     label: "Navigate flagged records (Review Queue)" },
  { keys: ["+", "-"],     label: "Zoom map (BASTION)" },
  { keys: ["0"],           label: "Reset view (BASTION)" },
  { keys: ["←", "→", "↑", "↓"], label: "Pan map (BASTION)" },
];

export function HelpOverlay() {
  const role = useSpireStore((s) => s.role);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "?" || (e.shiftKey && e.key === "/")) {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
              className="font-mono text-[10px] uppercase text-[var(--color-primary)]"
              style={{ letterSpacing: "0.22em" }}
            >
              SPIRE · Help & Reference
            </div>
            <div className="mt-1 font-mono text-[15px] font-semibold text-[var(--color-text)]" style={{ letterSpacing: "0.04em" }}>
              Keyboard shortcuts + role scope
            </div>
          </div>
          <button
            onClick={() => setOpen(false)}
            className="rounded px-2 py-1 font-mono text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
          >
            ✕
          </button>
        </div>

        <div className="grid grid-cols-2 gap-6">
          <section>
            <div
              className="mb-2 font-mono text-[10px] uppercase text-[var(--color-text-muted)]"
              style={{ letterSpacing: "0.22em" }}
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
                        className="rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] px-1.5 py-[1px] font-mono text-[10px] text-[var(--color-text)]"
                        style={{ letterSpacing: "0.04em" }}
                      >
                        {k}
                      </kbd>
                    ))}
                  </div>
                  <span className="font-mono text-[11px] text-[var(--color-text-secondary)]" style={{ letterSpacing: "0.02em" }}>
                    {s.label}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <div
              className="mb-2 font-mono text-[10px] uppercase text-[var(--color-text-muted)]"
              style={{ letterSpacing: "0.22em" }}
            >
              Your role · {ROLE_LABELS[role]}
            </div>
            <div className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-3 font-mono text-[11px]" style={{ letterSpacing: "0.02em" }}>
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

            <div
              className="mt-4 mb-2 font-mono text-[10px] uppercase text-[var(--color-text-muted)]"
              style={{ letterSpacing: "0.22em" }}
            >
              Game-changers in build
            </div>
            <ul className="flex flex-col gap-0.5 font-mono text-[10px] text-[var(--color-text-secondary)]" style={{ letterSpacing: "0.04em" }}>
              <li>✓ GC-1 Autonomous replenishment (PULSE Forecast)</li>
              <li>✓ GC-5 Coalition mode (SENTRY Coalition)</li>
              <li>✓ GC-7 Air-gap deployment (TopBar toggle)</li>
              <li>✓ Real-map COP (BASTION)</li>
              <li>… GC-3 Predictive failure (in-build, depends on J2 weights)</li>
              <li>… GC-4 C-UAS sensor fusion</li>
              <li>… GC-2 CRDT distributed consensus</li>
              <li>… GC-6 Training data flywheel</li>
            </ul>
          </section>
        </div>

        <div
          className="mt-5 border-t border-[var(--color-border)] pt-3 font-mono text-[10px] text-[var(--color-text-muted)]"
          style={{ letterSpacing: "0.16em" }}
        >
          File issues with the floating button bottom-right (or Shift+F) ·
          See SPIRE_INSTALL.md + CONTRIBUTING.md in the repo root for setup
        </div>
      </div>
    </div>
  );
}
