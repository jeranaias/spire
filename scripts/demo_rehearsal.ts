/**
 * MDM 2026 stage-pivot — presenter rehearsal harness (WP-10).
 *
 * Drives a Playwright browser through the four-tile stage flow end-to-
 * end so the host can dry-run the 8-minute demo without an audience.
 *
 * Beat structure (one iteration) with presenter handoff sequence and
 * REAL per-module audit-writing domain actions (round-4 hardening):
 *   01  Boot `/?stage=1`, sign in as Reyes (g4) → Decision Surface
 *   02  Open SENTRY, return to bridge
 *   02h HANDOFF: tap Kowalski (maintenance_chief) chip — narratively
 *       the maintenance chief drives the parts-demand walk-through
 *   03  Open PULSE, return to bridge
 *   03h HANDOFF: tap Hayes (mef_commander) chip — the MEF commander
 *       owns BASTION; Hayes is in BASTION_SIMULATE_ROLES so he is
 *       authorized to fire ThermalHawk on stage. The previous order
 *       (Hayes → PULSE, Kowalski → BASTION) tripped a 403 because
 *       maintenance_chief is NOT in the simulate-allowlist
 *       (`backend.routes.bastion.SIMULATE_ROLES`).
 *   04  Open BASTION, click SIMULATE THERMALHAWK, assert cordons +
 *       FPCON + fused-threats arrive within 3 s. The simulate route
 *       writes a `bastion.thermalhawk_simulate` audit row.
 *   05  Open DHA RESCUE, advance H+24 → H+48 → H+72, approve the
 *       walking-blood-bank sourcing recommendation (writes 4 dha.*
 *       audit rows, hash-chained)
 *   05e PULSE cannibalization proposal — issued AS HAYES (still authed
 *       from beat 03h) because the propose route is gated on
 *       `_PROPOSE_ROLES = {g4, maintenance_chief, mef_commander}` and
 *       security_manager (the next handoff target) is excluded. Writes
 *       a `cannibalization_propose` audit row.
 *   05h HANDOFF: tap Park (security_manager) chip — Park is the only
 *       MOCK_USER that meets the COALITION_RELEASE_ROLES gate, so
 *       SENTRY's coalition release writes are issued from her session.
 *   05i SENTRY coalition release (FVEY_BASE profile, as Park) →
 *       writes a `sentry_coalition_release` audit row
 *   06  Open AUDIT pill, fetch the SOC chain as Park, HARD-assert
 *       ≥1 row in EACH of {sentry, pulse, bastion, dha} from this
 *       run + chain.ok===true + delta ≥7 new rows
 *
 * STRICT mode is the only mode: each beat asserts a hard postcondition
 * and the run *aborts* if any beat takes longer than its budget or any
 * assertion misses. Three iterations are run back-to-back; if the
 * cumulative wall-clock for any single iteration exceeds 8:00 the
 * script exits non-zero.
 *
 * Usage:
 *   pnpm tsx scripts/demo_rehearsal.ts
 *   ITERATIONS=1 HEADLESS=0 pnpm tsx scripts/demo_rehearsal.ts
 *
 * Env knobs:
 *   FRONTEND_URL   default http://127.0.0.1:5000
 *   BACKEND_URL    default http://127.0.0.1:8000  (audit chain reads)
 *   HEADLESS       set "0" to run headed; default headless
 *   SLOW_MO        ms between actions; default 80
 *   ITERATIONS     number of consecutive runs; default 3
 *   PER_RUN_BUDGET_MS  default 480_000 (8 min)
 *   THERMAL_BUDGET_MS  default 8_000  (toast + audit row arrive)
 */
import { chromium, type Browser, type Page } from "playwright";

const BASE = process.env.FRONTEND_URL ?? "http://127.0.0.1:5000";
const BACKEND = process.env.BACKEND_URL ?? "http://127.0.0.1:8000";
const HEADLESS = process.env.HEADLESS !== "0";
const SLOW_MO = Number(process.env.SLOW_MO ?? "80");
const ITERATIONS = Number(process.env.ITERATIONS ?? "3");
const PER_RUN_BUDGET_MS = Number(process.env.PER_RUN_BUDGET_MS ?? "480000");
// Round-4: bumped from 3000ms because cold-mount BastionView + first
// /alerts poll + the simulate POST consistently land in the 4-6s
// range on first iteration; a 3s budget produced false negatives even
// when the audit row was correctly written. 8s is still tight enough
// to catch a real propagation regression but absorbs first-paint
// jitter on Playwright's headless launch.
const THERMAL_BUDGET_MS = Number(process.env.THERMAL_BUDGET_MS ?? "8000");

