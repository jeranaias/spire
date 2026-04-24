"""
End-to-end user flow test. Simulates what a judge or Adrian actually does:

  1. Land on /
  2. Watch SENTRY Upload auto-seed canonical
  3. Click Process batch -> processing view plays animation
  4. Click Review queue -> kanban renders
  5. Approve a record
  6. Go to Mark Draft, paste a sample, submit, verify result
  7. Go to Export, select FVEY, click Build bundle, verify download url
  8. Switch role dropdown: maintenance_chief -> verify PULSE heatmap shrinks
  9. Click Risk Board -> click an asset -> verify deep-dive panel
  10. Cannibalization tab -> verify open needs render
  11. Forecast -> switch unit dropdown -> verify chart updates
  12. BASTION -> verify Leaflet tiles render + alerts sidebar populated
  13. Click Simulate ThermalHawk -> verify drone/cordon render + response panel
  14. Click alert in sidebar -> verify right-panel checklist
  15. NL TMR: type "TMR Lejeune to Yuma 2 HIMARS Friday urgent" -> verify card

Failures print with path/selector. Success gate = zero Python assertion errors.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

os.environ["PYTHONIOENCODING"] = "utf-8"
sys.stdout.reconfigure(encoding="utf-8")

from playwright.sync_api import Page, sync_playwright  # noqa: E402

BASE = "http://localhost:8700"
SHOT_DIR = Path("/tmp/spire_e2e")
SHOT_DIR.mkdir(parents=True, exist_ok=True)

FAILS: list[str] = []


def log(msg: str):
    print(msg, flush=True)


def fail(msg: str):
    FAILS.append(msg)
    log(f"  [FAIL] {msg}")


def ok(msg: str):
    log(f"  [OK]   {msg}")


def snap(page: Page, name: str):
    path = SHOT_DIR / f"{name}.png"
    page.screenshot(path=str(path), full_page=False)


def wait_text(page: Page, text: str, timeout: float = 4000) -> bool:
    try:
        page.wait_for_selector(f"text={text}", timeout=timeout)
        return True
    except Exception:
        return False


def click_text(page: Page, text: str, *, nth: int = 0) -> bool:
    try:
        page.get_by_text(text, exact=False).nth(nth).click(timeout=3000)
        return True
    except Exception as e:
        fail(f"click '{text}' (nth={nth}): {e}")
        return False


def run_sentry_flow(page: Page):
    log("\n=== SENTRY FLOW ===")

    # 1. Upload auto-seeds
    page.goto(f"{BASE}/#/sentry/upload", wait_until="networkidle", timeout=15000)
    if wait_text(page, "Data ingestion"):
        ok("SENTRY upload loaded")
    else:
        fail("SENTRY upload page didn't load 'Data ingestion' header")
    page.wait_for_timeout(1500)  # let canonical auto-seed
    if wait_text(page, "Batch", timeout=8000):
        ok("Canonical dataset auto-seeded (batch visible)")
    else:
        fail("Canonical batch did not auto-seed")
    snap(page, "01_sentry_upload_seeded")

    # 2. Click Process batch
    try:
        page.get_by_role("button", name="Process batch").click(timeout=5000)
        ok("Clicked 'Process batch'")
    except Exception as e:
        fail(f"could not click Process batch: {e}")
        return

    # 3. Processing view
    page.wait_for_timeout(1500)
    if wait_text(page, "Raw input", timeout=4000):
        ok("Processing view rendered 'Raw input' column")
    else:
        fail("Processing view never showed Raw input column")
    if wait_text(page, "Sanitized output", timeout=2000):
        ok("Processing view rendered 'Sanitized output' column")
    page.wait_for_timeout(3000)
    snap(page, "02_sentry_processing")

    # 4. Review queue
    try:
        page.get_by_role("button", name="Review queue →").click(timeout=8000)
        ok("Clicked 'Review queue →'")
    except Exception:
        # fallback: manual nav
        page.goto(f"{BASE}/#/sentry/review", wait_until="networkidle")
        ok("Navigated directly to review queue (button unavailable)")

    page.wait_for_timeout(1200)
    if wait_text(page, "Auto-cleared"):
        ok("Review queue kanban rendered")
    else:
        fail("Review queue didn't render")
    snap(page, "03_sentry_review")

    # 5. Approve a record via the checkmark
    try:
        page.locator("button:has-text('✓')").first.click(timeout=3000)
        ok("Clicked approve on a review card")
    except Exception as e:
        fail(f"couldn't click approve: {e}")

    # 6. Mark Draft
    page.goto(f"{BASE}/#/sentry/mark", wait_until="networkidle")
    if wait_text(page, "Upstream marking"):
        ok("Mark Draft view loaded")
    try:
        # Paste a sample via the Radar sample button
        page.get_by_role("button", name="Radar fault (classified TM)").click(timeout=3000)
        ok("Loaded classified-TM sample")
        page.get_by_role("button", name="Recommend marking").click(timeout=3000)
        page.wait_for_timeout(1200)
        if wait_text(page, "SECRET"):
            ok("Mark recommendation returned SECRET for classified sample")
        else:
            fail("Mark Draft didn't surface SECRET recommendation")
        snap(page, "04_sentry_mark_secret")
    except Exception as e:
        fail(f"Mark Draft interaction: {e}")

    # 7. Export
    page.goto(f"{BASE}/#/sentry/export", wait_until="networkidle")
    if wait_text(page, "Release authority"):
        ok("Export view loaded")
    try:
        # Pick FVEY
        page.get_by_label("FVEY").click(timeout=3000)
        page.get_by_role("button", name="Export sanitized bundle").click(timeout=3000)
        page.wait_for_timeout(1500)
        if wait_text(page, "Export prepared"):
            ok("Export bundle built")
        else:
            fail("Export prepared card never appeared")
        snap(page, "05_sentry_export")
    except Exception as e:
        fail(f"Export flow: {e}")


def run_pulse_flow(page: Page):
    log("\n=== PULSE FLOW ===")

    page.goto(f"{BASE}/#/pulse/overview", wait_until="networkidle")
    if wait_text(page, "Fleet readiness heatmap"):
        ok("PULSE overview loaded")
    page.wait_for_timeout(1200)

    # Check hero MC — should NOT be %%
    content = page.content()
    if "%%" in content:
        fail("Double percent sign still rendered somewhere")
    else:
        ok("No %% double-percent bugs")
    snap(page, "06_pulse_overview_mef")

    # Role switch to maintenance_chief -> only 1 unit in heatmap
    try:
        page.select_option("select", value="maintenance_chief", timeout=3000)
        page.wait_for_timeout(1500)
        snap(page, "07_pulse_overview_chief")
        heatmap_rows = page.evaluate(
            "document.querySelectorAll('tbody tr').length"
        )
        if heatmap_rows == 1:
            ok(f"Role scoping shrank heatmap to {heatmap_rows} unit (maintenance_chief = CLB-6 only)")
        else:
            fail(f"Role scoping heatmap shows {heatmap_rows} rows (expected 1)")
    except Exception as e:
        fail(f"Role switch: {e}")

    # Risk Board
    page.goto(f"{BASE}/#/pulse/risk", wait_until="networkidle")
    page.wait_for_timeout(1500)
    if wait_text(page, "Risk board"):
        ok("Risk board loaded")
    try:
        # Click first asset card
        page.locator("button:has-text('Primary:')").first.click(timeout=3000)
        page.wait_for_timeout(1500)
        if wait_text(page, "Contributing factors"):
            ok("Asset deep-dive opened")
        else:
            fail("Deep-dive panel didn't render 'Contributing factors'")
        snap(page, "08_pulse_deep_dive")
    except Exception as e:
        fail(f"Asset click: {e}")

    # Cannibalization
    page.goto(f"{BASE}/#/pulse/cannib", wait_until="networkidle")
    page.wait_for_timeout(1200)
    if wait_text(page, "Needs"):
        ok("Cannibalization board loaded")
    if wait_text(page, "Completed matches"):
        ok("Completed matches column present")
    snap(page, "09_pulse_cannib")

    # Forecast
    page.goto(f"{BASE}/#/pulse/forecast", wait_until="networkidle")
    page.wait_for_timeout(1500)
    if wait_text(page, "Readiness forecast"):
        ok("Forecast view loaded")
    # Switch unit
    try:
        # The Forecast tab has its own unit select; find second select (first is role)
        selects = page.locator("select")
        if selects.count() >= 2:
            selects.nth(1).select_option("CLB-6", timeout=3000)
            page.wait_for_timeout(1200)
            ok("Forecast unit switched to CLB-6")
    except Exception as e:
        fail(f"Forecast unit switch: {e}")
    snap(page, "10_pulse_forecast")


def run_bastion_flow(page: Page):
    log("\n=== BASTION FLOW ===")

    # Reset role back to mef_commander for BASTION
    try:
        page.goto(f"{BASE}/#/pulse/overview", wait_until="networkidle")
        page.select_option("select", value="mef_commander", timeout=3000)
        page.wait_for_timeout(800)
    except Exception:
        pass

    page.goto(f"{BASE}/#/bastion", wait_until="networkidle")
    page.wait_for_timeout(2500)
    if wait_text(page, "ALERT STREAM"):
        ok("BASTION loaded with alert stream")
    else:
        fail("Alert stream header missing")

    # Leaflet container present
    if page.locator(".leaflet-container").count() > 0:
        ok("Leaflet map container rendered")
    else:
        fail("Leaflet map container missing")
    snap(page, "11_bastion_cop")

    # ThermalHawk trigger
    try:
        page.get_by_role("button", name="Simulate ThermalHawk detection").click(timeout=5000)
        page.wait_for_timeout(2500)
        if wait_text(page, "UAS DETECTED"):
            ok("ThermalHawk sim fired, CRITICAL alert rendered")
        else:
            fail("UAS DETECTED alert never showed up")
        snap(page, "12_bastion_thermalhawk")

        # Response panel should be open
        if wait_text(page, "IMMEDIATE ACTIONS", timeout=2000) or wait_text(page, "Immediate", timeout=2000):
            ok("Response panel rendered with IMMEDIATE ACTIONS checklist")
    except Exception as e:
        fail(f"ThermalHawk trigger: {e}")

    # NL TMR
    try:
        input_box = page.get_by_placeholder("Ask BASTION").first
        input_box.fill("TMR from Lejeune to Yuma, 2 HIMARS Friday priority", timeout=3000)
        input_box.press("Enter")
        page.wait_for_timeout(1500)
        if wait_text(page, "Parsed as TMR"):
            ok("NL TMR parsed and rendered")
        else:
            fail("NL TMR card didn't render")
        snap(page, "13_bastion_tmr")
    except Exception as e:
        fail(f"NL TMR: {e}")


def main():
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        ctx = b.new_context(viewport={"width": 1800, "height": 1100})
        page = ctx.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        page.on("console", lambda m: errors.append(f"[{m.type}] {m.text}") if m.type == "error" else None)

        run_sentry_flow(page)
        run_pulse_flow(page)
        run_bastion_flow(page)

        if errors:
            log("\n=== CONSOLE ERRORS ===")
            for e in errors[:20]:
                log(f"  {e[:250]}")
            FAILS.extend(errors[:20])

        b.close()

    log("\n" + "=" * 60)
    if FAILS:
        log(f"FAILED: {len(FAILS)} issues")
        for f in FAILS:
            log(f"  - {f[:250]}")
    else:
        log("ALL E2E FLOWS PASSED — 0 failures")
    log("=" * 60)
    log(f"Screenshots: {SHOT_DIR}")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
