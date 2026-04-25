"""Second pass — zoom out to regional scale to verify water vs land."""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

OUT = Path("D:/projects/spire/tmp/bastion_review")


async def main() -> None:
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={"width": 1600, "height": 1000})
        page = await ctx.new_page()
        await page.goto("http://127.0.0.1:8700/#/bastion")
        await page.wait_for_load_state("networkidle")
        await page.wait_for_timeout(1500)

        # Zoom out by clicking on the leaflet container and pressing "-"
        # which is the Leaflet default zoom-out keybind
        map_el = page.locator(".leaflet-container").first
        await map_el.click(position={"x": 700, "y": 400})
        for _ in range(4):
            await page.keyboard.press("Minus")
            await page.wait_for_timeout(400)
        await page.screenshot(path=str(OUT / "09_zoom_out_regional.png"))

        # Zoom to deep (street level) to see tile clarity
        for _ in range(7):
            await page.keyboard.press("Equal")  # "+" key
            await page.wait_for_timeout(400)
        await page.screenshot(path=str(OUT / "10_zoom_deep.png"))

        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
