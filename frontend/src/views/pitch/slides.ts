/**
 * Pitch deck slide content — single source of truth for the 8-minute
 * Shark-Tank pitch. The presenter tweaks copy here; no string lives in
 * the slide components.
 *
 * Timing budget (480s = 8:00):
 *   1. Hook                              0:30
 *   2. Customer (3d MLR CLB-Det)         0:45
 *   3. Live demo handoff (verbal)        0:30
 *   4. Live demo (driven by /demo)       2:45
 *   5. Tech depth                        1:00
 *   6. Security                          1:00
 *   7. Transition                        1:00
 *   8. Close + ask                       0:30
 *                                        ─────
 *                                        8:00
 *
 * Sanity: TOTAL_BUDGET_SECONDS below MUST equal 480. The PitchView header
 * also derives its "{N}-minute deck" copy from this constant, so the literal
 * and the computed total cannot drift apart on stage.
 *
 * Per the task brief: each slide title, ≤5 supporting points, ≤1 visual,
 * speaker notes. No paragraphs in `points` — keep them scannable from the
 * back row of a TORCH conference room.
 */

export type VisualKind =
  | "none"
  // Stylized SVG/icon visuals rendered by PitchVisual.tsx. We do not
  // embed real screenshots in the deck — slide 4 IS the live demo, and
  // judges trust the working tool over a screenshot of the working tool.
  | "casualty-clock"
  | "unit-icon"
  | "demo-hand"
  | "demo-running"
  | "model-card"
  | "lock-shield"
  | "transition-gantt"
  | "ask-bullseye";

export interface SlideSpec {
  /** Stable identifier — used in URL anchors and analytics if/when wired. */
  id: string;
  /** Slide title — short, hook-forward. */
  title: string;
  /**
   * Optional short eyebrow line above the title (e.g. "Slide 02 · Customer").
   * The slide chrome already shows the slide number; eyebrow is reserved for
   * thematic context (e.g. "[LIVE DEMO]" on slide 4).
   */
  eyebrow?: string;
  /** Up to five supporting points, each ≤ ~12 words. */
  points: string[];
  /** Optional one visual per slide; rendered in the right pane. */
  visual: VisualKind;
  /** Target seconds for this slide; drives the presenter-mode timer pacing badge. */
  targetSeconds: number;
  /** Speaker notes — visible only in presenter mode, hidden for audience. */
  speakerNotes: string[];
  /** When true, this slide has the `/demo` handoff button + return affordance. */
  isDemoHandoff?: boolean;
}

