"""
Critical review capture of BASTION map.

Drives the live app on http://127.0.0.1:8700/, navigates to BASTION,
and takes screenshots at multiple zoom levels + trigger states so we
can judge unit placement, cordon rings, HUD density, and clutter.

Usage: py scripts/bastion_review.py
Outputs: tmp/bastion_review/*.png
"""

import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

OUT = Path("D:/projects/spire/tmp/bastion_review")
OUT.mkdir(parents=True, exist_ok=True)

URL = "http://127.0.0.1:8700/#/bastion"


async def main() -> None:
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={"width": 1600, "height": 1000})
        page = await ctx.new_page()

        await page.goto(URL)
        await page.wait_for_load_state("networkidle")
        await page.wait_for_timeout(1500)

        # 1. Default view
        await page.screenshot(path=str(OUT / "01_default.png"), full_page=False)

        # 2. Zoom out to regional
        for _ in range(3):
            await page.mouse.wheel(0, 200)
            await page.wait_for_timeout(400)
        await page.screenshot(path=str(OUT / "02_zoom_out.png"))

        # 3. Zoom back in + zoom deep for water check
        for _ in range(6):
            await page.mouse.wheel(0, -200)
            await page.wait_for_timeout(400)
        await page.screenshot(path=str(OUT / "03_zoom_deep.png"))

        # 4. Pan around by dragging to inspect different unit clusters
        box = await page.locator(".leaflet-container").bounding_box()
        if box:
            cx = box["x"] + box["width"] / 2
            cy = box["y"] + box["height"] / 2
            # Drag north-east to see unit placements in coastal areas
            await page.mouse.move(cx, cy)
            await page.mouse.down()
            await page.mouse.move(cx - 300, cy + 200, steps=20)
            await page.mouse.up()
            await page.wait_for_timeout(500)
            await page.screenshot(path=str(OUT / "04_pan_ne.png"))

            await page.mouse.move(cx, cy)
            await page.mouse.down()
            await page.mouse.move(cx + 400, cy - 200, steps=20)
            await page.mouse.up()
            await page.wait_for_timeout(500)
            await page.screenshot(path=str(OUT / "05_pan_sw.png"))

        # 6. Back to default-ish and trigger ThermalHawk
        await page.evaluate(
            """() => {
                const btns = [...document.querySelectorAll('button')];
                const b = btns.find(x => x.innerText.toLowerCase().includes('thermalhawk'));
                if (b) b.click();
            }"""
        )
        await page.wait_for_timeout(2500)
        await page.screenshot(path=str(OUT / "06_thermalhawk_fire.png"))
        await page.wait_for_timeout(3500)
        await page.screenshot(path=str(OUT / "07_thermalhawk_settled.png"))

        # 7. Click a unit dot to see the popup
        await page.evaluate(
            """() => {
                const cm = document.querySelector('.leaflet-interactive');
                if (cm) cm.dispatchEvent(new MouseEvent('click', {bubbles: true}));
            }"""
        )
        await page.wait_for_timeout(700)
        await page.screenshot(path=str(OUT / "08_popup_open.png"))

        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