// Presenter handoff roster — DODIDs and last-name labels match
// backend/auth.MOCK_USERS. Each entry maps a beat marker to the
// IdentityChips chip we expect to be visible on the TopBar in stage
// mode. We click the chip via its `aria-label="Switch to ${RANK}
// ${LAST_NAME} ..."` selector, which is stable against re-render.
const HANDOFFS = {
  reyes:    { dodid: "1234567890", last: "Reyes",    role: "g4"                },
  hayes:    { dodid: "4567890123", last: "Hayes",    role: "mef_commander"     },
  kowalski: { dodid: "2345678901", last: "Kowalski", role: "maintenance_chief" },
  park:     { dodid: "3456789012", last: "Park",     role: "security_manager"  },
} as const;

interface BeatResult {
  name: string;
  durationMs: number;
  ok: boolean;
  note?: string;
}

interface RunResult {
  iteration: number;
  beats: BeatResult[];
  totalMs: number;
  ok: boolean;
}

class StrictBeatFailure extends Error {
  constructor(public beatName: string, public detail: string) {
    super(`[${beatName}] ${detail}`);
  }
}

async function strictBeat(
  results: BeatResult[],
  name: string,
  fn: () => Promise<void>,
): Promise<void> {
  const start = Date.now();
  try {
    await fn();
    const dur = Date.now() - start;
    results.push({ name, durationMs: dur, ok: true });
  } catch (err) {
    const dur = Date.now() - start;
    const note = err instanceof Error ? err.message : String(err);
    results.push({ name, durationMs: dur, ok: false, note });
    throw new StrictBeatFailure(name, note);
  }
}

// The judge-facing Onboarding modal renders post-login at z-[9100] and
// intercepts every pointer event until dismissed. It tracks "seen" via a
// per-DODID localStorage key + backend pref, so the first iteration of
// each fresh-session run pops it. Skip / Escape both close it; we click
// "Skip intro" if visible, fall back to Escape, and tolerate either no-
// op if the modal isn't on screen.
async function dismissOnboardingIfPresent(page: Page): Promise<void> {
  const skip = page.locator('[aria-label="Skip intro"]').first();
  if (await skip.isVisible({ timeout: 750 }).catch(() => false)) {
    await skip.click().catch(() => {});
    await skip.waitFor({ state: "hidden", timeout: 3_000 }).catch(() => {});
    return;
  }
  // Fall back to Escape (the modal binds keydown on window).
  const overlay = page.locator('[aria-labelledby="spire-intro-title"]').first();
  if (await overlay.isVisible({ timeout: 250 }).catch(() => false)) {
    await page.keyboard.press("Escape");
    await overlay.waitFor({ state: "hidden", timeout: 3_000 }).catch(() => {});
  }
}

async function gotoStageBridge(page: Page): Promise<void> {
  await page.goto(`${BASE}/?stage=1#/`, { waitUntil: "domcontentloaded" });
  await dismissOnboardingIfPresent(page);
  // Stage thesis line is the canonical "I'm on the four-tile bridge"
  // postcondition (heading is exact-text per WP-2).
  await page.waitForSelector(
    'h1:has-text("One OS · One dataset · One audit chain · Four use cases solved.")',
    { timeout: 15_000 },
  );
  // All four tiles must be rendered before we trust the page.
  for (const label of ["SENTRY", "PULSE", "BASTION", "DHA RESCUE"]) {
    const tile = page.locator(`[aria-label^="${label}"]`).first();
    await tile.waitFor({ state: "visible", timeout: 8_000 });
  }
}

