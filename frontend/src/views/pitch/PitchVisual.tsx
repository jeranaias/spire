/**
 * PitchVisual — pure SVG visuals for the pitch deck.
 *
 * Each `kind` maps to a stylized icon/diagram. We deliberately avoid
 * embedding screenshots — slide 4 IS the live demo, and judges trust
 * the working tool over a screenshot of the working tool. Visuals here
 * are mood/anchor only; the words on the slide do the heavy lifting.
 *
 * Visuals consume the SPIRE color tokens so they stay on-brand under
 * any density / contrast theme.
 */
import type { VisualKind } from "./slides";

interface Props {
  kind: VisualKind;
}

export function PitchVisual({ kind }: Props) {
  if (kind === "none") return null;
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="aspect-square w-full max-w-[420px]">{render(kind)}</div>
    </div>
  );
}

function render(kind: VisualKind) {
  switch (kind) {
    case "casualty-clock":  return <CasualtyClock />;
    case "unit-icon":       return <UnitIcon />;
    case "demo-hand":       return <DemoHand />;
    case "demo-running":    return <DemoRunning />;
    case "model-card":      return <ModelCard />;
    case "lock-shield":     return <LockShield />;
    case "transition-gantt":return <TransitionGantt />;
    case "ask-bullseye":    return <AskBullseye />;
    default:                return null;
  }
}

// ─── primitives ────────────────────────────────────────────────────────────
const STROKE = "var(--color-border-active)";
const FG     = "var(--color-text)";
const MUTED  = "var(--color-text-muted)";
const ACCENT = "var(--color-primary)";
const WARN   = "var(--color-warning, #d97706)";

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 200 200" className="h-full w-full" role="img" aria-hidden="true">
      <rect x="2" y="2" width="196" height="196" rx="6"
        fill="var(--color-surface)" stroke={STROKE} strokeWidth="1" />
      {children}
    </svg>
  );
}

// ─── 01 · casualty clock — H+72 expiring fuel/parts curve ──────────────────
function CasualtyClock() {
  return (
    <Frame>
      <text x="100" y="32" textAnchor="middle" fontFamily="ui-monospace, monospace"
        fontSize="11" fill={MUTED} letterSpacing="2">H + 72</text>
      <circle cx="100" cy="110" r="62" fill="none" stroke={STROKE} strokeWidth="2" />
      <path d="M 100 110 L 100 50" stroke={ACCENT} strokeWidth="3" strokeLinecap="round" />
      <path d="M 100 110 L 152 138" stroke={WARN} strokeWidth="3" strokeLinecap="round" />
      {[0, 90, 180, 270].map((deg, i) => {
        const r = (deg * Math.PI) / 180;
        const x1 = 100 + Math.cos(r) * 56, y1 = 110 + Math.sin(r) * 56;
        const x2 = 100 + Math.cos(r) * 62, y2 = 110 + Math.sin(r) * 62;
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={FG} strokeWidth="1.5" />;
      })}
      <text x="100" y="190" textAnchor="middle" fontFamily="ui-monospace, monospace"
        fontSize="9" fill={MUTED}>FUEL · PARTS · ROUNDS</text>
    </Frame>
  );
}

// ─── 02 · unit icon — Marine littoral chevrons ─────────────────────────────
function UnitIcon() {
  return (
    <Frame>
      <text x="100" y="30" textAnchor="middle" fontFamily="ui-monospace, monospace"
        fontSize="10" fill={MUTED} letterSpacing="2">3 d M L R · C L B - D E T</text>
      <polygon points="100,55 140,90 100,125 60,90" fill="none" stroke={ACCENT} strokeWidth="2" />
      <polygon points="100,75 124,95 100,115 76,95" fill="none" stroke={FG} strokeWidth="1.5" />
      <line x1="60" y1="145" x2="140" y2="145" stroke={STROKE} strokeWidth="1" />
      <line x1="60" y1="155" x2="140" y2="155" stroke={STROKE} strokeWidth="1" strokeDasharray="3 3" />
      <text x="100" y="180" textAnchor="middle" fontFamily="ui-monospace, monospace"
        fontSize="9" fill={MUTED}>K-Bay · MARFORPAC</text>
    </Frame>
  );
}

