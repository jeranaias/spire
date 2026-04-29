#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiSpecDir = path.resolve(__dirname, "..");
const root = path.resolve(apiSpecDir, "..", "..");

const targets = [
  path.resolve(root, "lib", "api-client-react", "src", "generated"),
  path.resolve(root, "lib", "api-zod", "src", "generated"),
];

const DISTRO_PATTERN_TOKEN = "{{DISTRO_EMAIL_PATTERN}}";

// Each entry maps a YAML property name to the number of `items.pattern`
// declarations we expect to see for it across openapi.yaml. Pinning the count
// catches the case where someone deletes one occurrence (which would leave the
// remaining one trivially "matching" the lib while the other schema silently
// loses its validation).
//
// - `distro*Emails` are the live address-book fields on a unit. They are
//   declared once in `Unit` and once in `UnitInput`.
// - `unitDistro*Emails` are the per-request snapshot copies of those same
//   address books carried on schedule-request payloads. They are a copy of the
//   live fields, so they are intentionally policed against the *same* canonical
//   regex — if a planner ever tightens one side, both sides need to move
//   together or the snapshot will start rejecting addresses the live unit
//   accepts. They are declared once each in their snapshot schema.
const DISTRO_FIELD_EXPECTED_OCCURRENCES = {
  distroEmails: 2,
  distroCcEmails: 2,
  distroBccEmails: 2,
  unitDistroEmails: 1,
  unitDistroCcEmails: 1,
  unitDistroBccEmails: 1,
};
const DISTRO_FIELDS = Object.keys(DISTRO_FIELD_EXPECTED_OCCURRENCES);

const DISTRO_LIB_PATH = path.resolve(
  root,
  "lib",
  "distro-email",
  "src",
  "index.ts",
);
const OPENAPI_PATH = path.resolve(apiSpecDir, "openapi.yaml");

function extractLibPatternSource() {
  const src = readFileSync(DISTRO_LIB_PATH, "utf8");
  const match = src.match(
    /DISTRO_EMAIL_PATTERN\s*=\s*\/(.+?)\/[gimsuy]*\s*;/,
  );
  if (!match) {
    throw new Error(
      `[codegen:check] Could not find 'DISTRO_EMAIL_PATTERN = /.../;' in ${path.relative(root, DISTRO_LIB_PATH)}.`,
    );
  }
  return match[1];
}

function extractDistroPatternsFromYaml(yaml) {
  // Match each `<field>:` block, then capture its indented body. The body
  // continues while subsequent lines are either blank or indented deeper than
  // the field's own indentation.
  const blockRe = new RegExp(
    String.raw`^( *)(${DISTRO_FIELDS.join("|")}):[^\n]*\n((?:(?:\1 +[^\n]*|[ \t]*)\n)+)`,
    "gm",
  );
  const found = [];
  let m;
  while ((m = blockRe.exec(yaml)) !== null) {
    const field = m[2];
    const body = m[3];
    const patternMatch = body.match(/^\s*pattern:\s*(.+?)\s*$/m);
    if (!patternMatch) continue;
    let raw = patternMatch[1];
    // Strip surrounding YAML quotes (single or double). Both forms appear in
    // the wild and OpenAPI accepts either.
    if (
      (raw.startsWith("'") && raw.endsWith("'")) ||
      (raw.startsWith('"') && raw.endsWith('"'))
    ) {
      raw = raw.slice(1, -1);
    }
    // Compute the line number for a useful error message.
    const offset = m.index + m[0].indexOf(patternMatch[0]);
    const line = yaml.slice(0, offset).split("\n").length;
    found.push({ field, pattern: raw, line });
  }
  return found;
}

// The distro-email regex is now declared exactly once (in lib/distro-email)
// and injected into the OpenAPI spec at codegen time via the orval input
// transformer in `orval.config.ts`. This guard makes sure nobody silently
// re-introduces the duplication by hand-pasting the regex back into the YAML
// — every distro pattern must continue to use the templating token verbatim,
// the raw regex source must not appear anywhere in the spec, and each field
// must still declare its pattern block the expected number of times so a
// silent deletion is caught the same way it was before templating.
function checkDistroEmailPatternTemplating() {
  const yaml = readFileSync(OPENAPI_PATH, "utf8");
  const libSource = extractLibPatternSource();
  const yamlPatterns = extractDistroPatternsFromYaml(yaml);

  const errors = [];

  // (1) The literal regex source must not appear anywhere in openapi.yaml. If
  // it does, someone re-introduced the duplication that this whole pipeline
  // is designed to prevent.
  if (yaml.includes(libSource)) {
    const lines = yaml.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(libSource)) {
        errors.push(
          `  - lib/api-spec/openapi.yaml:${i + 1} contains the literal DISTRO_EMAIL_PATTERN source '${libSource}'; use the '${DISTRO_PATTERN_TOKEN}' token instead so lib/distro-email stays the only place this regex is declared.`,
        );
      }
    }
  }

  // (2) Every distro*Emails / unitDistro*Emails items.pattern block must use
  // the token verbatim. If someone renames the token in openapi.yaml without
  // updating the orval transformer (or vice versa), codegen would silently
  // strip the validation — this catches that.
  for (const { field, pattern, line } of yamlPatterns) {
    if (pattern !== DISTRO_PATTERN_TOKEN) {
      errors.push(
        `  - lib/api-spec/openapi.yaml:${line} '${field}' items.pattern is '${pattern}', expected the templating token '${DISTRO_PATTERN_TOKEN}'.`,
      );
    }
  }

  // (3) Each field must declare its pattern block the expected number of
  // times. Counting — instead of just "appears at least once" — means
  // deleting one occurrence will trip the guard even if the surviving copies
  // are still tokenized correctly.
  for (const field of DISTRO_FIELDS) {
    const expected = DISTRO_FIELD_EXPECTED_OCCURRENCES[field];
    const occurrences = yamlPatterns.filter((p) => p.field === field);
    if (occurrences.length !== expected) {
      const where = field.startsWith("unitDistro")
        ? "one in the schedule-request snapshot schema"
        : "one in Unit, one in UnitInput";
      errors.push(
        `  - lib/api-spec/openapi.yaml: '${field}' has ${occurrences.length} items.pattern entr${occurrences.length === 1 ? "y" : "ies"}, expected ${expected} (${where})`,
      );
    }
  }

  if (errors.length > 0) {
    console.error("");
    console.error(
      "[codegen:check] Distro-email regex is no longer being templated from lib/distro-email:",
    );
    for (const e of errors) console.error(e);
    console.error("");
    console.error(
      `[codegen:check] Replace the literal regex in openapi.yaml with the '${DISTRO_PATTERN_TOKEN}' token; orval.config.ts will substitute the canonical source from lib/distro-email at codegen time.`,
    );
    return false;
  }

  console.log(
    "[codegen:check] Distro-email regex is templated from lib/distro-email into openapi.yaml.",
  );
  return true;
}

