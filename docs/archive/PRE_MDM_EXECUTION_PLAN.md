# SPIRE — Pre-MDM Full Execution Plan

**Window:** 25 Apr 2026 → 30 Apr 2026 (judging morning).
**Constraint:** zero spend until execution is exhausted; `/ultrareview` ($35) is the last gate, not the first.
**Stance:** there is no "post-MDM." Every queued finding ships before the laptop walks on stage.

This plan rolls up:
- The 7 review agents we ran today (license, content, lighthouse, persona panel, demo redline, empty-state, scope-leak)
- The 3 functional-test agents (demo walk, mobile, adversarial UX)
- The strategic 5-of-9-use-cases reframe
- The AI co-pilot pivot (Gemma 4 as in-app operator assistant)
- The simplification + onboarding asks (info laning, tutorials, summaries on demand)

---

## Strategy — three things judges remember

1. **"SPIRE solves 5 of the 9 hackathon use cases in one operating system."** Beat 1 of the demo opens with this.
2. **The Marine doesn't navigate; they ask Gemma 4.** AI co-pilot replaces the tutorial.
3. **Defense-grade by every visible signal.** CAPCO banner, 2525C symbology, real classification posture, real tailnet-private inference, hash-chained audit. Every detail a Colonel checks.

---

## Track A — Demo & Pitch (highest pitch leverage, ~1.5 h)

**A1.** Rewrite `docs/DEMO_SCRIPT.md`:
- **Beat 1 cold-open** with the 5-of-9 frame: *"Most teams here picked one of these nine problems. We solve five in one system, with the same data."* Then trigger ThermalHawk before the next sentence.
- Beat 4 number-first reframe (9d to fail / 14d lead time / requisition pre-drafted).
- Beat 8 closer: *"Lattice watches the fight. Gotham watches the adversary. Nobody watches the supply chain. We do."*
- 5 new Q&A boobytraps: human-in-loop on auto-draft, GCSS-MC schema mirror, J2-weights-fail-mode, CRDT-vs-etcd-differentiator, IP-ownership-during-duty-time.
- Update stale labels (DEFECT/ENHANCEMENT not Bug/Idea, JAPAN·JSDF not JPN).

