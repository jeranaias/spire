#!/usr/bin/env node
// Design-token sweep — converts inline letter-spacing to Tailwind tracking-*
// utilities backed by --tracking-* tokens.
//
// Approach: this is a JSX-aware transform that walks each file, finds every
// occurrence of `letterSpacing: "X.Yem"` (solo or inside a multi-prop style
// object), determines the JSX element that owns it, and then:
//   1. Removes the letterSpacing key (and the entire style attribute if it
//      becomes empty).
//   2. Appends the tracking-* utility to that element's className attribute.
//
// We use a forward index walk + bracket counter to delineate JSX elements;
// the regex-based approach in the prior version corrupted nested JSX because
// it walked backward across element boundaries. This pass walks the source
// once, builds an array of edits keyed by absolute offset, then applies them
// all in a single right-to-left replace so offsets remain valid.

import { promises as fs } from "node:fs";
import path from "node:path";

const ROOT = "D:/projects/spire/frontend/src";

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

let trackingReplacements = 0;
const filesTouched = new Set();

async function walk(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

// Find the JSX element that owns a given offset (which sits inside a
// style={{...}} attribute). Returns { tagOpen, tagClose } absolute offsets,
// where tagOpen is the position of '<' and tagClose is the position of the
// closing '>' of the OPENING TAG (not the element).
function findEnclosingTag(src, offset) {
  // Walk back from offset to find the '<' that opens our JSX element.
  // Strategy: we know we sit inside a style={{...}} attribute. Walking back,
  // we'll first exit the inner object brace, then exit the outer expression
  // brace, and from there we're inside the JSX opening tag's attribute list,
  // where '<' will be the next non-string, non-brace-balanced char.
  // We use a brace counter that tracks NET balance: every '}' we see on the
  // way back increments, every '{' decrements (and may go negative — that
  // means we've stepped out of an enclosing brace into the tag-attribute
  // region). Once net depth < 0, we're outside the style attribute and any
  // '<' we encounter at this depth is our tag.
  let depth = 0;
  let i = offset;
  while (i > 0) {
    i--;
    const c = src[i];
    if (c === "}") depth++;
    else if (c === "{") depth--;
    else if (c === "<" && depth < 0) {
      const next = src[i + 1];
      if (next && /[A-Za-z]/.test(next)) {
        // Found tag start. Walk forward from just after '<' to find the
        // closing '>' of the opening tag, tracking brace nesting cleanly.
        let j = i + 1;
        let d2 = 0;
        for (; j < src.length; j++) {
          const cc = src[j];
          if (cc === "{") d2++;
          else if (cc === "}") d2--;
          else if (cc === ">" && d2 === 0) {
            return { tagOpen: i, tagClose: j };
          }
        }
        return null;
      }
    }
  }
  return null;
}

// Returns the smallest [start,end) span that fully encloses the
// `letterSpacing: "X"` property and any leading/trailing comma+whitespace
// such that removing the span leaves a syntactically clean object.
function spanForLetterSpacingProp(src, propStart) {
  // propStart points at the 'l' of letterSpacing.
  // Walk forward to end of value (closing quote of the em string).
  const m = /^letterSpacing:\s*"(-?[\d.]+)em"/.exec(src.slice(propStart));
  if (!m) return null;
  const em = m[1];
  let valueEnd = propStart + m[0].length;
  // Look for trailing comma + whitespace
  let end = valueEnd;
  // skip whitespace, then optional comma, then whitespace
  while (end < src.length && /\s/.test(src[end])) end++;
  if (src[end] === ",") {
    end++;
    while (end < src.length && /\s/.test(src[end])) end++;
  }
  // Look for leading whitespace + optional comma
  let start = propStart;
  // step back over any whitespace immediately before propStart
  while (start > 0 && /[ \t]/.test(src[start - 1])) start--;
  // If preceding non-whitespace is a comma, we're a non-leading prop;
  // shrink end back to just-after-value (we'll consume only ourselves).
  // Otherwise we're a leading prop and we consume our trailing comma too.
  // Easier: don't try to be clever — just always use "propStart..end"
  // which covers `letterSpacing: "Xem", ` plus any trailing whitespace.
  // If we're the LAST prop in the object, this leaves a trailing comma on
  // the previous prop, which is valid JS/TS.
  // But it can also produce `, ,` if we're wedged between two commas, since
  // a leading comma was left by another prop. That's invalid. So instead,
  // when preceded by `, ` and followed by another property, drop the leading
  // `, ` instead of the trailing one.
  // Practical approach: examine the char just before propStart (after
  // walking back leading whitespace).
  let beforeIdx = propStart - 1;
  while (beforeIdx >= 0 && /\s/.test(src[beforeIdx])) beforeIdx--;
  const before = beforeIdx >= 0 ? src[beforeIdx] : null;

  let afterIdx = valueEnd;
  while (afterIdx < src.length && /\s/.test(src[afterIdx])) afterIdx++;
  const after = afterIdx < src.length ? src[afterIdx] : null;

  // Cases:
  //   before='{' (or '({{'): this is the FIRST prop. Consume trailing `, `.
  //     start = propStart, end = afterTrailingCommaWS (already computed above)
  //   before=',': this is a SUBSEQUENT prop. Consume leading `, ` but NOT trailing.
  //     start = beforeIdx (position of comma), end = valueEnd
  //   after='}' and we're the only prop: consume nothing extra.
  if (before === ",") {
    start = beforeIdx;
    end = valueEnd;
  } else {
    start = propStart;
    // end already includes trailing comma+ws if present
  }

  return { start, end, em };
}

// In the JSX opening tag span, inject ` ${util}` into the className value.
// Returns [startReplace, endReplace, replacement] OR null if className is
// missing (caller must handle).
function classNameInjection(src, tagOpen, tagClose, util) {
  const tag = src.slice(tagOpen, tagClose + 1);
  // Try className="..."
  let m = /className="([^"]*)"/.exec(tag);
  if (m) {
    const absStart = tagOpen + m.index;
    const absEnd = absStart + m[0].length;
    const newAttr = `className="${m[1]} ${util}"`;
    return { start: absStart, end: absEnd, replacement: newAttr };
  }
  // className={`...`}
  m = /className=\{`([^`]*)`\}/.exec(tag);
  if (m) {
    const absStart = tagOpen + m.index;
    const absEnd = absStart + m[0].length;
    const newAttr = `className={\`${m[1]} ${util}\`}`;
    return { start: absStart, end: absEnd, replacement: newAttr };
  }
  // className={expr}
  m = /className=\{([^}]+)\}/.exec(tag);
  if (m) {
    const absStart = tagOpen + m.index;
    const absEnd = absStart + m[0].length;
    const newAttr = `className={(${m[1]}) + " ${util}"}`;
    return { start: absStart, end: absEnd, replacement: newAttr };
  }
  // className={clsx(...)} / multi-line — fall back to regex with newlines
  m = /className=\{(clsx\([\s\S]*?\))\}/.exec(tag);
  if (m) {
    const absStart = tagOpen + m.index;
    const absEnd = absStart + m[0].length;
    const newAttr = `className={(${m[1]}) + " ${util}"}`;
    return { start: absStart, end: absEnd, replacement: newAttr };
  }
  // No className — inject one right after the tag name.
  m = /^<([A-Za-z][A-Za-z0-9]*)/.exec(tag);
  if (m) {
    const absStart = tagOpen;
    const absEnd = tagOpen + m[0].length;
    const newAttr = `<${m[1]} className="${util}"`;
    return { start: absStart, end: absEnd, replacement: newAttr };
  }
  return null;
}

