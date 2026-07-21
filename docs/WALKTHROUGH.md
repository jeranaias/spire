# SPIRE walkthrough - screen recording script

A shot-by-shot map for recording a full pass through the application.
Target length 12-14 minutes. Everything below is drivable in a single
identity (MajGen Hayes) - role switching is its own segment rather than a
constant tax on the recording.

Companion docs: [BUG_BASH.md](BUG_BASH.md) has per-scenario expected states if
you want to verify a surface before you roll; [SYNC_DESIGN.md](SYNC_DESIGN.md)
covers what to say about GC-2.

---

## Preflight (do not record this)

1. `docker compose up -d --build`, then open <http://localhost:8080>.
   For a dev run: `uvicorn backend.main:app --port 8700` plus
   `cd frontend && npm run dev`.
2. Confirm the dataset is loaded: `curl -s localhost:8700/api/system/status`
   should report a non-zero `assets` count and `audit_chain_intact: true`.
3. Decide the basemap posture before you roll - `/api/system/map-config`
   tells you which of the three you will get on camera:
   - `offline` - a pack is installed, everything is same-origin. Best.
   - `online` - the public style. Fine for a laptop demo; say so if asked.
   - `none` - the explicit no-pack banner. Only record this deliberately.
4. Browser at 1920x1080, zoom 100%, bookmarks bar hidden, notifications off.
   The TopBar spine is designed for >=1440; below that chips start collapsing.
5. Clear the onboarding modal once per identity (it is per-DODID in
   localStorage) so the 4-screen intro does not open mid-take.
6. Have the classification banner in frame. It reads
   `UNCLASSIFIED // SYNTHETIC DATA // FOR DEMONSTRATION ONLY` and it is the
   first thing a reviewer looks for.

---

## Segment 1 - Sign in and the shape of the thing (0:00-1:30)

**Screen:** `/#/auth` cert-selection splash.

- Show the cert list. Four CAC identities, each with issuer, masked DODID,
  and expiry - the fields a real reader surfaces.
- Pick **MajGen Robert Hayes** (`4567890123`), PIN `123456`.
- Land on the **Decision Bridge** (the index route).

**Say:** SPIRE authenticates against a CAC. This build runs the mock reader
with four synthetic identities; the production path is the same code with
`SPIRE_AUTH_MODE=cac` and a DoD PKI trust bundle.

**Show on the Decision Bridge:** the mission strap, open alerts, projected
shortages, MC% by unit, audit health. Point out that every tile is computed
from the ingested dataset, not live telemetry - the snapshot date is in the
tile title attribute.

---

## Segment 2 - SENTRY: sanitization and release (1:30-4:30)

Press `g` `s`, or click SENTRY in the TopBar.

| Tab | What to show | What to say |
|---|---|---|
| Upload | Drop a GCSS-MC export CSV | The sanitization gate runs before anything is stored |
| Processing | Per-field classification, aggregation matrix | Auto-tagging against DoDM 5200.01; the matrix is clickable |
| Review Queue | Filter chips, `A` approve / `R` reject, arrow keys to move | A human clears every flagged record. Keyboard-first because that is how a queue actually gets worked |
| Mark Draft | Paste text, get portion marks | Bulk CSV path exists for a batch |
| Export | Manifest preview, then the ZIP | The export is custodian-gated; a denied export is audited |
| Coalition | Partner picker, release profile | Release-to-partner is a different decision than classify |

Worth pausing on: **Reveal sensitive (audit logged)**. Toggle it, then note
that the reveal itself wrote an audit row. That is the posture in one gesture.

---

## Segment 3 - PULSE: readiness and forecasting (4:30-7:30)

Press `g` `p`.

1. **Overview** - fleet MC% by unit. Establish the baseline picture.
2. **Risk** - the Risk Board, then the **Predicted Failures** panel. Say
   plainly whether the model is loaded or the rule-based fallback is running
   (the footer chips tell you; do not narrate a model that is not there).
3. **Cannib** - find a cannibalization match. Propose one. Point out the
   proposal writes `cannibalization_propose` to the audit chain, and that the
   route fails the request if the audit write fails.
