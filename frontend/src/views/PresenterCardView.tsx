/**
 * PresenterCardView — `/presenter`.
 *
 * One-page "stage cheat sheet" for the on-stage presenter. Lists the
 * four-tile beat sheet (8-minute walk), the keyboard hotkeys / click
 * targets that drive the run, the four CAC identities used for the
 * quick-switch handoff, and the cold-open SIMULATE THERMALHAWK trigger.
 *
 * Hidden in normal operator mode: when `stageMode === false` the route
 * navigates back to the Decision Bridge ('/'). The intended entry path
 * is `/?stage=1#/presenter` — the stage hydrator in main.tsx flips the
 * store to stageMode before the route mounts, so a fresh load lands on
 * the card with the chrome already in stage configuration.
 *
 * Pure-content surface: no live polling, no role gate inside the view
 * (the route is itself stage-only, which already constrains who reaches
 * it under normal use).
 */
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useSpireStore } from "../state/store";

interface BeatSpec {
  number: string;
  minutes: string;
  title: string;
  subtitle: string;
  talking: string;
  cue: string;
  hotkey: string[];
  click: string;
  route: string;
}

// 8-minute beat sheet. Order matches the WP-2 stage-tile sequence:
// SENTRY (UC 14) → PULSE (UC 13) → BASTION (UC 15) → DHA RESCUE (UC 4),
// closed by the AUDIT reveal. The minute budget is the host's target;
// drift is fine, the cumulative cap is 8:00.
const BEATS: BeatSpec[] = [
  {
    number: "14",
    minutes: "0:00 – 1:30",
    title: "SENTRY",
    subtitle: "CUI auto-tagging — DoDM 5200.01",
    talking:
      "Open on the spillage block — drop an UNCLASSIFIED draft, watch the auto-tag stamp CUI/SECRET, then release with a hash-chained reason. Every export ships its own audit ticket.",
    cue: "Switch to CWO3 Park (security_manager) before this beat — release authority needs the right cert.",
    hotkey: ["g", "s"],
    click: "Tile 14 · SENTRY · CUI Auto-Tagging",
    route: "/sentry",
  },
  {
    number: "13",
    minutes: "1:30 – 3:30",
    title: "PULSE",
    subtitle: "Parts demand forecasting — contested log",
    talking:
      "Walk the MC% gauge into the forecast tab. Show a Class IX shortage 72 h out, then the cannibalization recommendation that prevents the ground stop. The model's reasoning is visible — point at it.",
    cue: "Stay on Park or hop to GySgt Reyes (g4) for the ground-truth scoping view.",
    hotkey: ["g", "p"],
    click: "Tile 13 · PULSE · Parts Demand Forecasting",
    route: "/pulse",
  },
  {
    number: "15",
    minutes: "3:30 – 5:30",
    title: "BASTION",
    subtitle: "Installation COP aggregator",
    talking:
      "Open the COP. Trigger SIMULATE THERMALHAWK to drop a thermal anomaly inside the wire — the alert lights up in seconds, FPCON climbs to CHARLIE, and the gate posture shifts. Detection-to-decision in seconds, not minutes.",
    cue: "Cold-open trigger: BASTION right-rail SIMULATE THERMALHAWK button (or dispatch `spire:simulate-thermalhawk`).",
    hotkey: ["g", "b"],
    click: "Tile 15 · BASTION · Installation COP",
    route: "/bastion",
  },
  {
    number: "4",
    minutes: "5:30 – 7:00",
    title: "DHA RESCUE",
    subtitle: "Blood / Class VIII H+72 — DMO",
    talking:
      "Pivot to the DHA RESCUE surface. Walk the hub-spoke supply graph, the cold-chain holds, and the market-aware sourcing that keeps the H+72 blood promise under INDOPACOM DMO.",
    cue: "Hop to MajGen Hayes (mef_commander) for the commander-eye view of the resupply decision.",
    hotkey: ["g", "d"],
    click: "Tile 4 · DHA RESCUE · Blood / Class VIII H+72",
    route: "/dha-rescue",
  },
  {
    number: "AUDIT",
    minutes: "7:00 – 8:00",
    title: "AUDIT REVEAL",
    subtitle: "Hash-chained, append-only, SOC view",
    talking:
      "Close on the audit chain — every release, every sim, every quick-switch we just did is on the chain with a verifiable hash. One OS · one dataset · one audit chain · four use cases solved.",
    cue: "Click the AUDIT pill in the TopBar StageCluster (right group). Any role can land on /admin/audit while stageMode is on.",
    hotkey: [],
    click: "TopBar · StageCluster · AUDIT pill",
    route: "/admin/audit",
  },
];

