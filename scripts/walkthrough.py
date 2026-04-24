"""Headless walkthrough -- captures text, computed styles, and clickable
elements per view. Acts as our UX-review proxy."""
import json
import os
import sys
from pathlib import Path

os.environ["PYTHONIOENCODING"] = "utf-8"
sys.stdout.reconfigure(encoding="utf-8")

from playwright.sync_api import sync_playwright  # noqa: E402

BASE = "http://localhost:8700"
SHOT_DIR = Path("/tmp/spire_shots")
SHOT_DIR.mkdir(parents=True, exist_ok=True)


def audit(page, label: str):
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.on("console", lambda m: errors.append(f"[{m.type}] {m.text}") if m.type in ("error",) else None)
    return errors


def probe(url, *, name: str, route: str = "", click_selector: str | None = None, wait_for: str | None = None):
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        ctx = b.new_context(viewport={"width": 1600, "height": 1000})
        page = ctx.new_page()
        errors = audit(page, name)
        page.goto(url + route, wait_until="networkidle", timeout=30000)
        if wait_for:
            try:
                page.wait_for_selector(wait_for, timeout=5000)
            except Exception:
                pass
        if click_selector:
            try:
                page.click(click_selector, timeout=3000)
                page.wait_for_load_state("networkidle", timeout=5000)
            except Exception as e:
                errors.append(f"click failed {click_selector}: {e}")

        shot = SHOT_DIR / f"{name}.png"
        page.screenshot(path=str(shot), full_page=False)

        body_text = page.evaluate("document.body.innerText")
        btn_count = page.evaluate("document.querySelectorAll('button').length")
        a_count = page.evaluate("document.querySelectorAll('a').length")
        input_count = page.evaluate("document.querySelectorAll('input, textarea, select').length")
        canvas_count = page.evaluate("document.querySelectorAll('canvas, svg').length")
        bg = page.evaluate("getComputedStyle(document.body).backgroundColor")
        title = page.title()
        b.close()

        return {
            "name": name,
            "title": title,
            "route": route,
            "bg": bg,
            "errors": errors,
            "counts": {
                "buttons": btn_count,
                "links": a_count,
                "inputs": input_count,
                "canvas_svg": canvas_count,
            },
            "shot": str(shot),
            "text_len": len(body_text),
            "text_preview": body_text[:800],
        }


TOURS = [
    {"name": "00_landing", "route": "/"},
    {"name": "01_sentry_upload", "route": "/#/sentry/upload", "wait_for": "text=Data ingestion"},
    {"name": "02_sentry_mark", "route": "/#/sentry/mark"},
    {"name": "03_sentry_export", "route": "/#/sentry/export"},
    {"name": "04_pulse_overview", "route": "/#/pulse/overview", "wait_for": "text=Fleet readiness heatmap"},
    {"name": "05_pulse_risk", "route": "/#/pulse/risk"},
    {"name": "06_pulse_cannib", "route": "/#/pulse/cannib"},
    {"name": "07_pulse_forecast", "route": "/#/pulse/forecast"},
    {"name": "08_bastion_cop", "route": "/#/bastion"},
]


def main():
    results = []
    for tour in TOURS:
        print(f"--- {tour['name']} ---", flush=True)
        try:
            r = probe(BASE, **tour)
        except Exception as e:
            r = {"name": tour["name"], "error": str(e)}
        results.append(r)
        print(json.dumps(
            {
                k: v for k, v in r.items() if k not in ("text_preview",)
            },
            indent=2, ensure_ascii=False,
        ))
        if "text_preview" in r:
            print("  preview:", r["text_preview"][:400].replace("\n", " | "))

    out = SHOT_DIR / "summary.json"
    out.write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nDone. Summary: {out}")


if __name__ == "__main__":
    main()