function processFile(src) {
  const edits = []; // {start, end, replacement}
  const re = /letterSpacing:\s*"(-?[\d.]+)em"/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const propStart = m.index;
    const em = m[1];
    const util = trackingFor(em);
    trackingReplacements++;

    const span = spanForLetterSpacingProp(src, propStart);
    if (!span) continue;

    // Find enclosing JSX tag.
    const tag = findEnclosingTag(src, propStart);
    if (!tag) continue;

    // Edit 1: remove letterSpacing prop.
    edits.push({ start: span.start, end: span.end, replacement: "" });

    // Edit 2: if util is set, inject into className.
    if (util) {
      const inj = classNameInjection(src, tag.tagOpen, tag.tagClose, util);
      if (inj) {
        edits.push(inj);
      }
    }
  }

  if (edits.length === 0) return src;

  // Apply edits right-to-left so earlier offsets remain valid.
  edits.sort((a, b) => b.start - a.start);
  let out = src;
  for (const e of edits) {
    out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  }

  // Cleanup: empty `style={{ }}` and `style={{}}` left behind.
  out = out.replace(/\s*style=\{\{\s*\}\}/g, "");
  // Also clean trailing-comma-only style objects: `style={{ ,}}`
  out = out.replace(/style=\{\{\s*,\s*\}\}/g, "");
  // And `style={{ ,foo: ... }}` (orphan leading comma)
  out = out.replace(/style=\{\{\s*,\s*/g, "style={{ ");
  // And `style={{ foo: ..., , }}` (trailing double comma) - rarer
  out = out.replace(/,\s*,/g, ",");

  return out;
}

async function main() {
  const files = await walk(ROOT);
  for (const f of files) {
    const src = await fs.readFile(f, "utf8");
    const out = processFile(src);
    if (out !== src) {
      filesTouched.add(f);
      await fs.writeFile(f, out, "utf8");
    }
  }
  console.log(JSON.stringify({
    trackingReplacements,
    filesTouched: filesTouched.size,
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
