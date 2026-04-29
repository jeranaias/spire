import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DISTRO_EMAIL_PATTERN,
  isValidDistroEmail,
  parseDistroEmails,
  partitionDistroEmails,
  splitDistroTokens,
  validateDistroEmailList,
  validateDistroEmails,
} from "./index";

describe("isValidDistroEmail", () => {
  it.each([
    "user@example.com",
    "first.last@example.co.uk",
    "user+tag@example.io",
    "u@a.b",
    "USER@EXAMPLE.COM",
    "user_name@sub.domain.example",
    "user-name@example-domain.com",
    "123@456.789",
  ])("accepts %s", (email) => {
    expect(isValidDistroEmail(email)).toBe(true);
  });

  it.each([
    "",
    " ",
    "no-at-sign",
    "missing-tld@example",
    "@example.com",
    "user@",
    "user@.com",
    "user@example.",
    "two@@example.com",
    "user@one@two.com",
    "user name@example.com",
    "user@exa mple.com",
    "user@example .com",
    "user@example.com ",
    " user@example.com",
    "user\t@example.com",
    "user@example.com\n",
  ])("rejects %j", (email) => {
    expect(isValidDistroEmail(email)).toBe(false);
  });
});

describe("splitDistroTokens", () => {
  it("returns [] for null/undefined/empty", () => {
    expect(splitDistroTokens(null)).toEqual([]);
    expect(splitDistroTokens(undefined)).toEqual([]);
    expect(splitDistroTokens("")).toEqual([]);
    expect(splitDistroTokens("   \n\t  ")).toEqual([]);
  });

  it("splits on whitespace, commas, and semicolons", () => {
    const raw = "a@x.com, b@y.com;c@z.com\n d@w.com\te@v.com";
    expect(splitDistroTokens(raw)).toEqual([
      "a@x.com",
      "b@y.com",
      "c@z.com",
      "d@w.com",
      "e@v.com",
    ]);
  });

  it("drops empty fragments from repeated delimiters", () => {
    expect(splitDistroTokens(",,a@x.com,;; ;b@y.com,,")).toEqual([
      "a@x.com",
      "b@y.com",
    ]);
  });

  it("does not validate shape — invalid tokens pass through", () => {
    expect(splitDistroTokens("not-an-email, also-bad")).toEqual([
      "not-an-email",
      "also-bad",
    ]);
  });
});

describe("parseDistroEmails", () => {
  it("dedupes case-insensitively while preserving the first occurrence", () => {
    expect(parseDistroEmails("a@x.com, A@X.COM, b@y.com, a@x.com")).toEqual([
      "a@x.com",
      "b@y.com",
    ]);
  });

  it("returns [] for empty / nullish input", () => {
    expect(parseDistroEmails(null)).toEqual([]);
    expect(parseDistroEmails(undefined)).toEqual([]);
    expect(parseDistroEmails("")).toEqual([]);
  });
});

describe("validateDistroEmails (textarea parser)", () => {
  it("returns empty validation for null/undefined/empty input", () => {
    for (const raw of [null, undefined, "", "   \n  "]) {
      const result = validateDistroEmails(raw);
      expect(result).toEqual({
        tokens: [],
        validCount: 0,
        invalidCount: 0,
        validEmails: [],
        invalidEmails: [],
      });
    }
  });

  it("splits on whitespace/comma/semicolon and buckets each token", () => {
    const result = validateDistroEmails(
      "a@x.com, bad-token; b@y.com\nalso-bad\tc@z.com",
    );
    expect(result.tokens).toEqual([
      { value: "a@x.com", valid: true },
      { value: "bad-token", valid: false },
      { value: "b@y.com", valid: true },
      { value: "also-bad", valid: false },
      { value: "c@z.com", valid: true },
    ]);
    expect(result.validEmails).toEqual(["a@x.com", "b@y.com", "c@z.com"]);
    expect(result.invalidEmails).toEqual(["bad-token", "also-bad"]);
    expect(result.validCount).toBe(3);
    expect(result.invalidCount).toBe(2);
  });

  it("dedupes case-insensitively before validating", () => {
    const result = validateDistroEmails("a@x.com, A@X.COM, a@x.com, b@y.com");
    expect(result.tokens.map((t) => t.value)).toEqual(["a@x.com", "b@y.com"]);
    expect(result.validCount).toBe(2);
    expect(result.invalidCount).toBe(0);
  });

  it("counts a duplicate invalid token only once", () => {
    const result = validateDistroEmails("bad, BAD, bad");
    expect(result.tokens).toEqual([{ value: "bad", valid: false }]);
    expect(result.invalidCount).toBe(1);
    expect(result.invalidEmails).toEqual(["bad"]);
  });
});