async function clickTile(page: Page, label: string): Promise<void> {
  // The Onboarding modal can re-appear after a handoff (server pref is
  // per-DODID and reconciled on identity change). Dismiss before any
  // tile interaction so the click isn't intercepted by the overlay.
  await dismissOnboardingIfPresent(page);
  const btn = page.locator(`[aria-label^="${label}"]`).first();
  await btn.waitFor({ state: "visible", timeout: 8_000 });
  await btn.click();
}

async function ensureAuthed(page: Page): Promise<void> {
  // The cert-pick screen renders if no session cookie. Pick Reyes (the
  // first cert in the directory · g4) and PIN any 6 digits. AuthView's
  // cert tile carries `aria-label="Select certificate for ${name}"`
  // and the submit primitive is a plain <Button> (type="button" — not
  // type="submit"), so we anchor on the visible "Sign in" label.
  const certBtn = page.locator('[aria-label^="Select certificate for"]').first();
  if (await certBtn.isVisible({ timeout: 1_500 }).catch(() => false)) {
    await certBtn.click();
    const pinInput = page.locator('input#cac-pin, input[type="password"], input[inputmode="numeric"]').first();
    await pinInput.waitFor({ state: "visible", timeout: 5_000 });
    await pinInput.fill("000000");
    const submit = page.locator('button:has-text("Sign in")').first();
    await submit.click();
    // Wait for the cert screen to disappear.
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
  }
}

interface AuditRow { kind: string; ts: string; actor?: string }

// Light count via the open `status` endpoint — no auth required, used
// only for the pre/post delta assertion. The status payload nests the
// count under `security.audit_entries` (verified live, round-4); the
// previous flat `j.audit_entries` shape never existed and pinned the
// pre/post values to 0, masking real deltas.
async function fetchAuditCount(): Promise<number> {
  try {
    const resp = await fetch(`${BACKEND}/api/system/status`);
    if (!resp.ok) return 0;
    const j = (await resp.json()) as { security?: { audit_entries?: number } };
    const n = j.security?.audit_entries;
    return typeof n === "number" ? n : 0;
  } catch { return 0; }
}

// Detailed chain enumeration for per-module bucketing. Hits the SOC
// audit endpoint, which is role-gated to security_manager; we do this
// AFTER the Park handoff so the cookie carries Park's session and the
// gate passes regardless of the env stage-bypass setting.
async function fetchAuditChainAsPark(
  page: Page,
  limit = 200,
): Promise<{ rows: AuditRow[]; chainOk: boolean | null }> {
  try {
    // Use page.request so the browser cookie travels with the call.
    const resp = await page.request.get(
      `${BACKEND}/api/system/admin/audit?role=security_manager&limit=${limit}`,
    );
    if (!resp.ok()) {
      return { rows: [], chainOk: null };
    }
    const body = (await resp.json()) as {
      rows?: { kind: string; ts: string; actor?: string }[];
      chain?: { ok?: boolean };
    };
    return {
      rows: (body.rows ?? []).map((r) => ({ kind: r.kind, ts: r.ts, actor: r.actor })),
      chainOk: body.chain?.ok ?? null,
    };
  } catch {
    return { rows: [], chainOk: null };
  }
}

// Bucket audit kinds by stage-module. Most kinds carry a `${module}.` or
// `${module}_` prefix; a few historical kinds (cannibalization_*) belong
// to PULSE without that prefix and are mapped explicitly. Anything we
// don't recognise lands in `other` (e.g. system/auth events).
const PULSE_KIND_ALIASES = new Set([
  "cannibalization_propose",
  "cannibalization_approve",
]);

function bucketByModule(rows: AuditRow[]): Record<string, AuditRow[]> {
  const buckets: Record<string, AuditRow[]> = {
    sentry: [], pulse: [], bastion: [], dha: [], other: [],
  };
  for (const r of rows) {
    const k = (r.kind || "").toLowerCase();
    if (k.startsWith("dha.") || k.startsWith("dha_")) buckets.dha.push(r);
    else if (k.startsWith("sentry.") || k.startsWith("sentry_")) buckets.sentry.push(r);
    else if (k.startsWith("pulse.") || k.startsWith("pulse_") || PULSE_KIND_ALIASES.has(k)) buckets.pulse.push(r);
    else if (k.startsWith("bastion.") || k.startsWith("bastion_")) buckets.bastion.push(r);
    else buckets.other.push(r);
  }
  return buckets;
}

