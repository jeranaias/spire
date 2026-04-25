import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

OUT = Path("D:/projects/spire/tmp/bastion_schematic")


async def main() -> None:
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={"width": 1600, "height": 1000})
        page = await ctx.new_page()
        await page.goto("http://127.0.0.1:8700/#/sentry/upload")
        await page.wait_for_load_state("networkidle")
        await page.wait_for_timeout(1500)
        # Switch role to data_custodian
        await page.select_option("select", "data_custodian")
        await page.wait_for_timeout(1500)
        await page.goto("http://127.0.0.1:8700/#/sentry/review")
        await page.wait_for_load_state("networkidle")
        await page.wait_for_timeout(4500)
        await page.screenshot(path=str(OUT / "p3_review_custodian.png"))

        await page.goto("http://127.0.0.1:8700/#/sentry/mark")
        await page.wait_for_load_state("networkidle")
        await page.wait_for_timeout(1500)
        await page.screenshot(path=str(OUT / "p3_mark_custodian.png"))

        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
