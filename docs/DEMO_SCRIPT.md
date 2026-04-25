# SPIRE — MDM 2026 Live Demo Script

**Run-time target:** 7 minutes hands-on + 3 minutes Q&A.
**Audience:** MARCORLOGCOM CDAO / HQMC I&L / hackathon judging panel.
**One-line frame:** *"Most teams here picked one of nine problems. We solve five — in one operating system, with one dataset, with the same role scoping, and the same audit chain."*

> Practice this twice end-to-end before walking on stage. The seams that
> bite are usually role switches between live demos.

---

## Pre-demo checklist (2 minutes before stage)

- [ ] Browser pinned to **https://spire-mdm.fly.dev**, page loaded once so
      tiles are warm in cache (CartoDB Dark Matter, ~6MB).
- [ ] Operator role set to **MEF Commander** for the cold-open frame.
- [ ] FPCON banner reads `BRAVO`. AlertBadge < 5.
- [ ] AIR-GAP toggle visible in TopBar but **off** (green COMMS).
- [ ] LLM proxy reachable: `curl https://spire-mdm.fly.dev/api/system/status | jq .llm.reachable` returns `true`.
- [ ] Network tab in DevTools closed. Console clean.
- [ ] Backup video at `~/spire/demo/backup.mp4` — 1-tap fallback if the
      laptop's network falls over at the venue.
- [ ] `docs/USE_CASE_MAPPING.md` printed on a single page in front of the
      laptop — gives judges the 5-of-9 frame at a glance.

---

## Beat 1 · 0:00–0:30 · Cold open — the explosion-first frame

**Pre-stage:** ThermalHawk button visibly armed (cursor hovering it).

**Click:** Simulate ThermalHawk **before you finish the first sentence**.
*(cordons drop, FPCON pill flips BRAVO→CHARLIE, fused-threats card appears)*

**Say while the cordons are still landing:**
> "That just happened on a Marine installation in the last three seconds —
> UAS over a motor pool, correlated with a gate breach ninety seconds old,
> on a laptop, no cloud, no SATCOM required. This is SPIRE."

**Pause one beat.**

> "Most teams here picked one of nine hackathon problems. SPIRE solves
> five of them in one operating system: inventory control, parts demand
> forecasting, CUI auto-tagging, installation common operating picture,
> and natural-language TMR submission. Same dataset, same role scoping,
> same audit chain. I'll show you all five in seven minutes."

**Point at (briefly, while transitioning to Beat 2):**
- Classification banner top: `UNCLASSIFIED // SYNTHETIC DATA // FOR DEMONSTRATION ONLY` — flat-green CAPCO block.
- StatusFooter bottom: `NETWORK 0 egress` ticker. *"This system phones
  no one. Local-first by design."*
- TopBar Node Status chip: `MLG-NODE-0 · NO PEER`.

---

## Beat 2 · 0:30–1:30 · GC-4 fused threats + GC-7 air-gap

**Click:** Simulate ThermalHawk (red button bottom-left of alert sidebar).

**What happens:**
- Map flies to CLB-6 motor pool over 1.2s.
- Three cordon rings drop — red 300m, orange 500m, blue 1000m.
- Target reticle spins on the building.
- FPCON escalates `BRAVO → CHARLIE` for 30s.
- Within ~3s, a **Fused Threats · GC-4** entry appears at the top of
  the alert sidebar correlating the UAS detection with any open PACS
  gate event.

**Say:**
> "ThermalHawk just picked up a UAS over CLB-6 motor pool. Cordons
> drop. Target reticle. FPCON elevates. But here's GC-4: SPIRE just
> correlated this UAS detection with a PACS gate event that's been
> open for ninety seconds. Same actor, two sensors, one threat. The
> response checklist on the right is auto-filtered to my MEF
> Commander summary tier."

**Click:** AIR-GAP toggle (top-right of TopBar).

**What happens:**
- Toggle goes red, ring-pulse halo fires.
- StatusFooter changes from green CONNECTED to red AIRGAP, `Q:0` chip appears.
- Toast: *"Air-gap engaged — local writes will be queued."*

**Say:**
> "Now I just lost SATCOM. GC-7. Every write from here forward queues
> locally. When comms restore, sync replays with vector-clock
> conflict resolution — that's GC-2."

**Click:** AIR-GAP again to release.

> "Comms back. Queue empty, audit chain shows the engage / release
> pair. We never stopped operating."

---

## Beat 3 · 1:30–2:45 · GC-1 autonomous replenishment

**Switch role:** TopBar dropdown → **G-4 (2d MLG)**.