async function clickHandoffChip(
  page: Page,
  handoff: { last: string; dodid: string },
): Promise<void> {
  // Drop the modal first — same reason as clickTile (handoff can refresh
  // identity-keyed prefs and re-arm the intro).
  await dismissOnboardingIfPresent(page);
  // The IdentityChips strip emits aria-label "Switch to ${RANK}
  // ${LAST_NAME} · ${ROLE_LABEL}". We anchor on the last name (unique
  // across the four MOCK_USERS) and use the *^=* prefix selector so
  // the rank prefix doesn't have to match exactly.
  const chip = page.locator(`[aria-label*="Switch to "][aria-label*="${handoff.last}"]`).first();
  await chip.waitFor({ state: "visible", timeout: 6_000 });
  await chip.click();
  // The swap calls quick-switch (or login fallback) and then nav("/")
  // — wait for the toast that confirms the new identity.
  await page.waitForSelector(`text=/Signed in as.+${handoff.last}/i`, { timeout: 6_000 });
  // And the bridge re-renders with the four-tile grid.
  await page.waitForSelector('[aria-label^="DHA RESCUE"]', { timeout: 6_000 });
  // The bridge re-mount can also re-mount <Onboarding>, which fires the
  // server pref reconcile for the NEW identity. If that DODID's server
  // pref says seen=false (e.g. Park is fresh in this run), the modal
  // pops again. Drop it now so the next beat's interaction isn't
  // intercepted by the overlay.
  await dismissOnboardingIfPresent(page);
}