4. **Forecast** - pick a unit, walk the projection, then **Recommend
   Actions**. This is GC-1: the system proposes the replenishment, the
   operator decides.
5. **Model** - provenance for whatever is loaded. Reviewers ask.

---

## Segment 4 - BASTION: the common operating picture (7:30-10:30)

Press `g` `b`.

- Let the map settle. Three islands - Okinawa Honto, Miyako, Ishigaki -
  with MIL-STD-2525D markers rendered client-side by milsymbol.
- Zoom out to theater scale and back in. Call out that symbol size is
  zoom-aware, which is why it stays readable at both ends.
- Drag a marker. Then **Reset to Seed**. Drag history is persisted.
- Click a marker: the drawer shows the unit summary, and deep-links into
  PULSE forecast and the risk board for that unit.
- Threat rings: DF-21D at 1500 km, YJ-12 at 400 km, centered on Taipei.
- Alert sidebar: acknowledge one. Cross-tenant write attempts are blocked
  and audited - mention it, do not stage it.
- **If you are recording the offline pack:** open DevTools' network tab
  first and show that every tile request is same-origin. That single shot is
  the whole WI-1 argument.

---

## Segment 5 - SPIRO and the degraded-comms story (10:30-12:00)

**Ctrl + /** opens SPIRO on the right edge.

Ask it something that exercises a tool, not a chat completion:

- "What's the readiness picture for 3d Maintenance Battalion?"
- "Fly to Miyako and show me what's within 50 km of the ECP."

Then the part that matters at a contested-logistics event: open the
**Comms** chip in the TopBar and step down CONNECTED -> LIMITED ->
INTERMITTENT -> DISCONNECTED, or press the 60-second DDIL drill and let it
run under narration.

**Say:** the LLM tiering degrades with the link. Tier A is a hosted model and
is off by default. Tier B is a local model on the box. Tier C is deterministic
intent routing that always answers. Writes queue while disconnected and replay
on reconnect - the queue depth is on the chip.

Then show the **EGRESS** chip in the footer. `enforced` means the watchdog
denies unapproved outbound connections rather than merely recording them.

---

## Segment 6 - Admin, audit, and the honesty segment (12:00-14:00)

Press `g` `a`.

1. **Audit** - the chain. Show `verify_chain` reporting intact, the entry
   count, and the head hash. Explain the two layers: a SHA-256 hash chain,
   plus Ed25519 signatures on high-value entries. An attacker with full DB
   write access can recompute the chain; they cannot re-sign it.
2. **Ingest** and **Ingest Mapper** - how a new source gets adapted.
3. **Channels** - the notification wiring.
4. **System status chip** -> **Open drawer**. Show the vector clocks and the
   conflict resolution flow (**Seed Demo Conflict** if you need one on
   camera). The **SIMULATED PEER** chip is showing, and you should say why:
   the vector-clock math is real, the peer is in-process, multi-node
   replication is the next step. Assessors reward being told this. They
   punish finding it themselves.

Close on the footer: EGRESS, ENCRYPTION, DATASET, INTEGRITY, LLM tier, and
the two model chips. It is the posture of the whole system in one strip.

---

## Optional segments

- **Role switching** - sign out, come back as GySgt Reyes (G-4) or CWO3 Park
  (Security Manager) and show the same route rendering a different scope, or
  an out-of-scope overlay. Good for a review audience, dead weight for a
  capability pitch.
- **Feedback drawer** - `g` `f`. Pre-fills role, view, severity, screenshot.
  Local-only unless a GitHub token is configured, and under the event profile
  a token is a boot failure.
- **Help overlay** - `?`. Every shortcut in one card.

---

## Things not to say on camera

- Do not call GC-2 "consensus". It is CRDT-style reconciliation.
- Do not claim IL5, an ATO, or FIPS validation. The defensible line is:
  TRL 4 prototype, 800-171 Rev. 3 remediation tracked internally,
  architecture compatible with IL5 hosting targets, FIPS-safe algorithms
  with a FIPS-ready image variant.
- Do not narrate a model as "online" when the footer says rule-based
  fallback.
- The dataset is synthetic. Say it once, early, and let the banner carry it
  from there.