// ─── 03 · demo handoff — pointing finger / hand-off arrow ──────────────────
function DemoHand() {
  return (
    <Frame>
      <text x="100" y="32" textAnchor="middle" fontFamily="ui-monospace, monospace"
        fontSize="10" fill={MUTED} letterSpacing="2">SLIDES → TOOL</text>
      <rect x="30" y="80" width="60" height="40" rx="3" fill="none" stroke={STROKE} strokeWidth="1.5" />
      <line x1="40" y1="92" x2="80" y2="92" stroke={MUTED} strokeWidth="1.5" />
      <line x1="40" y1="100" x2="70" y2="100" stroke={MUTED} strokeWidth="1.5" />
      <line x1="40" y1="108" x2="75" y2="108" stroke={MUTED} strokeWidth="1.5" />
      <path d="M 95 100 L 130 100" stroke={ACCENT} strokeWidth="3" strokeLinecap="round" />
      <path d="M 122 92 L 132 100 L 122 108" fill="none" stroke={ACCENT} strokeWidth="3"
        strokeLinecap="round" strokeLinejoin="round" />
      <rect x="135" y="70" width="40" height="60" rx="3" fill="none" stroke={ACCENT} strokeWidth="2" />
      <circle cx="155" cy="100" r="6" fill={ACCENT} />
      <text x="100" y="170" textAnchor="middle" fontFamily="ui-monospace, monospace"
        fontSize="9" fill={MUTED}>contested-fight scenario</text>
    </Frame>
  );
}

// ─── 04 · demo running — pulse marker + "LIVE" badge ───────────────────────
function DemoRunning() {
  return (
    <Frame>
      <rect x="60" y="50" width="80" height="22" rx="3" fill={ACCENT} />
      <text x="100" y="65" textAnchor="middle" fontFamily="ui-monospace, monospace"
        fontSize="11" fontWeight="700" fill="#fff" letterSpacing="3">LIVE</text>
      <circle cx="100" cy="120" r="20" fill="none" stroke={ACCENT} strokeWidth="2" />
      <circle cx="100" cy="120" r="32" fill="none" stroke={ACCENT} strokeWidth="1" opacity="0.5" />
      <circle cx="100" cy="120" r="44" fill="none" stroke={ACCENT} strokeWidth="1" opacity="0.25" />
      <circle cx="100" cy="120" r="6" fill={ACCENT} />
      <text x="100" y="180" textAnchor="middle" fontFamily="ui-monospace, monospace"
        fontSize="9" fill={MUTED}>/demo · ~2:45</text>
    </Frame>
  );
}

// ─── 05 · model card miniature ─────────────────────────────────────────────
function ModelCard() {
  // Holdout-MAE and baseline-diff numbers are reproducible from
  // `scripts/pulse_baseline_eval.py` and the live `/api/pulse/model-card`
  // (`holdout_mae` block). The slide-5 line uses the same values; if the
  // trained-weights swap moves the numbers, update both this visual AND
  // the slides.ts copy in the same change.
  return (
    <Frame>
      <rect x="20" y="30" width="160" height="146" rx="4" fill="var(--color-surface-raised)"
        stroke={STROKE} strokeWidth="1" />
      <text x="30" y="48" fontFamily="ui-monospace, monospace" fontSize="9"
        fill={MUTED} letterSpacing="1.5">MODEL CARD</text>
      <text x="30" y="64" fontFamily="ui-monospace, monospace" fontSize="11"
        fontWeight="700" fill={FG}>PULSE-Risk v0.3</text>
      <line x1="30" y1="72" x2="170" y2="72" stroke={STROKE} strokeWidth="1" />
      {[
        ["features", "14"],
        ["seed", "0xC0FFEE"],
        // Holdout-MAE row: continuous-prediction L1 error on the frozen
        // holdout (2026-03-04 → 2026-04-26, n=352).
        ["holdout MAE", "0.177"],
        // Baseline-diff row: relative MAE vs FY24 G-4 SOP heuristic
        // ("predict NMC iff today's code starts with NMC"). Negative
        // means the rule-based fallback under-performs the baseline.
        ["vs SOP base", "−56%"],
        ["signed by", "sec-mgr"],
      ].map(([k, v], i) => {
        const isDiff = k === "vs SOP base";
        return (
          <g key={i}>
            <text x="30" y={88 + i * 14} fontFamily="ui-monospace, monospace"
              fontSize="9" fill={MUTED}>{k}</text>
            <text x="170" y={88 + i * 14} textAnchor="end"
              fontFamily="ui-monospace, monospace" fontSize="9"
              fontWeight={isDiff ? 700 : 400}
              fill={isDiff ? WARN : FG}>{v}</text>
          </g>
        );
      })}
    </Frame>
  );
}

