#!/usr/bin/env node
// Design-token sweep — converts ad-hoc font sizes and inline letter-spacing
// to Tailwind utilities backed by --text-* / --tracking-* tokens.
//
// Per the PRE_MDM_EXECUTION_PLAN, sub-10px text is bumped one tier to clear
// WCAG 2.2 AA at 4.5:1; mono data-display sizes are kept where intentional.

import { promises as fs } from "node:fs";
import path from "node:path";

const ROOT = "D:/projects/spire/frontend/src";

// -------- font-size mapping --------
// 8/9 → text-xs (one-tier bump out of WCAG-fail zone)
// 10/11 → text-xs / text-sm
// 12/13 → text-base
// 14/15 → text-lg
// 17/22 → text-xl
// 26+ → text-2xl
// 16 (one-off, between 15/17) → text-lg (closer to 15px tier)
// 18/20 (between 15 and 22) → text-xl (the 22px tier covers 17..22 per the spec)
const FONT_SIZE_MAP = {
  8: "text-xs",
  9: "text-xs",
  10: "text-xs",
  11: "text-sm",
  12: "text-base",
  13: "text-base",
  14: "text-lg",
  15: "text-lg",
  16: "text-lg",
  17: "text-xl",
  18: "text-xl",
  20: "text-xl",
  22: "text-xl",
};

// -------- tracking mapping --------
// per-spec; values not listed (e.g. 0.05em) are bucketed by nearest:
//   ≤ -0.02 → tracking-tight
//   -0.019..0.029 → tracking-normal (omit; we still emit utility for explicit cases <0)
//   0.03..0.09 → tracking-wide
//   0.10..0.16 → tracking-wider
//   0.17..0.99 → tracking-widest
function trackingFor(emValue) {
  const v = Number(emValue);
  if (Number.isNaN(v)) return null;
  if (v <= -0.02) return "tracking-tight";
  if (v >= -0.019 && v <= 0.029) return null; // omit (normal)
  if (v >= 0.03 && v < 0.10) return "tracking-wide";
  if (v >= 0.10 && v < 0.17) return "tracking-wider";
  if (v >= 0.17) return "tracking-widest";
  return null;
}

let fontReplacements = 0;
let trackingReplacements = 0;
const filesTouched = new Set();

