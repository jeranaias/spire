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

        await page.goto("http://127.0.0.1:8700/#/pulse/overview")
        await page.wait_for_load_state("networkidle")
        await page.wait_for_timeout(1500)
        await page.screenshot(path=str(OUT / "p4_fleet.png"))

        await page.goto("http://127.0.0.1:8700/#/pulse/risk")
        await page.wait_for_load_state("networkidle")
        await page.wait_for_timeout(4000)
        await page.screenshot(path=str(OUT / "p4_risk.png"))

        await page.goto("http://127.0.0.1:8700/#/pulse/cannib")
        await page.wait_for_load_state("networkidle")
        await page.wait_for_timeout(3500)
        await page.screenshot(path=str(OUT / "p4_cannib.png"))

        await page.goto("http://127.0.0.1:8700/#/pulse/forecast")
        await page.wait_for_load_state("networkidle")
        await page.wait_for_timeout(5000)
        await page.screenshot(path=str(OUT / "p4_forecast.png"))

        await page.goto("http://127.0.0.1:8700/#/sentry/review")
        await page.wait_for_load_state("networkidle")
        await page.wait_for_timeout(2500)
        await page.screenshot(path=str(OUT / "p3_review.png"))

        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