export const SLIDES: SlideSpec[] = [
  {
    id: "hook",
    title: "Logistics or loss: what dies at H+72",
    eyebrow: "Slide 01 · Hook",
    points: [
      "A contested-fight EAB runs out of fight in 72 hours, not 7 days.",
      "Failure mode is logistics, not kinetics — stale parts data, stale fuel curves.",
      "Today the J4 reads four screens to make one decision; SPIRE makes it one.",
      "We are pitching the tool that survives the SATCOM-denial hour of that fight.",
    ],
    visual: "casualty-clock",
    targetSeconds: 30,
    speakerNotes: [
      "Open hot. Don't introduce yourself yet — judges remember the first sentence, not the bio.",
      "The H+72 number is from the 3d MLR CLB-Det wargames, not a generic figure. If asked: 'CG-EAB sustainment study, 2024'.",
      "Cue: I will name the customer next, by unit and billet. Do not preview that here.",
    ],
  },
  {
    id: "customer",
    title: "3d MLR · CLB-Detachment · Kaneohe Bay",
    eyebrow: "Slide 02 · Named customer",
    points: [
      "Unit: 3rd Marine Littoral Regiment, Combat Logistics Battalion Det.",
      "Primary user: Det Maintenance Chief — gunny-grade, the queue owner.",
      "Decision authority: Det OIC + RCT-3 G4 cell at Camp Smith.",
      "Pilot LOI status: engagement open with MCSC LCES PMO, signature pending.",
      "We are not pitching 'the Marine Corps' — we are pitching this unit, this billet.",
    ],
    visual: "unit-icon",
    targetSeconds: 45,
    speakerNotes: [
      "Read the unit name slowly. Specificity is the point — every other pitch in this round will say 'the warfighter'.",
      "If a judge asks about pilot status: 'engagement open, LOI not yet signed — we will not claim a signature we do not have.'",
      "Hand-raise check: who in the room is acquisition? Mention LCES by name only if at least one is.",
    ],
  },
  {
    id: "demo-handoff-verbal",
    title: "I'm going to drive SPIRE through one contested-fight scenario",
    eyebrow: "Slide 03 · Live demo handoff",
    points: [
      "One scenario: SATCOM-denial drill, 0900 → 0930 H+24.",
      "I will narrate; you will see four roles touch the same incident.",
      "Watch for: classification gates, queued writes, model-card provenance.",
      "If anything breaks on stage, I'll switch to the recorded backup — and tell you I did.",
    ],
    visual: "demo-hand",
    targetSeconds: 30,
    speakerNotes: [
      "Take a beat before clicking. The audience needs to switch gears from slides to live tool.",
      "Reset the demo state with the keyboard shortcut BEFORE you click 'Start demo' so the run is identical to rehearsal.",
      "If you stumble during the demo: the failsafe is one keystroke away — do not hide it.",
    ],
  },
  {
    id: "live-demo",
    title: "Live demo · contested-fight scenario",
    eyebrow: "[ LIVE DEMO ]",
    points: [
      "Click 'Start demo' to enter the scripted scenario player.",
      "Driven by lane A1 (`/demo`) — this slide is the launchpad, not the demo itself.",
      "Return to the deck with 'Return to pitch — slide 5' from inside the demo player.",
      "Target run-time: 2:45. Hard stop at 3:15 — pull back to slide 5 manually.",
    ],
    visual: "demo-running",
    targetSeconds: 165,
    isDemoHandoff: true,
    speakerNotes: [
      "Click 'Start demo'. The demo player owns the next ~3 minutes of stage time.",
      "If the demo player has not landed yet (lane A1 in flight), narrate over BASTION manually and skip this slide's button.",
      "Do not narrate while the loading flash hits — wait for the first dashboard tile to settle.",
    ],
  },
  {
    id: "tech-depth",
    title: "Tech depth — what's behind the dashboards",
    eyebrow: "Slide 05 · Tech",
    points: [
      "Forecast: PULSE-Risk v0.3, gradient-boosted on 14 maintenance signals.",
      "Every prediction is reproducible: model card cites training window, features, and seed.",
      "DDIL behavior: read-through cache + queued writes; UI degrades, never lies.",
      "Validation history is open — accuracy claims will be earned on a published holdout, not asserted on stage.",
      "No model is shipped without a security_manager-signed lifecycle record.",
    ],
    visual: "model-card",
    targetSeconds: 60,
    speakerNotes: [
      "If the judge is technical: open the model card live — point at the training window and the features list, not at a percentage.",
      "If the judge is not technical: lead with 'every prediction has a paper trail' — auditability over algorithms.",
      "Do NOT volunteer a holdout-MAE number on stage. We have not yet defined a baseline the Marine Corps would recognize; the honest answer is 'reproducibility first, accuracy claims when the holdout is published'.",
    ],
  },
  {
    id: "security",
    title: "Security posture — auth, audit, classification, hosting",
    eyebrow: "Slide 06 · Security",
    points: [
      "Auth: CAC/PIV cert-bound sessions; HttpOnly cookies, no LocalStorage tokens.",
      "Audit: every approve/dispatch/sign event written to an append-only ledger.",
      "Classification: U/S/TS gates enforced on every export and joint push.",
      "Hosting: IL-5-targeted; FedRAMP High path mapped via shared services.",
      "Spillage block designed end-to-end: clearance gate code + audit-ledger entry shown on request.",
    ],
    visual: "lock-shield",
    targetSeconds: 60,
    speakerNotes: [
      "If asked about ATO: 'we are pre-ATO; the IL-5 target is the destination, not the claim.'",
      "Offer to show the audit ledger live if pressed. It is reachable from /admin/audit.",
      "On the spillage block: today's mock CAC roster carries SECRET / TS//SCI personas only — there is no UNCLASSIFIED CAC seeded yet, so we cannot drive the block from a low-clearance login on stage. If pressed for a live demo, walk the judge through the gate code (auth.py classification check) and show the corresponding 'access_denied' entry in the audit ledger. Do NOT claim the drill was performed end-to-end against a live low-clearance user.",
    ],
  },
  {
    id: "transition",
    title: "Transition — pathway, sustainment, team, IP, 12-mo plan",
    eyebrow: "Slide 07 · Transition",
    points: [
      "Pathway: SBIR Phase II → MTA-Rapid Prototyping (10 USC 4023).",
      "IP: Government Purpose Rights, DFARS 252.227-7013/7014 from day one.",
      "Sustainment: Y1 / Y3 / Y5 cost lines published; assumptions cited.",
      "Team: operator + engineer + acquisition translator (named on /about/team).",
      "12-month plan: pilot at 3d MLR → fleet-wide MARFORPAC by month 12.",
    ],
    visual: "transition-gantt",
    targetSeconds: 60,
    speakerNotes: [
      "If a transition officer is in the room, lead with MTA-RP and pause for them to nod.",
      "Do NOT recite the sustainment numbers — point at the page and say 'every line has an assumption cited'.",
      "The 'fleet-wide by month 12' is the ambitious case; soft-pedal if the judge is risk-averse.",
    ],
  },
  {
    id: "ask",
    title: "Close + ask",
    eyebrow: "Slide 08 · Ask",
    points: [
      "Ask: pilot funding for 3d MLR CLB-Det, 12 months, MTA-RP scaffold.",
      "What we bring: a working tool, a named customer, an acquisition pathway.",
      "What we need: a sponsor signature on the LOI and a TPOC at LCES PMO.",
      "Risk we own: model accuracy under deployment drift — measured, not hand-waved.",
      "Decision logistics. Or loss. Pick one.",
    ],
    visual: "ask-bullseye",
    targetSeconds: 30,
    speakerNotes: [
      "Land the last line clean. Don't soften it with a 'thank you' — let the line breathe.",
      "If they ask 'how much pilot funding': hold the number for the back-channel; do not negotiate on stage.",
      "After the ask, stop talking. The first person to speak loses.",
    ],
  },
];

/** Total deck budget in seconds — sum of `targetSeconds`. Useful for sanity. */
export const TOTAL_BUDGET_SECONDS = SLIDES.reduce((s, x) => s + x.targetSeconds, 0);

/** Index of the slide that hands off to the live demo. */
export const DEMO_HANDOFF_INDEX = SLIDES.findIndex((s) => s.isDemoHandoff);

/** Slide to land on after the live demo finishes. Tech depth follows the demo. */
export const POST_DEMO_INDEX = DEMO_HANDOFF_INDEX + 1;