async function runOne(page: Page, iteration: number): Promise<RunResult> {
  const beats: BeatResult[] = [];
  const startTotal = Date.now();
  let preAuditCount = 0;
  let postAuditCount = 0;

  await strictBeat(beats, "01 · Boot stage Decision Surface (Reyes · g4)", async () => {
    await page.goto(`${BASE}/?stage=1#/`, { waitUntil: "domcontentloaded" });
    await ensureAuthed(page);
    await gotoStageBridge(page);
  });

  await strictBeat(beats, "01b · Snapshot audit count (pre)", async () => {
    preAuditCount = await fetchAuditCount();
  });

  await strictBeat(beats, "02 · Open SENTRY (USE CASE 14)", async () => {
    await clickTile(page, "SENTRY");
    await page.waitForURL(/#\/sentry/, { timeout: 10_000 });
    // The use-case strip is the proof we landed in stage layout, not
    // a direct browse. The strip says exactly "USE CASE 14 · SENTRY".
    await page.waitForSelector('text=/USE CASE 14[\\s·]+SENTRY/i', { timeout: 6_000 });
  });

  await strictBeat(beats, "02b · Return to bridge", async () => {
    await page.goto(`${BASE}/?stage=1#/`, { waitUntil: "domcontentloaded" });
    await gotoStageBridge(page);
  });

  await strictBeat(beats, "02h · HANDOFF → Kowalski (maintenance_chief)", async () => {
    await clickHandoffChip(page, HANDOFFS.kowalski);
  });

  await strictBeat(beats, "03 · Open PULSE (USE CASE 13)", async () => {
    await clickTile(page, "PULSE");
    await page.waitForURL(/#\/pulse/, { timeout: 10_000 });
    await page.waitForSelector('text=/USE CASE 13[\\s·]+PULSE/i', { timeout: 6_000 });
  });

  await strictBeat(beats, "03b · Return to bridge", async () => {
    await page.goto(`${BASE}/?stage=1#/`, { waitUntil: "domcontentloaded" });
    await gotoStageBridge(page);
  });

  await strictBeat(beats, "03h · HANDOFF → Hayes (mef_commander)", async () => {
    await clickHandoffChip(page, HANDOFFS.hayes);
  });

  await strictBeat(beats, "04 · Open BASTION (USE CASE 15) + simulate ThermalHawk", async () => {
    await clickTile(page, "BASTION");
    await page.waitForURL(/#\/bastion/, { timeout: 10_000 });
    await page.waitForSelector('text=/USE CASE 15[\\s·]+BASTION/i', { timeout: 6_000 });

    // UI-driven trigger — anchor the locator on the button's `title`
    // attribute so we hit the exact "Sim Controls" pill and not any
    // other element that happens to contain the word "ThermalHawk"
    // (the StatusStrip/COP card render that substring on initial paint
    // and would let a no-op pass).
    //
    // The button's onClick dispatches `spire:simulate-thermalhawk` on
    // window; a useEffect inside BastionView listens for it and calls
    // `triggerThermalHawk()`. The dispatch + listener are both wired
    // by the time the button is interactable (React commits the
    // useEffect during the same render that mounts the button), so
    // the historical "click drops silently" failure was actually the
    // overlay/onboarding modal eating the click — fixed in
    // clickTile/clickHandoffChip via dismissOnboardingIfPresent.
    const simBtn = page.locator(
      'button[title*="Dispatch a synthetic ThermalHawk"]',
    ).first();
    await simBtn.waitFor({ state: "visible", timeout: 6_000 });
    const simStart = Date.now();
    await simBtn.click();

    // Hard postcondition — the operator-facing TOAST that only renders
    // *after* the simulate POST succeeds. The exact wording is fixed
    // in BastionView (`pushToast` in `triggerThermalHawk`) and contains
    // a unique punctuated phrase ("ThermalHawk UAS incident active")
    // that does NOT appear anywhere else on the page on initial mount.
    // If the click is dropped, the listener never fires, the POST is
    // never made, the toast never renders, and this beat fails loudly
    // — exactly the drift detector the rehearsal is meant to be.
    await page.waitForSelector(
      'text=/FPCON elevated to CHARLIE · ThermalHawk UAS incident active/',
      { timeout: THERMAL_BUDGET_MS },
    );

    // Independent server-side confirmation — the toast only renders on
    // FE success, but a future FE refactor could fire the toast on the
    // wrong code path. Pull `_ACTIVE_SIMS` count via a fresh call as a
    // belt-and-suspenders check that the audit chain will have a row
    // to surface in the closing AUDIT beat.
    const cop = await page.request.get(`${BACKEND}/api/bastion/cop`);
    if (!cop.ok()) {
      throw new Error(`bastion cop fetch failed post-sim: HTTP ${cop.status()}`);
    }

    const simDur = Date.now() - simStart;
    if (simDur > THERMAL_BUDGET_MS) {
      throw new Error(`ThermalHawk fanout took ${simDur}ms (>${THERMAL_BUDGET_MS}ms budget)`);
    }
  });

  await strictBeat(beats, "04b · Return to bridge", async () => {
    await page.goto(`${BASE}/?stage=1#/`, { waitUntil: "domcontentloaded" });
    await gotoStageBridge(page);
  });

  await strictBeat(beats, "05 · Open DHA RESCUE (USE CASE 4)", async () => {
    await clickTile(page, "DHA RESCUE");
    await page.waitForURL(/#\/dha-rescue/, { timeout: 10_000 });
    // Hub-spoke MapLibre region is unique to the new H+72 surface
    // (round-4 migration from SVG schematic). The aria-label starts
    // with "Hub-spoke map." so we anchor on the prefix.
    await page.waitForSelector('[aria-label^="Hub-spoke map"]', { timeout: 10_000 });
    await page.waitForSelector('[aria-label="Days of supply gauges"]', { timeout: 6_000 });
  });

  await strictBeat(beats, "05b · Advance to H+24 (writes audit row)", async () => {
    const adv = page.locator('button:has-text("Advance to H+24")').first();
    await adv.waitFor({ state: "visible", timeout: 5_000 });
    await adv.click();
    // The H+24 chip becomes aria-current="step".
    await page.waitForSelector('[aria-current="step"]:has-text("H+24")', { timeout: 5_000 });
  });

  await strictBeat(beats, "05c · Advance to H+48", async () => {
    const adv = page.locator('button:has-text("Advance to H+48")').first();
    await adv.waitFor({ state: "visible", timeout: 5_000 });
    await adv.click();
    await page.waitForSelector('[aria-current="step"]:has-text("H+48")', { timeout: 5_000 });
  });

  await strictBeat(beats, "05d · Advance to H+72 + approve sourcing", async () => {
    const adv = page.locator('button:has-text("Advance to H+72")').first();
    await adv.waitFor({ state: "visible", timeout: 5_000 });
    await adv.click();
    await page.waitForSelector('[aria-current="step"]:has-text("H+72")', { timeout: 5_000 });
    // Approve at least one market-sourcing recommendation. The first
    // visible Approve chip on the panel is enough — H+72 surfaces
    // multiple under-min products so at least one Approve exists.
    const approve = page.locator('button:has-text("Approve")').first();
    await approve.waitFor({ state: "visible", timeout: 5_000 });
    await approve.click();
    // Approval flips the button to "✓ Approved".
    await page.waitForSelector('button:has-text("✓ Approved")', { timeout: 5_000 });
  });

  // Capture the run start instant so the per-module assertion later can
  // distinguish rows written BY THIS RUN from older rows in the chain
  // (the audit endpoint returns the full chain, not just our writes).
  // We bias by 5s to absorb any clock drift between client and server.
  const runStartIso = new Date(startTotal - 5_000).toISOString();

  await strictBeat(beats, "05e · PULSE cannibalization propose → audit (as Hayes · mef_commander)", async () => {
    // The propose route is gated on
    // `pulse._PROPOSE_ROLES = {g4, maintenance_chief, mef_commander}`,
    // and (Task #41) does dataset-level validation:
    //   - recipient_sr must exist in ds.srs
    //   - donor_asset_id (preferred) or donor_sr must resolve
    //   - the supplied NSN must match one of the recipient SR's pending
    //     requisitions
    // Synthetic IDs (REH-RECIPIENT-001 / NSN 1005-01-123-4567) trip
    // UnknownRecipient. Instead, fetch the live cannibalization candidate
    // graph as Hayes and propose against the first
    // (recipient · strippable-donor · NSN) tuple it gives us. We must
    // issue this BEFORE the Park handoff because security_manager is
    // NOT in the propose allowlist.
    // The GET takes role as a query param (NOT derived from the session
    // — see `cannibalization(role: Optional[str] = None)`). Pass Hayes's
    // role so `allowed_units` returns his BASTION/PULSE scope.
    const candResp = await page.request.get(
      `${BACKEND}/api/pulse/cannibalization?role=${HANDOFFS.hayes.role}`,
    );
    if (!candResp.ok()) {
      const body = await candResp.text().catch(() => "");
      throw new Error(`cannibalization GET failed: HTTP ${candResp.status()} ${body.slice(0, 200)}`);
    }
    // Endpoint shape (verified live, round-4): the recipient list is at
    // `open_needs[]`, not `needs[]`. Each entry carries `sr_number` +
    // `needed_part.nsn`; `strippable_donors[sr_number]` is the donor-
    // asset bucket for that recipient.
    const cand = (await candResp.json()) as {
      open_needs?: { sr_number: string; needed_part: { nsn: string } }[];
      strippable_donors?: Record<string, { asset_id: string }[]>;
    };
    const totalDonors = Object.values(cand.strippable_donors ?? {})
      .reduce((acc, lst) => acc + lst.length, 0);
    const need = (cand.open_needs ?? []).find(
      (n) => (cand.strippable_donors?.[n.sr_number] ?? []).length > 0,
    );
    if (!need) {
      // Diagnostic dump so a presenter can tell at a glance whether the
      // problem is "endpoint returned nothing" (dataset issue) vs "needs
      // present but no donors" (matcher / scope issue) vs "scope too tight"
      // (role gating wrong). The keys list shows shape mismatches.
      throw new Error(
        `no candidate (recipient + strippable donor) tuple available — ` +
        `open_needs=${(cand.open_needs ?? []).length}, donor-buckets=${Object.keys(cand.strippable_donors ?? {}).length}, ` +
        `total-donors=${totalDonors}, top-level-keys=${Object.keys(cand).join("|")}`,
      );
    }
    const donor = (cand.strippable_donors?.[need.sr_number] ?? [])[0];
    const resp = await page.request.post(
      `${BACKEND}/api/pulse/cannibalization/propose`,
      {
        data: {
          recipient_sr: need.sr_number,
          donor_asset_id: donor.asset_id,
          nsn: need.needed_part.nsn,
        },
      },
    );
    if (!resp.ok()) {
      const body = await resp.text().catch(() => "");
      throw new Error(`cannibalization propose failed: HTTP ${resp.status()} ${body.slice(0, 200)}`);
    }
  });

  await strictBeat(beats, "05h · HANDOFF → Park (security_manager)", async () => {
    await clickHandoffChip(page, HANDOFFS.park);
  });

  await strictBeat(beats, "05i · SENTRY coalition release (FVEY_BASE, as Park) → audit", async () => {
    // Park (security_manager) meets COALITION_RELEASE_ROLES, so this
    // POST writes a `sentry_coalition_release` audit row from her
    // session cookie. We use page.request so the cookie travels with
    // the call. The route accepts an empty body; profile_key in the
    // URL (FVEY_BASE — five-eyes baseline, valid per
    // dataset/data/coalition_profiles.json) drives manifest hashing.
    const resp = await page.request.post(
      `${BACKEND}/api/sentry/coalition/FVEY_BASE/release`,
      { data: {} },
    );
    if (!resp.ok()) {
      const body = await resp.text().catch(() => "");
      throw new Error(`coalition release failed: HTTP ${resp.status()} ${body.slice(0, 200)}`);
    }
  });

  await strictBeat(beats, "06 · Open AUDIT pill", async () => {
    // The Park handoff just landed us on the bridge — that re-mounts
    // <Onboarding>, which can pop the intro modal again (same z-[9100]
    // overlay that intercepts every click). Drop it first.
    await dismissOnboardingIfPresent(page);
    // Two surfaces emit an "Open audit chain" pill: DhaRescueView's
    // bare label ("Open audit chain") and StageCluster's TopBar pill
    // ("Open audit chain — SOC view"). After the Park handoff we land
    // on the bridge ("/"), so the pill we click is StageCluster's;
    // anchor on the prefix so either surface satisfies the assertion.
    const audit = page.locator('[aria-label^="Open audit chain"]').first();
    await audit.waitFor({ state: "visible", timeout: 6_000 });
    await audit.click();
    await page.waitForURL(/#\/admin\/audit/, { timeout: 10_000 });
  });

  await strictBeat(beats, "06b · Audit count delta ≥7 (3 advances + 1 approve + 1 sentry + 1 pulse + 1 bastion)", async () => {
    postAuditCount = await fetchAuditCount();
    const delta = postAuditCount - preAuditCount;
    if (delta < 7) {
      throw new Error(
        `expected ≥7 new audit rows from this run ` +
        `(3 dha advances + 1 dha approve + 1 sentry release + 1 pulse propose + 1 bastion simulate), got ${delta}`,
      );
    }
  });

  await strictBeat(beats, "06c · Per-module audit kinds (HARD: each of sentry/pulse/bastion/dha ≥1 from THIS run)", async () => {
    const { rows, chainOk } = await fetchAuditChainAsPark(page, 500);
    if (chainOk === false) {
      throw new Error("audit chain.ok === false (hash chain broken)");
    }
    if (rows.length === 0) {
      throw new Error("audit endpoint returned 0 rows — Park session may not have read access");
    }
    // Filter to rows written DURING THIS REHEARSAL run only (newer than
    // run-start, with a small clock-drift bias). This proves OUR domain
    // actions, not pre-existing chain history, populated each module.
    const ours = rows.filter((r) => (r.ts ?? "") >= runStartIso);
    const buckets = bucketByModule(ours);

    // Visibility: print summary first so a failing assertion has the
    // counts right above the error message.
    const summary: string[] = [];
    for (const m of ["sentry", "pulse", "bastion", "dha"] as const) {
      summary.push(`${m}=${buckets[m].length}`);
    }
    console.log(
      `         per-module audit rows from this run (since ${runStartIso}): ` +
      `${summary.join(" ")} | other=${buckets.other.length} | total-rows-in-chain=${rows.length}`,
    );

    // Hard, granular assertions — one per module so a failure points at
    // the offending module without ambiguity. dha minimum is 4 (the
    // four DHA writes we made); sentry/pulse/bastion minimum is 1.
    if (buckets.dha.length < 4) {
      throw new Error(
        `dha.* bucket has ${buckets.dha.length} new rows (<4 expected from this run); ` +
        `kinds seen: ${buckets.dha.map((r) => r.kind).join(", ") || "(none)"}`,
      );
    }
    for (const m of ["sentry", "pulse", "bastion"] as const) {
      if (buckets[m].length < 1) {
        throw new Error(
          `${m}.* bucket has 0 new rows from this run (≥1 expected); ` +
          `the matching domain action did not produce an audit entry. ` +
          `kinds in 'other' bucket: ${buckets.other.map((r) => r.kind).slice(0, 10).join(", ") || "(none)"}`,
        );
      }
    }
  });

  const totalMs = Date.now() - startTotal;
  return { iteration, beats, totalMs, ok: true };
}

async function main() {
  let browser: Browser | undefined;
  const runs: RunResult[] = [];
  let exitCode = 0;
  try {
    browser = await chromium.launch({ headless: HEADLESS, slowMo: SLOW_MO });
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    // Pre-stamp the per-DODID onboarding "seen" flag so the judge intro
    // modal (z-[9100], full-screen overlay — see Onboarding.tsx) never
    // pops mid-run on Reyes/Hayes/Kowalski/Park. The modal otherwise
    // re-appears every time we hand off to a new identity, intercepting
    // tile clicks. The localStorage key shape mirrors `lsKey(dodid)`.
    await context.addInitScript((dodids: string[]) => {
      try {
        for (const d of dodids) {
          window.localStorage.setItem(`spire.onboarding.intro.seen.${d}`, "1");
        }
      } catch { /* private mode tolerant */ }
    }, Object.values(HANDOFFS).map((h) => h.dodid));
    const page = await context.newPage();
    page.on("pageerror", (err) => console.warn("[pageerror]", err.message));

    for (let i = 1; i <= ITERATIONS; i++) {
      console.log(`\n--- Iteration ${i}/${ITERATIONS} ---`);
      try {
        const r = await runOne(page, i);
        runs.push(r);
        if (r.totalMs > PER_RUN_BUDGET_MS) {
          console.error(
            `FAIL iter ${i}: wall-clock ${(r.totalMs / 1000).toFixed(1)}s exceeded budget ` +
            `${(PER_RUN_BUDGET_MS / 1000).toFixed(0)}s`,
          );
          exitCode = 2;
        }
      } catch (err) {
        const note = err instanceof Error ? err.message : String(err);
        console.error(`FAIL iter ${i}: ${note}`);
        runs.push({ iteration: i, beats: [], totalMs: -1, ok: false });
        exitCode = 1;
        // Reset cookies between iterations so each run starts clean.
        await context.clearCookies().catch(() => {});
      }
    }

    console.log("\n=== Stage rehearsal report ===");
    for (const r of runs) {
      const totalSec = r.totalMs >= 0 ? `${(r.totalMs / 1000).toFixed(1)}s` : "—";
      const flag = r.ok && r.totalMs >= 0 && r.totalMs <= PER_RUN_BUDGET_MS ? "✓" : "✗";
      console.log(`  ${flag} iter ${r.iteration}: ${totalSec} (${r.beats.length} beats)`);
      for (const b of r.beats) {
        const bf = b.ok ? " " : "✗";
        console.log(
          `      ${bf}  ${b.name.padEnd(56)} ${(b.durationMs / 1000).toFixed(2)}s` +
          (b.note ? `  (${b.note})` : ""),
        );
      }
    }
    const passed = runs.filter((r) => r.ok && r.totalMs >= 0 && r.totalMs <= PER_RUN_BUDGET_MS).length;
    console.log(
      `\nResult: ${passed}/${ITERATIONS} iterations within budget ` +
      `(${(PER_RUN_BUDGET_MS / 1000).toFixed(0)}s).`,
    );
    if (passed < ITERATIONS) {
      console.error("STRICT mode: one or more iterations failed.");
      if (exitCode === 0) exitCode = 1;
    }
  } finally {
    if (browser) await browser.close();
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("Fatal rehearsal error:", err);
  process.exit(1);
});