describe("validateDistroEmailList (stored array variant)", () => {
  it("returns empty validation for null/undefined/empty arrays", () => {
    for (const input of [null, undefined, [], ["", "   "]] as const) {
      const result = validateDistroEmailList(input);
      expect(result).toEqual({
        tokens: [],
        validCount: 0,
        invalidCount: 0,
        validEmails: [],
        invalidEmails: [],
      });
    }
  });

  it("does NOT split on whitespace/comma/semicolon — each element is one entry", () => {
    // A stored entry that smuggles in delimiters must be flagged invalid as a
    // single value, not silently re-split into multiple valid addresses.
    const result = validateDistroEmailList([
      "a@x.com,b@y.com",
      "c@z.com d@w.com",
      "e@v.com;f@u.com",
    ]);
    expect(result.tokens).toEqual([
      { value: "a@x.com,b@y.com", valid: false },
      { value: "c@z.com d@w.com", valid: false },
      { value: "e@v.com;f@u.com", valid: false },
    ]);
    expect(result.validEmails).toEqual([]);
    expect(result.invalidEmails).toEqual([
      "a@x.com,b@y.com",
      "c@z.com d@w.com",
      "e@v.com;f@u.com",
    ]);
  });

  it("trims surrounding whitespace on each entry", () => {
    const result = validateDistroEmailList([
      "  a@x.com  ",
      "\tb@y.com\n",
      "   ",
    ]);
    expect(result.validEmails).toEqual(["a@x.com", "b@y.com"]);
    expect(result.invalidCount).toBe(0);
    expect(result.tokens).toHaveLength(2);
  });

  it("dedupes case-insensitively", () => {
    const result = validateDistroEmailList([
      "a@x.com",
      "A@X.COM",
      " a@x.com ",
      "b@y.com",
    ]);
    expect(result.tokens.map((t) => t.value)).toEqual(["a@x.com", "b@y.com"]);
    expect(result.validCount).toBe(2);
  });

  it("ignores non-string entries defensively", () => {
    const result = validateDistroEmailList([
      "a@x.com",
      // simulate junk that may slip through if a caller bypasses TS
      null as unknown as string,
      undefined as unknown as string,
      42 as unknown as string,
      "b@y.com",
    ]);
    expect(result.validEmails).toEqual(["a@x.com", "b@y.com"]);
    expect(result.invalidCount).toBe(0);
  });
});

describe("partitionDistroEmails", () => {
  it("returns empty buckets for null/undefined/empty input", () => {
    expect(partitionDistroEmails(null)).toEqual({ valid: [], invalid: [] });
    expect(partitionDistroEmails(undefined)).toEqual({
      valid: [],
      invalid: [],
    });
    expect(partitionDistroEmails([])).toEqual({ valid: [], invalid: [] });
  });

  it("trims, dedupes case-insensitively, and partitions in one pass", () => {
    const { valid, invalid } = partitionDistroEmails([
      " a@x.com ",
      "A@X.COM",
      "b@y.com",
      "bad-entry",
      "BAD-ENTRY",
      "  ",
    ]);
    expect(valid).toEqual(["a@x.com", "b@y.com"]);
    expect(invalid).toEqual(["bad-entry"]);
  });

  it("treats stored entries as single values (no re-splitting)", () => {
    const { valid, invalid } = partitionDistroEmails([
      "a@x.com,b@y.com",
      "c@z.com d@w.com",
    ]);
    expect(valid).toEqual([]);
    expect(invalid).toEqual(["a@x.com,b@y.com", "c@z.com d@w.com"]);
  });

  it("ignores non-string entries", () => {
    const { valid, invalid } = partitionDistroEmails([
      "a@x.com",
      null as unknown as string,
      undefined as unknown as string,
      99 as unknown as string,
    ]);
    expect(valid).toEqual(["a@x.com"]);
    expect(invalid).toEqual([]);
  });

  it("uses the shared alreadySeen set to dedupe across buckets (TO/CC/BCC)", () => {
    const seen = new Set<string>();
    const to = partitionDistroEmails(["a@x.com", "b@y.com"], seen);
    const cc = partitionDistroEmails(["A@X.COM", "c@z.com"], seen);
    const bcc = partitionDistroEmails(
      ["b@y.com", "C@Z.COM", "d@w.com"],
      seen,
    );

    expect(to.valid).toEqual(["a@x.com", "b@y.com"]);
    // a@x.com was already in the TO bucket, must be skipped here.
    expect(cc.valid).toEqual(["c@z.com"]);
    // b@y.com (TO) and c@z.com (CC) were already seen, must be skipped here.
    expect(bcc.valid).toEqual(["d@w.com"]);

    // The seen set must contain each address exactly once, lowercased.
    expect([...seen].sort()).toEqual([
      "a@x.com",
      "b@y.com",
      "c@z.com",
      "d@w.com",
    ]);
  });

  it("dedupes invalid entries across buckets too", () => {
    const seen = new Set<string>();
    const first = partitionDistroEmails(["bad-token"], seen);
    const second = partitionDistroEmails(["BAD-TOKEN", "another-bad"], seen);
    expect(first.invalid).toEqual(["bad-token"]);
    expect(second.invalid).toEqual(["another-bad"]);
  });

  it("mutates the provided alreadySeen set in place", () => {
    const seen = new Set<string>(["preexisting@example.com"]);
    partitionDistroEmails(["preexisting@example.com", "new@example.com"], seen);
    expect(seen.has("new@example.com")).toBe(true);
    expect(seen.size).toBe(2);
  });
});

