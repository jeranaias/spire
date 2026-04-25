"""Drive SENTRY across every tab and every operator role; screenshot each."""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

OUT = Path("D:/projects/spire/tmp/reviews/sentry_shots")
OUT.mkdir(parents=True, exist_ok=True)

ROLES = [
    "data_custodian",
    "security_manager",
    "maintenance_chief",
    "g4",
    "mef_commander",
]

TABS = [
    ("upload", "Upload"),
    ("processing", "Processing"),
    ("review", "Review Queue"),
    ("mark", "Mark Draft"),
    ("export", "Export"),
]


async def switch_role(page, role: str) -> None:
    # The only native <select> in the top bar is the operator role selector.
    await page.evaluate(
        """(r) => {
            const selects = [...document.querySelectorAll('select')];
            for (const s of selects) {
                const opts = [...s.options].map(o => o.value);
                if (opts.includes(r)) {
                    s.value = r;
                    s.dispatchEvent(new Event('change', { bubbles: true }));
                    return true;
                }
            }
            return false;
        }""",
        role,
    )
    await page.wait_for_timeout(400)


async def goto_tab(page, slug: str) -> None:
    await page.goto(f"http://127.0.0.1:8700/#/sentry/{slug}")
    await page.wait_for_load_state("networkidle")
    await page.wait_for_timeout(800)


async def main() -> None:
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={"width": 1600, "height": 1000})
        page = await ctx.new_page()

        # ------------------------------------------------------------------
        # Phase 1: walk through every tab as default operator (data_custodian)
        # ------------------------------------------------------------------
        await page.goto("http://127.0.0.1:8700/#/sentry")
        await page.wait_for_load_state("networkidle")
        await page.wait_for_timeout(1500)
        await page.screenshot(path=str(OUT / "01_landing_upload.png"))

        # Hover the drop zone to show hover state
        try:
            drop = page.locator("text=Drop a file").first
            box = await drop.bounding_box()
            if box:
                await page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
                await page.wait_for_timeout(200)
                await page.screenshot(path=str(OUT / "02_upload_hover.png"))
        except Exception:
            pass

        # Scroll through the upload tab to see preview + data quality
        await page.evaluate("window.scrollTo(0, 200)")
        await page.wait_for_timeout(200)
        await page.screenshot(path=str(OUT / "03_upload_full.png"), full_page=True)

        # Click "Process batch" to start processing
        try:
            await page.click('button:has-text("Process batch")')
            await page.wait_for_timeout(600)
            await page.screenshot(path=str(OUT / "04_processing_start.png"))
            # Wait for a mid-animation snapshot
            await page.wait_for_timeout(1500)
            await page.screenshot(path=str(OUT / "05_processing_mid.png"))
            # And a settled snapshot
            await page.wait_for_timeout(4000)
            await page.screenshot(path=str(OUT / "06_processing_settled.png"))
        except Exception as e:
            print(f"Processing click failed: {e}")

        # Go to review queue
        await goto_tab(page, "review")
        await page.screenshot(path=str(OUT / "07_review_queue.png"))
        await page.screenshot(path=str(OUT / "07b_review_queue_full.png"), full_page=True)

        # Click a card in the Flagged column to select it
        try:
            flagged_card = page.locator('text=Flagged').first
            box = await flagged_card.bounding_box()
            if box:
                # Click the first card below the Flagged header
                await page.mouse.click(box["x"] + 80, box["y"] + 80)
                await page.wait_for_timeout(300)
                await page.screenshot(path=str(OUT / "08_review_card_selected.png"))
        except Exception:
            pass

        # Mark Draft tab
        await goto_tab(page, "mark")
        await page.screenshot(path=str(OUT / "09_mark_empty.png"))
        # Click the "Radar fault" sample to populate
        try:
            await page.click('button:has-text("Radar fault")')
            await page.wait_for_timeout(200)
            await page.click('button:has-text("Recommend marking")')
            await page.wait_for_timeout(1200)
            await page.screenshot(path=str(OUT / "10_mark_secret_result.png"))
            await page.screenshot(path=str(OUT / "10b_mark_full.png"), full_page=True)
        except Exception as e:
            print(f"Mark flow failed: {e}")

        # Try the convoy brief sample too (different classification)
        try:
            await page.click('button:has-text("Deployed convoy")')
            await page.wait_for_timeout(200)
            await page.click('button:has-text("Recommend marking")')
            await page.wait_for_timeout(1200)
            await page.screenshot(path=str(OUT / "11_mark_convoy.png"))
        except Exception:
            pass

        # Export tab
        await goto_tab(page, "export")
        await page.screenshot(path=str(OUT / "12_export_default.png"))
        # Pick NATO authority to show variation
        try:
            await page.click('label:has-text("NATO")')
            await page.wait_for_timeout(200)
            await page.click('button:has-text("csv")')
            await page.wait_for_timeout(150)
            await page.click('button:has-text("Export sanitized bundle")')
            await page.wait_for_timeout(1500)
            await page.screenshot(path=str(OUT / "13_export_result.png"))
            await page.screenshot(path=str(OUT / "13b_export_full.png"), full_page=True)
        except Exception as e:
            print(f"Export flow failed: {e}")

        # ------------------------------------------------------------------
        # Phase 2: cycle through each operator role, capture sentry landing
        # ------------------------------------------------------------------
        for i, role in enumerate(ROLES, start=20):
            await page.goto("http://127.0.0.1:8700/#/sentry/upload")
            await page.wait_for_load_state("networkidle")
            await page.wait_for_timeout(500)
            await switch_role(page, role)
            await page.wait_for_timeout(600)
            await page.screenshot(path=str(OUT / f"{i:02d}_role_{role}_upload.png"))
            # And the review queue for that role (if a batch still exists)
            await goto_tab(page, "review")
            await page.screenshot(path=str(OUT / f"{i:02d}b_role_{role}_review.png"))
            await goto_tab(page, "mark")
            await page.screenshot(path=str(OUT / f"{i:02d}c_role_{role}_mark.png"))

        # Detail shot: zoom into a raw record's flag highlighting on processing
        await page.goto("http://127.0.0.1:8700/#/sentry/processing")
        await page.wait_for_load_state("networkidle")
        await page.wait_for_timeout(1200)
        await page.screenshot(path=str(OUT / "30_processing_detail.png"), clip={"x": 0, "y": 40, "width": 1600, "height": 500})

        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
