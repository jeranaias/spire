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
      // Honest holdout claim. Numbers are reproducible from
      // `scripts/pulse_baseline_eval.py` and the live `/api/pulse/model-card`
      // (`holdout_mae` block). Update both this line AND PitchVisual.tsx
      // when the trained-weights swap lands and the score moves.
      "Holdout MAE 0.177 vs FY24 G-4 SOP heuristic 0.114 on 2026-03-04 → 2026-04-26 (n=352, 95% CI bootstrap, seed=42) — rule-based fallback under-performs SOP today; trained-weights swap is the unlock.",
      "No model is shipped without a security_manager-signed lifecycle record.",
    ],
    visual: "model-card",
    targetSeconds: 60,
    speakerNotes: [
      "If the judge is technical: open the model card live — point at the holdout-MAE row, the FY24 SOP baseline, and the seed=42 bootstrap CI. Then the training window and the features list. Don't dodge that the rule-based fallback currently loses on MAE — the calibration penalty on hedged probabilistic predictions is a known mode, the trained-weights swap is the planned win.",
      "If the judge is not technical: lead with 'every prediction has a paper trail' — auditability over algorithms — then add 'we publish the score even when we lose; the SOP baseline beats our rule-based fallback today, and that's the bar we have to clear before we ship the trained model'.",
      "Reproducibility script: `scripts/pulse_baseline_eval.py`. Numbers also live in the live model card at `/admin/models/pulse-risk-scorer` (and the in-PULSE summary at `/api/pulse/model-card → holdout_mae`). If the judge asks 'where did 0.177 come from', open the script, then open the model card.",
      "Do NOT round or improve the numbers verbally on stage. The point is they are real and reproducible, not that they are flattering.",
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
      "Spillage block demonstrated end-to-end: low-clearance login → SECRET export attempt → gate fires + audit row, live on request.",
    ],
    visual: "lock-shield",
    targetSeconds: 60,
    speakerNotes: [
      "If asked about ATO: 'we are pre-ATO; the IL-5 target is the destination, not the claim.'",
      "Offer to show the audit ledger live if pressed. It is reachable from /admin/audit.",
      "Live spillage drill is now wired end-to-end: invite the judge to drive it. Sign out, pick LCpl Avery Tran (UNCLASSIFIED records clerk, CLB-Det) at the cert splash, go to SENTRY → Export, hit Build bundle. The 403 + InsufficientClearance toast is the gate firing; switch to /admin/audit and the matching 'spillage_prevented' row is at the top of the ledger. Then quick-switch back to GySgt Reyes so the rest of the demo runs from the operator persona.",
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