async function walk(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (/\.(tsx|ts)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function replaceFontSizes(src) {
  // Only target text-[Npx] inside class/className strings. Pattern is
  // unambiguous so we can do it globally.
  return src.replace(/text-\[(\d+)px\]/g, (m, n) => {
    const tier = FONT_SIZE_MAP[Number(n)];
    if (!tier) return m;
    fontReplacements++;
    return tier;
  });
}

// ------- inline letterSpacing replacement -------
// Two passes: solo `style={{ letterSpacing: "X" }}` (drop entire style),
// then mixed `style={{ ..., letterSpacing: "X", ... }}` (drop just the prop).
// In both, append the right tracking-* utility to the className on the same JSX
// element. We rely on JSX style being a single object literal on one line, which
// is the consistent shape across the codebase (verified via grep).
function replaceInlineLetterSpacing(src, file) {
  // 1) Solo style: matches whole `style={{ letterSpacing: "X.Yem" }}`
  //    and any preceding whitespace.
  src = src.replace(
    /(\s+)style=\{\{\s*letterSpacing:\s*"(-?[\d.]+)em"\s*\}\}/g,
    (whole, ws, em) => {
      const util = trackingFor(em);
      trackingReplacements++;
      if (!util) return ""; // tracking-normal → drop the style entirely, no class needed
      return `__TRACK_INJECT__${util}__END__`;
    },
  );

  // 2) Mixed style: keep other props, drop letterSpacing.
  //    Handles both leading and trailing positions inside the object.
  //    Pattern: letterSpacing: "...", | , letterSpacing: "..."
  src = src.replace(
    /letterSpacing:\s*"(-?[\d.]+)em"\s*,\s*/g,
    (whole, em) => {
      const util = trackingFor(em);
      trackingReplacements++;
      return util ? `__TRACK_MIXED__${util}__END__` : "";
    },
  );
  src = src.replace(
    /,\s*letterSpacing:\s*"(-?[\d.]+)em"\s*/g,
    (whole, em) => {
      const util = trackingFor(em);
      trackingReplacements++;
      return util ? `__TRACK_MIXED__${util}__END__` : "";
    },
  );
  // Bare-only-prop fallback (already handled by case 1, but if some syntax skipped)
  src = src.replace(
    /letterSpacing:\s*"(-?[\d.]+)em"\s*/g,
    (whole, em) => {
      const util = trackingFor(em);
      trackingReplacements++;
      return util ? `__TRACK_MIXED__${util}__END__` : "";
    },
  );

  // Now we need to inject the tracking-* utility into the className on the
  // same JSX element. The marker we emitted sits where the style attribute
  // was; for solo we removed `style=` entirely, for mixed we left `style={{
  // ...other }}` with our marker inside it. We'll handle them differently:
  //
  //   __TRACK_INJECT__cls__END__  → removed entire style; need to add cls to className on same element
  //   __TRACK_MIXED__cls__END__   → marker still inside a style={{}}, need to add cls to className AND remove the marker

  // Helper: given a JSX element span containing one of our markers, inject
  // the class into className and strip the marker.
  // We'll process line-by-line within JSX-element scope. A simpler robust
  // approach: find each marker, walk backward to the nearest className= on the
  // same element, and inject. JSX elements end at `>` or `/>`, but className
  // and style usually live on the same element.

  function injectClasses(source, markerRe) {
    return source.replace(markerRe, (full, util, offset, fullStr) => {
      // Find the JSX element bounds: scan backward to find the opening `<Foo`
      // and forward to find the closing `>` of the same opening tag.
      let i = offset;
      // walk back to find '<' that opens a JSX element (not a comparison)
      let openIdx = -1;
      while (i > 0) {
        i--;
        if (fullStr[i] === ">") break; // we hit the previous element close, stop
        if (fullStr[i] === "<") {
          openIdx = i;
          break;
        }
      }
      // walk forward to find the matching '>'
      let closeIdx = -1;
      let depth = 0;
      for (let j = offset; j < fullStr.length; j++) {
        const c = fullStr[j];
        if (c === "{") depth++;
        else if (c === "}") depth--;
        else if (c === ">" && depth === 0) {
          closeIdx = j;
          break;
        }
      }
      if (openIdx < 0 || closeIdx < 0) return ""; // give up — strip marker
      return ""; // placeholder; we replace in second pass
    });
  }

  // Simpler approach: do the injection in-place per-marker via index walk.
  function processMarkers(source) {
    const MARKER_RE = /__TRACK_(INJECT|MIXED)__([a-z-]+)__END__/g;
    let result = "";
    let lastIdx = 0;
    let m;
    while ((m = MARKER_RE.exec(source)) !== null) {
      const kind = m[1];
      const util = m[2];
      const markerStart = m.index;
      const markerEnd = m.index + m[0].length;

      // Append everything up to marker (we'll mutate this region for className)
      // First, find the JSX element bounds for this marker.
      let openIdx = -1;
      for (let i = markerStart - 1; i >= 0; i--) {
        const c = source[i];
        if (c === "<") {
          // Make sure it's a JSX tag start (followed by a letter or capital)
          const next = source[i + 1];
          if (next && /[A-Za-z]/.test(next)) {
            openIdx = i;
            break;
          }
        }
      }
      let closeIdx = -1;
      {
        let depth = 0;
        for (let j = markerStart; j < source.length; j++) {
          const c = source[j];
          if (c === "{") depth++;
          else if (c === "}") depth--;
          else if (c === ">" && depth === 0) {
            // make sure not a `/>` that we want to include
            closeIdx = j;
            break;
          }
        }
      }
      if (openIdx < 0 || closeIdx < 0) {
        // give up: just strip marker
        result += source.slice(lastIdx, markerStart);
        lastIdx = markerEnd;
        continue;
      }

      // Build the new element body: take source[openIdx..closeIdx], inject class.
      const elem = source.slice(openIdx, closeIdx + 1);
      // Strip marker from elem
      let elemStripped = elem.replace(m[0], "");
      // Inject util into className. If className=" " exists, append.
      // Handle className="..." and className={`...`} and className={cn(...)} — but
      // safest path: append a new class to the literal string if found, otherwise
      // wrap with an additional space-joined string.
      let injected = false;
      // className="..."
      elemStripped = elemStripped.replace(
        /(className=")([^"]*)(")/,
        (whole, a, body, c) => {
          injected = true;
          return `${a}${body} ${util}${c}`;
        },
      );
      if (!injected) {
        // className={`...`}
        elemStripped = elemStripped.replace(
          /(className=\{`)([^`]*)(`\})/,
          (whole, a, body, c) => {
            injected = true;
            return `${a}${body} ${util}${c}`;
          },
        );
      }
      if (!injected) {
        // className={...} dynamic — append `+ " util"`
        elemStripped = elemStripped.replace(
          /className=\{([^}]+)\}/,
          (whole, expr) => {
            injected = true;
            return `className={(${expr}) + " ${util}"}`;
          },
        );
      }
      if (!injected) {
        // No className at all — add one right after the tag name.
        elemStripped = elemStripped.replace(
          /^<([A-Za-z][A-Za-z0-9]*)/,
          (whole, tag) => `<${tag} className="${util}"`,
        );
        injected = true;
      }

      // Also: if we left `style={{}}` empty after pulling letterSpacing, drop it.
      elemStripped = elemStripped.replace(
        /\s*style=\{\{\s*\}\}/g,
        "",
      );

      result += source.slice(lastIdx, openIdx) + elemStripped;
      lastIdx = closeIdx + 1;
    }
    result += source.slice(lastIdx);
    return result;
  }

  return processMarkers(src);
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] || "all"; // "fonts" | "tracking" | "all"
  const files = await walk(ROOT);

  for (const f of files) {
    let src = await fs.readFile(f, "utf8");
    const before = src;
    if (mode === "fonts" || mode === "all") {
      src = replaceFontSizes(src);
    }
    if (mode === "tracking" || mode === "all") {
      src = replaceInlineLetterSpacing(src, f);
    }
    if (src !== before) {
      filesTouched.add(f);
      await fs.writeFile(f, src, "utf8");
    }
  }

  console.log(JSON.stringify({
    mode,
    fontReplacements,
    trackingReplacements,
    filesTouched: filesTouched.size,
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