describe("regression: regex stays aligned with OpenAPI distro-email patterns", () => {
  // Read the OpenAPI spec directly (no YAML parser dep needed) and pair every
  // `pattern: ...` entry with the closest enclosing field name. We only
  // assert against patterns that live under a distro-email field (the lib's
  // contract surface), so an unrelated future schema introducing a
  // legitimately different regex won't false-trip this guardrail.
  const here = dirname(fileURLToPath(import.meta.url));
  const openapiPath = resolve(here, "../../api-spec/openapi.yaml");
  const openapiSrc = readFileSync(openapiPath, "utf8");

  // Match field keys at a shallower indent than their pattern entry so we can
  // associate each pattern with its owning field. A "distro-email field" is
  // any property whose name contains "Distro" / "distro" and ends in
  // "Emails" — covers Unit.distroEmails / distroCcEmails / distroBccEmails
  // as well as snapshot-style unitDistroEmails / unitDistroCcEmails / etc.
  const distroFieldRe = /^(\s*)([A-Za-z]*[Dd]istro[A-Za-z]*Emails):\s*$/;
  const patternRe = /^(\s*)pattern:\s*(.+?)\s*$/;

  const distroPatterns: { field: string; raw: string; line: number }[] = [];
  let activeField: { name: string; indent: number } | null = null;

  const lines = openapiSrc.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fieldMatch = line.match(distroFieldRe);
    if (fieldMatch) {
      activeField = { name: fieldMatch[2], indent: fieldMatch[1].length };
      continue;
    }
    // Reset the active distro field once we leave its block (any non-blank
    // line at or below its indent that isn't part of its subtree).
    if (activeField && line.trim() !== "") {
      const indent = line.match(/^(\s*)/)![1].length;
      const fieldKey = line.match(/^\s*[A-Za-z][\w-]*:/);
      if (fieldKey && indent <= activeField.indent) {
        activeField = null;
      }
    }
    const patternMatch = line.match(patternRe);
    if (patternMatch && activeField) {
      distroPatterns.push({
        field: activeField.name,
        raw: patternMatch[2],
        line: i + 1,
      });
    }
  }

  it("OpenAPI spec exposes distro-email pattern entries to compare against", () => {
    // Today there are 3 in Unit, 3 in UnitInput, and 3 in the snapshot
    // schema. Hard-pin a floor so silently dropping them gets caught too.
    expect(distroPatterns.length).toBeGreaterThanOrEqual(9);
  });

  it("every distro-email pattern in the spec uses the DISTRO_EMAIL_PATTERN placeholder", () => {
    // The YAML declares each pattern as the literal token
    // `{{DISTRO_EMAIL_PATTERN}}`; the orval transformer in
    // `lib/api-spec/orval.config.ts` substitutes the canonical
    // `DISTRO_EMAIL_PATTERN.source` at codegen time. The contract this test
    // protects is therefore "every distro-email pattern in the spec is the
    // placeholder, not a hand-copied regex" — the codegen's substitution
    // (covered by `DISTRO_EMAIL_PATTERN source is the documented permissive
    // shape` below) handles the rest.
    const placeholder = "{{DISTRO_EMAIL_PATTERN}}";
    for (const entry of distroPatterns) {
      // YAML quoted strings: `pattern: '{{DISTRO_EMAIL_PATTERN}}'`
      const match = entry.raw.match(/^['"]?(.+?)['"]?$/);
      expect(
        match,
        `could not parse pattern at line ${entry.line}: ${entry.raw}`,
      ).not.toBeNull();
      expect(
        match![1],
        `field ${entry.field} (line ${entry.line}) is not the DISTRO_EMAIL_PATTERN placeholder — hand-copied regexes in openapi.yaml are forbidden, use '${placeholder}' instead`,
      ).toBe(placeholder);
    }
  });

  it("DISTRO_EMAIL_PATTERN source is the documented permissive shape", () => {
    // Pin the exact source so any change here must be intentional and
    // accompanied by a matching OpenAPI update.
    expect(DISTRO_EMAIL_PATTERN.source).toBe("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$");
  });
});