function listFilesRecursive(dir) {
  const out = new Map();
  if (!existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        stack.push(full);
      } else {
        const rel = path.relative(dir, full);
        out.set(rel, readFileSync(full));
      }
    }
  }
  return out;
}

function diffDirs(label, before, after) {
  const beforeFiles = listFilesRecursive(before);
  const afterFiles = listFilesRecursive(after);
  const changed = [];
  const added = [];
  const removed = [];
  for (const [rel, beforeBuf] of beforeFiles) {
    const afterBuf = afterFiles.get(rel);
    if (afterBuf === undefined) {
      removed.push(rel);
    } else if (!beforeBuf.equals(afterBuf)) {
      changed.push(rel);
    }
  }
  for (const rel of afterFiles.keys()) {
    if (!beforeFiles.has(rel)) added.push(rel);
  }
  if (changed.length === 0 && added.length === 0 && removed.length === 0) {
    return null;
  }
  return { label, changed, added, removed };
}

const snapshotRoot = mkdtempSync(path.join(tmpdir(), "api-codegen-check-"));
const snapshots = targets.map((target, index) => {
  const snap = path.join(snapshotRoot, String(index));
  if (existsSync(target)) {
    cpSync(target, snap, { recursive: true });
  }
  return { target, snap };
});

let exitCode = 0;
const restoreErrors = [];

if (!checkDistroEmailPatternTemplating()) {
  exitCode = 1;
}

let orvalFailed = false;
try {
  try {
    execFileSync(
      "pnpm",
      ["exec", "orval", "--config", "./orval.config.ts"],
      { cwd: apiSpecDir, stdio: "inherit" },
    );
    // Mirror the post-processing step from the `codegen` package.json
    // script so the diff below sees the *final* generated state. Without
    // this, codegen:check would always flag the integer fields tightened
    // by zod-int-postprocess.mjs as drift.
    execFileSync(
      "node",
      ["./scripts/zod-int-postprocess.mjs"],
      { cwd: apiSpecDir, stdio: "inherit" },
    );
  } catch (err) {
    console.error("\n[codegen:check] orval failed to run.");
    orvalFailed = true;
    exitCode = 1;
  }

  const diffs = [];
  if (!orvalFailed) {
    for (const { target, snap } of snapshots) {
      const label = path.relative(root, target);
      const result = diffDirs(label, snap, target);
      if (result) diffs.push(result);
    }
  }

  if (!orvalFailed && diffs.length > 0) {
    exitCode = 1;
    console.error("");
    console.error(
      "[codegen:check] Generated API client files are out of sync with lib/api-spec/openapi.yaml.",
    );
    for (const d of diffs) {
      console.error(`  - ${d.label}`);
      for (const f of d.changed) console.error(`      changed: ${f}`);
      for (const f of d.added) console.error(`      added:   ${f}`);
      for (const f of d.removed) console.error(`      removed: ${f}`);
    }
    console.error("");
    console.error(
      "[codegen:check] Run 'pnpm --filter @workspace/api-spec run codegen' and commit the updated files.",
    );
  } else if (!orvalFailed) {
    console.log(
      "[codegen:check] Generated API client files are up to date with openapi.yaml.",
    );
  }
} finally {
  for (const { target, snap } of snapshots) {
    try {
      rmSync(target, { recursive: true, force: true });
      if (existsSync(snap)) {
        cpSync(snap, target, { recursive: true });
      }
    } catch (err) {
      restoreErrors.push({ target, err });
    }
  }
  rmSync(snapshotRoot, { recursive: true, force: true });
}

if (restoreErrors.length > 0) {
  console.error("[codegen:check] Failed to restore snapshot for some files:");
  for (const { target, err } of restoreErrors) {
    console.error(`  - ${target}: ${err.message}`);
  }
  process.exit(1);
}

process.exit(exitCode);