**Auto-routes to** `/bastion`. Click the **PULSE** tab.

**Click:** PULSE → Forecast.

**What's visible:**
- Monte Carlo readiness chart, 30d history + 14d projection, TODAY
  reference line, p10/p90 envelope, 3 summary cards (projected horizon
  end / P-cross-threshold / first-cross date).
- Below the chart: **Recommended Actions · GC-1** panel with 3-5 ranked
  actions.

**Say:**
> "GC-1. PULSE doesn't just tell me my fleet is degrading — it tells
> me what to do about it. Two hundred Monte Carlo paths. Where it
> crosses my readiness floor, here's a ranked list of actions:
> cannibalize, expedite, or cross-level. Each one shows MC delta, cost,
> ETA, and confidence. Sorted by impact-per-dollar-per-day."

**Click:** Approve on the top action.

> "That cannib decision used to take a CWO three hours and a phone tree.
> One click. Audit-logged. Next."

---

## Beat 4 · 2:45–3:45 · GC-3 predictive failure

**Click:** PULSE → Risk Board.

**What's visible:**
- **Predicted Failures · GC-3** panel at the top.
- Each row: top component prediction (e.g. "engine in 9d"), probability
  bar, criticality chip, "Draft Action" button.
- Engine label: `engine: rule_based_v1`.

**Say:**
> "GC-3. This engine fails in 9 days. Part lead time is 14. SPIRE drafted
> the requisition before a human noticed. Rule-based today at 78 percent
> accuracy; J2 weights flip the label to `j2_v1` and the number to 91 —
> same UI, swap the model."

**Click:** Draft Action on a row.

> "Routes me to the Risk Board filtered to that unit so I can pick
> the right replenishment path."

---

## Beat 5 · 3:45–5:00 · GC-5 coalition release

**Switch role:** TopBar → **Data Custodian**. Auto-routes to `/sentry`.

**Click:** SENTRY → Coalition tab.

**What's visible:**
- Profile picker: FVEY · FVEY-LOG · JAPAN · JSDF · AUS · PHL.

**Click:** JAPAN · JSDF.

**What happens within ~1s:**
- Distribution statement updates to *"REL TO JPN per US-JPN MOU."*
- Caveats: REL TO JPN, FOR COALITION EXERCISE.
- Allowed/blocked unit counts repaint with green/red.
- Sample SR records visible with EDIPIs replaced + fault components
  generalized to family.
- Partner units visible: **JGSDF 1st Logistics Brigade**.

**Say:**
> "GC-5. 'Show me what Japan sees right now.' This is the live
> classification-and-release engine reapplying redactions in real
> time, not post-hoc. Every record gets re-tagged to the partner's
> profile. JGSDF First Logistics Brigade now has a logistics COP that
> matches what we have, scoped exactly to what we're cleared to share."

**Click:** Generate Release Package.

> "Audit chain logs the release event. The package is a real ZIP with
> redacted XLSX + signed manifest. Coalition exercise on Tuesday."

---

## Beat 6 · 5:00–5:45 · GC-2 distributed consensus + GC-6 flywheel

**Switch role:** TopBar → **Security Manager**. Auto-routes to `/bastion`.

**Click:** TopBar Node Status chip (`MLG-NODE-0 · NO PEER`).

**Click:** "Seed Demo Conflict" inside the drawer.

**What's visible:** Two vector-clock cards side-by-side, one from local
node, one from peer. Pick buttons let me choose winner. Audit chain
preserves the loser.

**Say:**
> "GC-2. Two SPIRE nodes, partitioned by an adversary EW attack on the
> SATCOM link. Both keep accepting writes. When the link restores,
> CRDT vector-clock reconciliation surfaces conflicts here. Operator
> picks the winner. The loser doesn't disappear — it lives in the
> audit chain so we can argue about it later. Nobody else has this."

**Close** drawer. Click TopBar **ADMIN** tab.

**Say (point at the engine bars):**
> "GC-6. Every recommendation gets scored against outcome. Per-engine
> rolling accuracy, visible here. The pilot cohort makes it smarter
> every month."

---

## Beat 7 · 5:45–6:30 · Pilot loop · file an issue live

**Press:** `Shift+F`.

**What happens:** Drawer slides in bottom-right. Pre-filled with role
(Security Manager) + view (ADMIN). Issue type segmented control
default-selects **DEFECT**.

**Click:** "ENHANCEMENT" in the issue type picker.

**Type into "Submitted by":** `Demo · Judge Walkthrough`

**Type into title:** `Add a fuel-truck filter to the Risk Board`

**Type into body:**
```
When I'm filtering down for class III(B) issues, I want to see only the
fuelers. Right now I scroll the whole list.
```

