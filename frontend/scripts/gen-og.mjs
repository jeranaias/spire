// Generate frontend/public/og.png — 1200x630 brand placeholder.
// Run: node scripts/gen-og.mjs
//
// Renders a CAPCO-banner + SPIRE wordmark + tagline, matching the
// static-hero block in index.html. Saved as same-origin og.png so the
// og:image tag never round-trips off our nginx.

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(__dirname, "..", "public", "og.png");

const html = `<!doctype html>
<html><head><meta charset="utf-8" /><style>
  html, body { margin:0; padding:0; width:1200px; height:630px; background:#0a0c13; color:#e5e7eb; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  .capco { height:48px; display:flex; align-items:center; justify-content:space-between; padding:0 32px; background:#007A33; color:#fff; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size:18px; font-weight:600; letter-spacing:0.18em; text-transform:uppercase; }
  .capco .fpcon { border:1px solid rgba(255,255,255,0.55); background:rgba(0,0,0,0.25); padding:4px 14px; border-radius:3px; font-size:16px; }
  .body { height: calc(100% - 48px); display:flex; flex-direction:column; justify-content:center; padding:0 80px; gap:28px; position:relative; }
  .body::after { content:""; position:absolute; right:80px; bottom:60px; width:280px; height:280px; border-radius:50%; background:radial-gradient(circle, rgba(59,130,246,0.18) 0%, rgba(59,130,246,0) 70%); pointer-events:none; }
  .wordmark { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size:128px; font-weight:600; letter-spacing:0.32em; color:#e5e7eb; line-height:1; }
  .tagline { font-size:32px; letter-spacing:0.08em; color:#cbd5e1; max-width:900px; line-height:1.3; }
  .meta { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size:18px; letter-spacing:0.18em; text-transform:uppercase; color:#6b7280; display:flex; gap:24px; }
  .meta .accent { color:#3b82f6; }
  .grid { position:absolute; inset:48px 0 0 0; background-image: linear-gradient(rgba(59,130,246,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(59,130,246,0.04) 1px, transparent 1px); background-size: 24px 24px; pointer-events:none; }
</style></head>
<body>
  <div class="capco"><span>UNCLASSIFIED // SYNTHETIC DATA // FOR DEMONSTRATION ONLY</span><span class="fpcon">FPCON BRAVO</span></div>
  <div class="grid"></div>
  <div class="body">
    <div class="wordmark">SPIRE</div>
    <div class="tagline">Contested Logistics Operating System for the USMC. Local-first, no cloud, IL5-fit. Built by Marines.</div>
    <div class="meta"><span class="accent">SENTRY</span><span class="accent">PULSE</span><span class="accent">BASTION</span><span>spire-mdm.fly.dev</span></div>
  </div>
</body></html>`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.setContent(html, { waitUntil: "load" });
await page.screenshot({ path: out, type: "png", fullPage: false, clip: { x: 0, y: 0, width: 1200, height: 630 } });
await browser.close();
console.log(`og.png written: ${out}`);
