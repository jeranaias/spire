#!/usr/bin/env node
// orval's Zod generator does not translate OpenAPI `type: integer` into
// `.int()` — it emits plain `zod.number()`. For request fields where
// fractional values are physically impossible (headcount, mission days,
// etc.) we tighten the generated schema here so the integer contract is
// enforced at the API boundary without each route handler having to
// overlay its own `.int()` strict variant.
//
// Each entry below names the generated `export const <Schema>` block and
// the integer fields inside it that should gain `.int()`. Add a new entry
// when a new integer field lands in lib/api-spec/openapi.yaml that needs
// to reject fractional values at the API edge.
//
// The transform is idempotent — running it twice is a no-op — and fails
// loudly if the targeted schema or field has shifted, so a future orval
// upgrade or spec rename can never silently strip the validation.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const apiZodFile = path.resolve(
  repoRoot,
  "lib",
  "api-zod",
  "src",
  "generated",
  "api.ts",
);

// (schemaExportName, integerFieldName) — fields that map to OpenAPI
// `type: integer` and should become `.int()` in the emitted Zod.
const INTEGER_FIELDS = [
  // POST /api/units/:unitId/calculate body — headcount and mission-day
  // counts are physically integers. See task #212.
  ["CalculateRequirementsBody", "days"],
  ["CalculateRequirementsBody", "personnel"],
];

function patchSchemaBlock(source, schemaName, field) {
  const blockRe = new RegExp(
    String.raw`(export const ${schemaName} = zod\.object\(\{)([\s\S]*?)(\n\}\);)`,
    "m",
  );
  const blockMatch = source.match(blockRe);
  if (!blockMatch) {
    throw new Error(
      `[zod-int-postprocess] Could not find generated schema 'export const ${schemaName}' in ${path.relative(repoRoot, apiZodFile)}. Has the OpenAPI spec or orval output been renamed?`,
    );
  }
  const [, prefix, body, suffix] = blockMatch;

  const alreadyPatched = new RegExp(
    String.raw`\b${field}: zod\s*\.number\(\)\s*\.int\(\)`,
  );
  if (alreadyPatched.test(body)) {
    return source;
  }

  // Match `<field>: zod` followed (possibly across newlines and
  // whitespace, because orval prettifies long property chains) by
  // `.number()`. Adding `.int()` immediately after `.number()` keeps the
  // rest of the chain (`.min(1)`, `.nullish()`, `.describe(...)`, etc.)
  // intact.
  const fieldRe = new RegExp(
    String.raw`(\b${field}: zod\s*\.number\(\))(?!\s*\.int\(\))`,
  );
  if (!fieldRe.test(body)) {
    throw new Error(
      `[zod-int-postprocess] Could not find '${field}: zod.number()' inside generated schema '${schemaName}'. Has the field been renamed or its type changed in openapi.yaml?`,
    );
  }
  const newBody = body.replace(fieldRe, `$1.int()`);

  return (
    source.slice(0, blockMatch.index) +
    prefix +
    newBody +
    suffix +
    source.slice(blockMatch.index + blockMatch[0].length)
  );
}

function main() {
  let source = readFileSync(apiZodFile, "utf8");
  let patched = 0;
  for (const [schema, field] of INTEGER_FIELDS) {
    const before = source;
    source = patchSchemaBlock(source, schema, field);
    if (source !== before) patched += 1;
  }
  writeFileSync(apiZodFile, source);

  // Re-run prettier on the patched file so the inserted `.int()` calls
  // sit on their own line inside multi-line method chains, matching the
  // formatting orval emits for the rest of the file. Without this the
  // committed output would drift from `prettier --check` and confuse
  // codegen:check.
  execFileSync(
    "pnpm",
    ["exec", "prettier", "--write", apiZodFile],
    { cwd: repoRoot, stdio: "ignore" },
  );

  console.log(
    `[zod-int-postprocess] Tightened ${patched} of ${INTEGER_FIELDS.length} integer field(s) in ${path.relative(repoRoot, apiZodFile)}.`,
  );
}

main();
