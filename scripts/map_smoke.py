"""Quick smoke screenshot of the new MapCanvas BASTION view."""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

OUT = Path("D:/projects/spire/tmp/bastion_schematic")


async def main() -> None:
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={"width": 1600, "height": 1000})
        page = await ctx.new_page()
        await page.goto("http://127.0.0.1:8700/#/bastion")
        await page.wait_for_load_state("networkidle")
        # Wait for tiles to fetch and render
        await page.wait_for_timeout(4500)
        await page.screenshot(path=str(OUT / "map_default.png"))

        # Trigger ThermalHawk
        await page.evaluate(
            """() => {
                const btns = [...document.querySelectorAll('button')];
                const b = btns.find(x => /simulate.*thermalhawk/i.test(x.textContent || ''));
                if (b) b.click();
            }"""
        )
        await page.wait_for_timeout(3500)
        await page.screenshot(path=str(OUT / "map_thermalhawk.png"))

        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