interface HotkeySpec {
  keys: string[];
  label: string;
  detail: string;
}

const HOTKEYS: HotkeySpec[] = [
  { keys: ["F9"], label: "Failsafe", detail: "Replace the live demo with the recorded backup. Confirms before activating." },
  { keys: ["Shift", "F8"], label: "Stage reset", detail: "Restore the seed-42 baseline — clears alerts, resets sim, mission clock to H+0." },
  { keys: ["g", "s"], label: "Go to SENTRY", detail: "Vimium-style chord. ~1.5s window between presses." },
  { keys: ["g", "p"], label: "Go to PULSE", detail: "" },
  { keys: ["g", "b"], label: "Go to BASTION", detail: "" },
  { keys: ["g", "d"], label: "Go to DHA RESCUE", detail: "Stage-pivot chord — the fourth hero use case." },
  { keys: ["g", "f"], label: "Open feedback drawer", detail: "Useful for the Q&A — captures audience feedback in-app." },
  { keys: ["?"], label: "Help overlay", detail: "Full shortcut reference + role scope." },
  { keys: ["Esc"], label: "Close any modal", detail: "Including the failsafe overlay." },
];

interface IdentitySpec {
  dodid: string;
  rank: string;
  name: string;
  role: string;
  use: string;
}

// The four CAC identities pre-loaded for the stage. DODIDs from the
// backend test fixtures (test_bastion_authz.py) — the mock backend
// accepts any 6-digit PIN, so quick-switch (no-PIN) is the on-stage
// path for the IdentityChips strip.
const IDENTITIES: IdentitySpec[] = [
  {
    dodid: "1234567890",
    rank: "GySgt",
    name: "Marcus Reyes",
    role: "g4 · operator scope",
    use: "Ground-truth scoping for PULSE — sees CLB-6 only, the perfect contrast to the MEF view.",
  },
  {
    dodid: "2345678901",
    rank: "MSgt",
    name: "Diana Kowalski",
    role: "maintenance_chief",
    use: "Maintenance-chief MC% perspective; same scoping rules as Reyes (CLB-6).",
  },
  {
    dodid: "3456789012",
    rank: "CWO3",
    name: "James Park",
    role: "security_manager · release authority",
    use: "SENTRY release / spillage block — the only role that can stamp CUI / classified release.",
  },
  {
    dodid: "4567890123",
    rank: "MajGen",
    name: "Robert Hayes",
    role: "mef_commander · release authority",
    use: "Commander-eye view for DHA RESCUE and the audit reveal close.",
  },
];

