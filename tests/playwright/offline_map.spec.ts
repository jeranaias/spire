import { test, expect, request } from "@playwright/test";
import { signIn } from "./_helpers";

const API = process.env.SPIRE_E2E_BASE_URL ?? "http://127.0.0.1:8000";

// WI-1 — the COP must resolve its basemap from the node it is running on,
// and must never silently reach a CDN when the node is enforcing egress.

test("map-config advertises a coherent mode and style origin", async () => {
  const ctx = await request.newContext({ baseURL: API });
  await ctx.post("/api/auth/login", { data: { dodid: "1234567890", pin: "123456" } });

  const resp = await ctx.get("/api/system/map-config");
  expect(resp.status()).toBe(200);
  const cfg = await resp.json();
  expect(["offline", "online", "none"]).toContain(cfg.mode);

  if (cfg.mode === "offline") {
    // Same-origin style, and the archive behind it must answer range reads.
    expect(cfg.style_url).toContain("/map/style.json");
    const style = await ctx.get("/map/style.json");
    expect(style.status()).toBe(200);
    const body = await style.json();
    expect(body.sources.protomaps.url).toContain("pmtiles://");
    expect(JSON.stringify(body)).not.toContain("cartocdn");

    const head = await ctx.get("/map/tiles.pmtiles", { headers: { Range: "bytes=0-15" } });
    expect(head.status()).toBe(206);
  } else if (cfg.mode === "none") {
    expect(cfg.style_url).toBeNull();
    // Nothing to serve, and we say so rather than 500ing.
    expect((await ctx.get("/map/style.json")).status()).toBe(404);
  }
});

test("BASTION canvas renders and honours the advertised mode", async ({ page }) => {
  const external: string[] = [];
  page.on("request", (req) => {
    const url = req.url();
    if (/^https?:\/\//.test(url) && !url.includes("127.0.0.1") && !url.includes("localhost")) {
      external.push(url);
    }
  });

  await signIn(page);
  await page.goto("/#/bastion");
  await expect(page.locator(".maplibregl-map")).toBeVisible({ timeout: 15_000 });

  const cfg = await page.evaluate(async () => {
    const r = await fetch("/api/system/map-config", { credentials: "same-origin" });
    return r.json();
  });

  if (cfg.mode === "none") {
    // Explicit state, not a gray void — and markers still plot on it.
    await expect(page.getByTestId("map-no-basemap")).toBeVisible();
  }
  if (cfg.mode !== "online") {
    expect(external, `unexpected offsite fetch: ${external.join(", ")}`).toEqual([]);
  }
});