// ─── 06 · lock + shield ────────────────────────────────────────────────────
function LockShield() {
  return (
    <Frame>
      <path d="M 100 40 L 150 60 L 150 105 Q 150 145 100 165 Q 50 145 50 105 L 50 60 Z"
        fill="none" stroke={ACCENT} strokeWidth="2" />
      <rect x="80" y="100" width="40" height="32" rx="3" fill="none" stroke={FG} strokeWidth="2" />
      <path d="M 87 100 L 87 90 Q 87 78 100 78 Q 113 78 113 90 L 113 100"
        fill="none" stroke={FG} strokeWidth="2" />
      <circle cx="100" cy="115" r="3" fill={FG} />
      <text x="100" y="186" textAnchor="middle" fontFamily="ui-monospace, monospace"
        fontSize="9" fill={MUTED} letterSpacing="2">U / S / TS · CAC · IL-5</text>
    </Frame>
  );
}

// ─── 07 · transition gantt — month bars ────────────────────────────────────
function TransitionGantt() {
  const rows = [
    { label: "SBIR-II", x: 30, w: 50 },
    { label: "MTA-RP",  x: 60, w: 90 },
    { label: "Pilot",   x: 80, w: 70 },
    { label: "Fleet",   x: 130,w: 35 },
  ];
  return (
    <Frame>
      <text x="100" y="30" textAnchor="middle" fontFamily="ui-monospace, monospace"
        fontSize="10" fill={MUTED} letterSpacing="2">12-MONTH PLAN</text>
      {rows.map((r, i) => (
        <g key={r.label}>
          <text x="22" y={62 + i * 22} fontFamily="ui-monospace, monospace"
            fontSize="9" fill={MUTED}>{r.label}</text>
          <rect x={r.x} y={54 + i * 22} width={r.w} height="12" rx="2"
            fill={i === 1 ? ACCENT : "var(--color-surface-raised)"} stroke={STROKE} strokeWidth="1" />
        </g>
      ))}
      <line x1="20" y1="160" x2="180" y2="160" stroke={STROKE} strokeWidth="1" />
      {["M0","M3","M6","M9","M12"].map((m, i) => (
        <text key={m} x={20 + i * 40} y="175" textAnchor="middle"
          fontFamily="ui-monospace, monospace" fontSize="8" fill={MUTED}>{m}</text>
      ))}
    </Frame>
  );
}

// ─── 08 · ask bullseye ─────────────────────────────────────────────────────
function AskBullseye() {
  return (
    <Frame>
      <circle cx="100" cy="100" r="70" fill="none" stroke={STROKE} strokeWidth="1" />
      <circle cx="100" cy="100" r="50" fill="none" stroke={STROKE} strokeWidth="1" />
      <circle cx="100" cy="100" r="30" fill="none" stroke={ACCENT} strokeWidth="2" />
      <circle cx="100" cy="100" r="10" fill={ACCENT} />
      <line x1="40" y1="40" x2="92" y2="92" stroke={FG} strokeWidth="2" />
      <path d="M 40 40 L 52 44 L 44 52 Z" fill={FG} />
      <text x="100" y="186" textAnchor="middle" fontFamily="ui-monospace, monospace"
        fontSize="9" fill={MUTED} letterSpacing="2">PILOT · LOI · TPOC</text>
    </Frame>
  );
}