**Expand** the diagnostics row briefly. *"Notice — auto-attaches role,
view, viewport, browser, FPCON, comms state. Operator never types setup."*

**Click:** Submit.

**What happens:** Toast bottom-right: `Filed · GitHub issue #N · View on GitHub ↗`.

**Click** the link. Browser pops a new tab on the actual issue, with
the title trailing `· Demo · Judge Walkthrough`, labels showing
`type:enhancement`, `pilot-feedback`, `role:security_manager`,
`submitter:demo-judge-walkthrough`.

**Say:**
> "Six seconds. Title, body, submit. The CWO and his SSgts are filing
> ten of these a day. We triage on a bi-weekly cadence — same surface
> as PR review. The loop runs."

---

## Beat 8 · 6:30–7:00 · Close

**Click** ADMIN tab one more time. Show the audit chain row count.

**Say:**
> "Everything you just saw — the cordon, the FPCON change, the cannib
> approval, the coalition release, the conflict resolution, the
> issue filing — every one of those is an event in a SHA-256
> hash-chained audit log. SPIRE doesn't just operate; it remembers,
> in a way you can prove."

**Pause one beat.**

> "Lattice watches the fight. Gotham watches the adversary. **Nobody
> is watching the supply chain. We are.** Five of the nine problems
> on this hackathon's docket, in one operating system, with one
> dataset, on a laptop, no cloud, built by Marines on duty time.
> Questions."

---

## Q&A bullets (likely judge questions)

### Pre-cached from demo-redline agent (5 hostile questions)

1. **"Where's the human-in-the-loop on the auto-drafted requisition? You just told me a model wrote a contract."**
   > "Draft, not submit. Every action requires a CWO approval click. The audit row shows the model proposed it, the human signed it. We never let the model touch the wallet."

2. **"6,332 service requests is synthetic. Why should I believe this works on real DLA / GCSS-MC data?"**
   > "Schema is GCSS-MC mirror — same SR types, same NIINs, same 1348 fields. Synthetic for the unveil; pilot one ingests live read-only feeds in July."

3. **"What happens when the J2 weights are wrong and your 91% becomes 60% in theater?"**
   > "Engine label is on every prediction. Accuracy drops, the flywheel sees it within a week, the system falls back to rule-based automatically. Failure mode is 'as good as today,' not catastrophic."

4. **"You said 'nobody else has this' on CRDT consensus. Etcd, CockroachDB, Riak all have it. Why is yours special?"**
   > "Not the algorithm — the surface. We expose conflict resolution to the *operator* with the loser preserved for legal review. That's a workflow, not a database feature."

5. **"Six weeks of duty time on a government laptop — who owns the IP?"**
   > "Built on personal hardware, off-duty, with command awareness. Government Purpose Rights memo on file. Same posture as the SOFWERX precedents. Pre-existing Thornveil IP (RigRun, HawkStack) is licensed in under LICENSE.md; the SPIRE app itself is government work product."

### Older Q&A bullets (kept for completeness)

- **"How long did this take?"** — Six weeks of evening + duty-time
  iteration. The hackathon window is the public unveil.
- **"What's the model?"** — Gemma 4 26B FP8 on local vLLM via tailnet
  (verified live: `curl /api/system/status | jq .llm.reachable`).
  Rule-based fallback when the proxy is unreachable. Architecture
  model-agnostic.
- **"Path to production?"** — Three pilot rotations through the year,
  then HQMC I&L decides program of record. Architecture is already
  IL5-fit; ATO review starts after pilot one.
- **"Cost?"** — Zero per seat. Local-first means a 2U server in a conex
  serves a battalion. Compare to SaaS-priced competitors at
  $150-400/seat/year.
- **"What about Palantir Gotham / Anduril Lattice?"** — Different
  problem. Those are surveillance. This is logistics. SPIRE is what
  you give the SSgt running cannibalization decisions, not the J2 cell
  watching feeds.

---

## If something breaks live

1. **Map doesn't load** — refresh once. CartoDB tiles are cached after
   first load.
2. **Backend 500s** — `docker compose restart spire-backend`. Takes 6
   seconds. Stay on the slide while it cycles.
3. **Toast doesn't link to GitHub** — token expired. Acknowledge:
   *"that's GC-7 air-gap — feedback queued locally. Will sync after
   demo."* Move on. Don't dig.
4. **Tab won't switch** — refresh; SPA state is hash-routed so URL
   restores cleanly.
5. **Total laptop crash** — switch to backup video. Practice this
   transition. Don't apologize for more than five seconds.