export function PresenterCardView() {
  const stageMode = useSpireStore((s) => s.stageMode);
  const nav = useNavigate();

  // Hidden in normal operator mode. We do this in an effect so React
  // gets a render pass to mount the redirect target; rendering null
  // immediately is safe but avoids a flash of an empty document.
  useEffect(() => {
    if (!stageMode) {
      nav("/", { replace: true });
    }
  }, [stageMode, nav]);

  if (!stageMode) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--color-bg)] p-6">
        <div className="max-w-md rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-5 text-center">
          <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
            Presenter card
          </div>
          <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
            The presenter card is hidden in normal operator mode. Open with
            <span className="mx-1 font-mono text-[var(--color-primary)]">/?stage=1#/presenter</span>
            to enter stage mode and view the card.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-[var(--color-bg)]">
      <div className="mx-auto w-full max-w-5xl p-6 print:p-3">
        <header className="mb-6 border-b border-[var(--color-border)] pb-4">
          <div className="font-mono text-xs uppercase tracking-widest text-[var(--color-primary)]">
            SPIRE · Stage · Presenter card
          </div>
          <h1 className="mt-1 font-sans text-2xl font-semibold tracking-tight text-[var(--color-text)]">
            8-minute walk · four tiles · audit close
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-[var(--color-text-secondary)]">
            One OS · one dataset · one audit chain · four use cases solved. Use
            this card as the single sheet next to the laptop. Each beat lists
            the talking point, the cue to set up before you arrive, and the
            hotkey or tile that drives it.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
            <span>Print-friendly</span>
            <span>·</span>
            <button
              type="button"
              onClick={() => window.print()}
              className="rounded-sm border border-[var(--color-border-active)] bg-[var(--color-surface)] px-2 py-0.5 text-[var(--color-text-secondary)] hover:border-[var(--color-primary)] hover:text-[var(--color-text)] print:hidden"
            >
              Print this card
            </button>
            <span>·</span>
            <span>Open with <span className="text-[var(--color-text-secondary)]">/?stage=1#/presenter</span></span>
          </div>
        </header>

        {/* Beat sheet — the spine of the walk */}
        <section className="mb-8">
          <SectionHeader
            eyebrow="Section 01"
            title="Beat sheet"
            subtitle="Eight minutes, five beats. Each row = one tile + the close."
          />
          <ol className="mt-3 flex flex-col gap-3">
            {BEATS.map((b) => (
              <BeatRow key={b.number + b.title} beat={b} />
            ))}
          </ol>
        </section>

        {/* Hotkeys + Identities — two columns at md+ */}
        <section className="mb-8 grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <SectionHeader
              eyebrow="Section 02"
              title="Stage hotkeys"
              subtitle="Capture-phase bound — beat any view's local handler."
            />
            <ul className="mt-3 flex flex-col gap-1.5">
              {HOTKEYS.map((h, i) => (
                <li
                  key={i}
                  className="flex items-start justify-between gap-3 rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
                >
                  <div className="flex shrink-0 items-center gap-1">
                    {h.keys.map((k, j) => (
                      <kbd
                        key={j}
                        className="rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] px-1.5 py-[1px] font-mono text-xs text-[var(--color-text)]"
                      >
                        {k}
                      </kbd>
                    ))}
                  </div>
                  <div className="min-w-0 flex-1 text-right">
                    <div className="font-mono text-[12px] font-semibold uppercase tracking-wider text-[var(--color-text)]">
                      {h.label}
                    </div>
                    {h.detail && (
                      <div className="text-[11px] leading-snug text-[var(--color-text-secondary)]">
                        {h.detail}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <SectionHeader
              eyebrow="Section 03"
              title="Quick-switch identities"
              subtitle="Tap an IdentityChip in the TopBar — no PIN under stageMode."
            />
            <ul className="mt-3 flex flex-col gap-2">
              {IDENTITIES.map((id) => (
                <li
                  key={id.dodid}
                  className="rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-sans text-sm font-semibold text-[var(--color-text)]">
                        {id.rank} {id.name}
                      </div>
                      <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
                        {id.role}
                      </div>
                    </div>
                    <span className="shrink-0 rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] px-1.5 py-[1px] font-mono text-[11px] tabular-nums text-[var(--color-text-secondary)]">
                      DODID {id.dodid}
                    </span>
                  </div>
                  <p className="mt-1 text-[12px] leading-snug text-[var(--color-text-secondary)]">
                    {id.use}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Cold-open trigger — call out the THERMALHAWK simulate path */}
        <section className="mb-8">
          <SectionHeader
            eyebrow="Section 04"
            title="Cold-open trigger"
            subtitle="If you forget everything else, remember this one."
          />
          <div className="mt-3 rounded-sm border border-[var(--color-warning)] bg-[color-mix(in_oklab,var(--color-warning-muted)_18%,var(--color-surface))] px-4 py-3">
            <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-warning)]">
              SIMULATE THERMALHAWK
            </div>
            <p className="mt-1 text-sm text-[var(--color-text)]">
              Drop a thermal anomaly inside the wire to kick the BASTION beat
              into life. The button lives on the BASTION right-rail; the same
              effect is reachable programmatically by dispatching
              <code className="mx-1 rounded-sm bg-[var(--color-bg)] px-1.5 py-[1px] font-mono text-[12px] text-[var(--color-text-secondary)]">
                window.dispatchEvent(new CustomEvent("spire:simulate-thermalhawk"))
              </code>
              from the dev console as a backstop.
            </p>
            <p className="mt-2 text-[12px] text-[var(--color-text-secondary)]">
              Audience signal: alert tile lights up, FPCON badge climbs to
              CHARLIE, gate posture shifts. Total time from sim to visible
              decision &lt; 5 seconds.
            </p>
          </div>
        </section>

        {/* Audit close — the AUDIT pill */}
        <section className="mb-8">
          <SectionHeader
            eyebrow="Section 05"
            title="Audit close"
            subtitle="The reveal that ties every action you just demoed back to the chain."
          />
          <div className="mt-3 rounded-sm border border-[var(--color-success)] bg-[color-mix(in_oklab,var(--color-success-muted)_18%,var(--color-surface))] px-4 py-3">
            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-[var(--color-success)]">
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: "var(--color-success)", boxShadow: "0 0 6px var(--color-success)" }}
                aria-hidden
              />
              AUDIT pill · TopBar right group
            </div>
            <p className="mt-1 text-sm text-[var(--color-text)]">
              Click the AUDIT pill in the StageCluster (top-right). Lands on
              <span className="mx-1 font-mono text-[var(--color-text-secondary)]">/admin/audit</span>
              — hash-chained, append-only. Any role can land here while the
              session is in stageMode.
            </p>
          </div>
        </section>

        <footer className="border-t border-[var(--color-border)] pt-3 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
          Stage card · MDM 2026 · Hidden when stageMode is off
        </footer>
      </div>
    </div>
  );
}

function BeatRow({ beat }: { beat: BeatSpec }) {
  const nav = useNavigate();
  return (
    <li
      className="grid grid-cols-1 gap-3 rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 md:grid-cols-[6rem_1fr_14rem]"
    >
      <div className="flex flex-col">
        <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
          UC {beat.number}
        </span>
        <span className="font-mono text-sm font-semibold tabular-nums text-[var(--color-text)]">
          {beat.minutes}
        </span>
      </div>
      <div className="min-w-0">
        <div className="font-mono text-base font-semibold uppercase tracking-[0.18em] text-[var(--color-text)]">
          {beat.title}
        </div>
        <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
          {beat.subtitle}
        </div>
        <p className="mt-1 text-[13px] leading-relaxed text-[var(--color-text-secondary)]">
          {beat.talking}
        </p>
        <p className="mt-1 text-[12px] italic leading-snug text-[var(--color-text-muted)]">
          Cue: {beat.cue}
        </p>
      </div>
      <div className="flex flex-col items-start gap-2 md:items-end md:text-right">
        {beat.hotkey.length > 0 ? (
          <div className="flex items-center gap-1">
            {beat.hotkey.map((k, j) => (
              <kbd
                key={j}
                className="rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] px-1.5 py-[1px] font-mono text-xs text-[var(--color-text)]"
              >
                {k}
              </kbd>
            ))}
          </div>
        ) : (
          <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
            No hotkey · click target
          </span>
        )}
        <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
          {beat.click}
        </div>
        <button
          type="button"
          onClick={() => nav(beat.route)}
          className="rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-secondary)] hover:border-[var(--color-primary)] hover:text-[var(--color-text)] print:hidden"
        >
          Open {beat.route} →
        </button>
      </div>
    </li>
  );
}

function SectionHeader({
  eyebrow,
  title,
  subtitle,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
}) {
  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
        {eyebrow}
      </div>
      <h2 className="mt-1 font-sans text-lg font-semibold text-[var(--color-text)]">
        {title}
      </h2>
      <p className="mt-1 max-w-3xl text-[12px] text-[var(--color-text-secondary)]">
        {subtitle}
      </p>
    </div>
  );
}