**A2.** Create `docs/USE_CASE_MAPPING.md` — explicit grid of which SPIRE surface satisfies which MDM use case (#2 / #5 / #6 / #7 / #9). One-pager for judges.

---

## Track B — AI Co-Pilot (Gemma 4 in-app, ~6 h)

This is the simplification unlock. Marines stop navigating and start asking.

**B1. Tools registry** (`backend/copilot/tools.py`, ~1.5 h)
- JSON-schema function definitions for: `find_asset`, `find_cannib_match`, `recommend_actions`, `predict_failures`, `submit_tmr`, `coalition_release`, `seed_conflict`, `summarize_view`.
- Each tool wraps an existing endpoint + role-scoped via existing `scoping.py`.

**B2. Planner endpoint** (`backend/routes/copilot.py`, ~1.5 h)
- `POST /api/copilot/plan {text, role, view, current_data}` → Gemma 4 with tools + system prompt → returns structured `{intent, steps, summary_for_operator, confidence}`.
- `POST /api/copilot/execute {plan_id, approve}` → walks step list, audit-logs each, returns aggregated result.
- Hard refusal if any step's tool is out of role scope (server-side gate already exists).

**B3. Co-Pilot panel UI** (`frontend/src/components/CoPilot.tsx`, ~2 h)
- Persistent right-edge panel (collapsible) on every view.
- Single textarea: *"Tell me what you want to do."*
- Gemma's plan shown as numbered steps + 1-sentence operator-readable summary.
- `[Approve]` / `[Cancel]` buttons.
- Result stream below with audit-chain receipt.

**B4. Per-panel ⌥ Summary buttons** (~1 h)
- Tiny icon-button on each major panel header.
- Click → `POST /api/copilot/summarize {panel: "PULSE/forecast", data: {...}}` → Gemma returns 2-sentence plain-English read.
- Cached per session.

**Verification:** type *"Find a cannib donor for the deadlined MTVR M21670-006"* → plan appears → approve → cannib match returned, audit logged.

---

## Track C — UX Polish (mechanical, ~5 h, parallelizable)

**C1.** All 18 empty/loading/error state findings (2 pilot-blockers + 16 minors) — `~2 h`
- ProcessingTab "Initializing… forever" → loading skeleton + error state with retry
- BastionView silent disappear on `cop()` 5xx → toast + reload prompt
- Plus the 16 other surfaces flagged

**C2.** All remaining sub-44px tap targets (#13) — `~1.5 h`
- Filter pills, AIR-GAP toggle, REPORT ISSUE, status indicators, etc.
- Bump to 44px min height with 8px gaps per HIG/WCAG 2.5.5

**C3.** Safari cold-start trap (#14) — `~30 min`
- Frontend retry-with-backoff on BASTION asset 5xx during machine wake.
- Show *"Waking up — one moment"* state instead of indefinite spinner.

**C4.** Demo-script label fixes from FUNC-1 — `~15 min`
- Update DEMO_SCRIPT.md DEFECT/ENHANCEMENT/INQUIRY/ENDORSEMENT, JAPAN·JSDF, etc.

---

## Track D — Performance (Lighthouse top 10, ~3 h)

**D1.** `public/robots.txt` + `public/sitemap.xml` — `~10 min`. Real files instead of SPA fallback.
**D2.** Static hero in `index.html` — `~30 min`. Inline SPIRE logo + tagline so first paint isn't a white screen during 258 KB JS parse.
**D3.** Self-host fonts (`@fontsource/ibm-plex-mono`, `@fontsource/ibm-plex-sans`) — `~30 min`. Kill Google Fonts cross-origin round-trip.
**D4.** Open-Graph meta tags — `~15 min`. Title, description, og:image (use one of the BASTION screenshots).
**D5.** Code-split routes — `~1.5 h`. Lazy-load PULSE charts (recharts is 40-60% of bundle), lazy-load BASTION map. Cuts cold-start from ~3s to ~1s on hotel WiFi.
**D6.** Add `<link rel="modulepreload">` for the JS bundle — `~5 min`.
**D7.** CSP header at Fly's nginx — `~15 min`. Defense-in-depth.

---

## Track E — Design System (foundational, ~3 h)

**E1.** Type scale collapse — `~45 min`
- Define `--text-{xs,sm,base,lg,xl,2xl}` tokens in `index.css` `@theme`.
- Replace 12 ad-hoc font sizes (`text-[8px]` etc.) with tokens.
- 8/9px text upgraded to ≥10px to pass WCAG 2.2 AA contrast at 4.5:1.

**E2.** Letter-spacing token system — `~30 min`
- Define `--tracking-{tight,normal,wide,wider,widest}` (5 values, not 11 ad-hoc).
- Replace inline `style={{letterSpacing:"0.18em"}}` across 40+ sites.

**E3.** Mono → display-sans for hero numerals — `~45 min`
- `MetricCard` heroes switch to IBM Plex Sans 600 with `-2%` tracking.
- Mono stays for data, units, deltas — where it belongs.

**E4.** MIL-STD-2525C affiliation symbology — `~60 min`
- Friendly = blue rectangle (current default).
- Hostile = red diamond (ThermalHawk UAS reticle area).
- Neutral = green square (where applicable in fixture).
- Unknown = yellow quatrefoil (sim wakes).
- Symbology decisive — Marine Colonel reads it natively.

---

## Track F — Onboarding (~2 h)

**F1.** First-run welcome modal (`Onboarding.tsx`, ~1 h)
- Triggered when `localStorage.spire_seen_v1` absent.
- Three slides: "What SPIRE is" / "Pick your role" / "Press `?` for help anytime, Shift+F for feedback, or just ask the co-pilot."
- localStorage flag persists "seen" per role.

**F2.** Per-role 3-step tour (~1 h)
- Role-specific entry points (Maintenance Chief → cannib first; G-4 → forecast first; etc.).
- Re-runnable via TopBar `?` overlay → "Show me the tour again."

**F3.** The AI co-pilot itself reduces tutorial need — covered in Track B.

---

## Track G — Information Laning (~3 h)

The agents flagged BASTION + PULSE as too dense. Three patterns:

**G1.** Default panels per role — `~1.5 h`
- Maintenance Chief lands on PULSE with only their unit + cannib + risk. Hide rest.
- G-4 lands on BASTION with command-summary cards.
- Today: everyone sees everything. Switch to role-shaped defaults.

**G2.** Progressive disclosure — `~1 h`
- Each panel header gets `▾` to collapse to hero + 3 lines.
- State persists per role in localStorage.

**G3.** Density toggle — `~30 min`
- TopBar dropdown: `Dense` (current, staff) / `Sparse` (field, large tap targets, fewer columns).
- Persists per role.

---

## Track H — Free Verification (~3 h)

These are agent runs we haven't done in their best form yet.

**H1.** Reflexion 3-pass loop on screenshots — `~1 h`
- Pass 1: inventory (what's on screen).
- Pass 2: critique against Refactoring UI + Lattice exemplar.
- Pass 3: prioritized punch list with consensus voting (3 panels, ≥2-vote items only).

**H2.** Argos CI install — `~30 min`
- Free GitHub-native visual diff on every PR.
- Catches unintended visual regressions on every push.

**H3.** Demo-rehearsal agent rerun — `~1 h`
- After Tracks A/B/C land, rerun the Playwright demo walk.
- Should achieve full clean PASS this time.

**H4.** Post-everything persona panel rerun (3 panels, named exemplars, consensus voting) — `~30 min`
- Confirm we hit the "wow" bar before judging.

---

## Track I — Money items (gated, end of execution)

Run only after Tracks A–H are exhausted.

| Item | Cost | Trigger |
|---|---|---|
| `/ultrareview` (multi-agent cloud review) | ~$35 | After all Track A–H green |
| Anthropic Computer Use visual review | ~$0.50/screenshot × 20 = $10 | After persona panel rerun if findings remain |
| Sidecar GPU for SENTRY/PULSE torch ML | ~$30/mo | Only if J2 weights actually exist + Jesse wants them live (currently using rule-based fallback per demo script) |

**Total realistic spend if all run: ~$45.** Most likely just `/ultrareview` at $35.

---

## Sequencing — what runs in parallel vs serial

**Foundation first (Track E E1+E2):** type scale + letter-spacing tokens before anything else, so subsequent UI work uses them.

**Then parallel:**
- I do **Track A** (demo script) + **Track B** (co-pilot) — creative + complex, single-author work.
- Spawn agents for **Tracks C / D / G** in parallel — mechanical, agent-friendly.
- I do **Track F** (onboarding) when co-pilot is mostly built so it can reference the co-pilot.

**Then serial:**
- Track H verification — runs after everything ships.
- Track I — only after H green.

---

## Definition of done

A judge clicks `https://spire-mdm.fly.dev` cold on hotel WiFi and within 30 seconds:
1. Sees a CAPCO-spec U-banner load instantly (static hero) — no white screen.
2. Sees BASTION populated with 10 units, 5-of-9-use-cases mapping visible.
3. Types *"submit TMR Lejeune to Cherry Point 5 MTVRs Wednesday"* into the co-pilot bar.
4. Gemma 4 returns a plan in < 3s, clicks Approve, sees the structured TMR + audit chain receipt.
5. Switches role to Maintenance Chief — view re-shapes immediately to their lane.
6. Files a Praise via Shift+F → real GitHub issue with their name in the title — 5 seconds.

If all six work, we're production-ready.

---

## Risk register

| Risk | Mitigation |
|---|---|
| Gemma 4 returns malformed JSON for co-pilot plans | Same fallback pattern as TMR parser — graceful degradation to rule-based intent routing |
| Type-scale rewrite breaks visual hierarchy | Verified against Reflexion 3-pass before pushing |
| Co-pilot tool execution race conditions | Single in-flight plan per session; `[Approve]` button disables during execution |
| Pilot tester confused by co-pilot's plan output | Per-role 3-step tour (Track F2) explicitly walks through one example |
| Last-mile time pressure 30 Apr morning | Track I (`/ultrareview`) is the ONLY gate after Tracks A–H green; can be skipped if time runs out without breaking the demo |

---

## Net commitment

**~24 hours of focused work, $0 spend until the final ultrareview gate.**
