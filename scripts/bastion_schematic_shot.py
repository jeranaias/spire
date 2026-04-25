"""Screenshot the new schematic view across states."""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

OUT = Path("D:/projects/spire/tmp/bastion_schematic")
OUT.mkdir(parents=True, exist_ok=True)


async def main() -> None:
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={"width": 1600, "height": 1000})
        page = await ctx.new_page()
        await page.goto("http://127.0.0.1:8700/#/bastion")
        await page.wait_for_load_state("networkidle")
        await page.wait_for_timeout(2000)

        # 1. Default
        await page.screenshot(path=str(OUT / "01_default.png"))

        # 2. Hover a building to show info card
        svg = page.locator("svg").first
        box = await svg.bounding_box()
        if box:
            cx = box["x"] + box["width"] / 2
            cy = box["y"] + box["height"] / 2
            await page.mouse.move(cx - 200, cy)
            await page.wait_for_timeout(400)
            await page.screenshot(path=str(OUT / "02_hover.png"))

            # 3. Zoom in via + button a few times
            for _ in range(4):
                await page.click('button[title="Zoom in (+)"]')
                await page.wait_for_timeout(250)
            await page.screenshot(path=str(OUT / "03_zoomed.png"))

            # Reset
            await page.click('button[title="Reset view (0)"]')
            await page.wait_for_timeout(500)

        # 4. Click a unit marker — pick by text search for "CLB-6" or similar
        await page.evaluate(
            """() => {
                const els = [...document.querySelectorAll('g')];
                for (const g of els) {
                    const t = g.querySelector('text');
                    if (t && /CLB-6|CLB6/.test(t.textContent || '')) {
                        g.dispatchEvent(new MouseEvent('click', {bubbles: true}));
                        return true;
                    }
                }
                return false;
            }"""
        )
        await page.wait_for_timeout(600)
        await page.screenshot(path=str(OUT / "04_unit_selected.png"))

        # 5. Trigger ThermalHawk
        await page.evaluate(
            """() => {
                const btns = [...document.querySelectorAll('button')];
                const b = btns.find(x => /simulate.*thermalhawk/i.test(x.textContent || ''));
                if (b) b.click();
            }"""
        )
        await page.wait_for_timeout(1800)
        await page.screenshot(path=str(OUT / "05_thermalhawk_mid.png"))
        await page.wait_for_timeout(2500)
        await page.screenshot(path=str(OUT / "06_thermalhawk_settled.png"))

        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
