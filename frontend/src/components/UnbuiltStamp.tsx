/**
 * UnbuiltStamp — shared "this surface is a target, not a shipped posture"
 * chrome.
 *
 * Extracted in Task #107 from `IntegrationsView.tsx` so the same CAPCO-style
 * integrity-of-claims chrome can sit on the Model Registry, Model Detail,
 * and Inference Economics surfaces. A 10pt corner chip does not survive a
 * CDAO conference-room projector; these components are sized to remain
 * legible from row 8.
 *
 * Three pieces:
 *   - <UnbuiltBanner sticky headline subline /> — full-width CAPCO bar that
 *     pins above the scroll region of a page.
 *   - <SectionUnbuiltStrip headline subline /> — compact in-section repeat
 *     so a screenshot of a single section can never read as "shipped".
 *   - <PreAtoStamp title? /> — per-card hard "PRE-ATO · NOT ACCREDITED"
 *     badge that can be dropped next to any card title.
 *
 * UNBUILT_BG is exported so callers can reuse the same CAPCO-adjacent
 * burnt-orange when they need to colorize copy ("SPIRE has no ATO") to
 * match the chrome.
 */

// CAPCO-adjacent burnt-orange. Distinct from the SECRET red and the FPCON
// warning amber so it reads as its own integrity stamp and never gets
// mistaken for a classification banner or an alert tone.
export const UNBUILT_BG = "#B8460E";

export function UnbuiltBanner({
  headline,
  subline,
  sticky = false,
}: {
  headline: string;
  subline?: string;
  sticky?: boolean;
}) {
  return (
    <div
      className={
        (sticky ? "sticky top-0 z-20 " : "") +
        "flex h-9 shrink-0 items-center justify-between px-4 py-1 font-mono text-sm font-semibold uppercase tracking-widest"
      }
      style={{ background: UNBUILT_BG, color: "#FFFFFF" }}
      role="region"
      aria-label="Surface integrity-of-claims banner"
    >
      <span className="whitespace-nowrap">{headline}</span>
      {subline && (
        <span
          className="hidden shrink-0 rounded-sm border px-2.5 py-[2px] font-mono text-xs leading-none tracking-widest sm:inline-flex"
          style={{
            borderColor: "rgba(255,255,255,0.55)",
            background: "rgba(0,0,0,0.25)",
          }}
        >
          {subline}
        </span>
      )}
    </div>
  );
}

export function SectionUnbuiltStrip({
  headline,
  subline = "PRE-ATO · NOT ACCREDITED",
}: {
  headline: string;
  subline?: string;
}) {
  return (
    <div
      className="mb-3 flex items-center justify-between gap-3 rounded-sm px-3 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-widest"
      style={{ background: UNBUILT_BG, color: "#FFFFFF" }}
    >
      <span>{headline}</span>
      <span
        className="hidden shrink-0 rounded-sm border px-2 py-[1px] text-[10px] tracking-wider sm:inline-flex"
        style={{ borderColor: "rgba(255,255,255,0.55)", background: "rgba(0,0,0,0.25)" }}
      >
        {subline}
      </span>
    </div>
  );
}

export function PreAtoStamp({
  title = "This card describes a target / planned posture. SPIRE has no ATO.",
}: {
  title?: string;
}) {
  return (
    <div
      className="mb-2 inline-flex items-center gap-2 rounded-sm border-2 px-2 py-[2px] font-mono text-[11px] font-bold uppercase tracking-widest"
      style={{
        borderColor: UNBUILT_BG,
        color: UNBUILT_BG,
        background: "color-mix(in oklab, " + UNBUILT_BG + " 8%, var(--color-surface))",
      }}
      title={title}
    >
      PRE-ATO · NOT ACCREDITED
    </div>
  );
}
