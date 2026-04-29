/**
 * Single source of truth for the distribution-list email-shape rule used by
 * MARLOG. The same regex and per-entry semantics gate the API
 * (`/units` save), the unit edit/detail UI, the schedule mailto: pipeline,
 * and the offline audit script — keep them in lockstep by importing from
 * this lib instead of re-declaring the pattern.
 *
 * The pattern is intentionally permissive (no full RFC 5322 compliance). The
 * OpenAPI spec (`lib/api-spec/openapi.yaml`) declares each `distro*Emails`
 * items.pattern as the templating token `{{DISTRO_EMAIL_PATTERN}}`; the orval
 * input transformer in `lib/api-spec/orval.config.ts` reads this constant and
 * substitutes the source string before generating the React Query / Zod
 * clients, so editing the regex here automatically updates both sides — no
 * second copy to maintain.
 */
export const DISTRO_EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export interface DistroEmailToken {
  value: string;
  valid: boolean;
}

export interface DistroEmailValidation {
  tokens: DistroEmailToken[];
  validCount: number;
  invalidCount: number;
  validEmails: string[];
  invalidEmails: string[];
}

export interface DistroEmailPartition {
  valid: string[];
  invalid: string[];
}

export function isValidDistroEmail(value: string): boolean {
  return DISTRO_EMAIL_PATTERN.test(value);
}

/**
 * Split a free-form textarea string on whitespace, commas, or semicolons,
 * dropping empty fragments. Used for parsing user input where one field may
 * contain a delimited list of addresses.
 */
export function splitDistroTokens(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(/[\s,;]+/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    out.push(trimmed);
  }
  return out;
}

function dedupePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/**
 * Parse a free-form textarea string into a deduped list of tokens. Does not
 * validate email shape — pair with {@link isValidDistroEmail} or
 * {@link validateDistroEmails} when you need that.
 */
export function parseDistroEmails(raw: string | undefined | null): string[] {
  return dedupePreserveOrder(splitDistroTokens(raw));
}

/**
 * Validate a free-form textarea string (whitespace/comma/semicolon-delimited).
 * Use this for the unit edit form where users type or paste a list.
 */
export function validateDistroEmails(
  raw: string | undefined | null,
): DistroEmailValidation {
  return buildValidation(dedupePreserveOrder(splitDistroTokens(raw)));
}

/**
 * Validate a stored distribution-list array (one address per element) using
 * the exact same per-entry semantics as the API's normalize step and the
 * mailto: pipeline's partition step — i.e. each element is trimmed + deduped
 * + regex-tested as a single value, **without** any additional whitespace /
 * comma / semicolon splitting.
 *
 * Use this when the input already comes from the database (where a malformed
 * entry like `"a@x.com,b@y.com"` should be flagged as one invalid value, not
 * split into two valid ones). Use {@link validateDistroEmails} for textarea
 * input where users may type or paste delimited lists.
 */
export function validateDistroEmailList(
  values: readonly string[] | null | undefined,
): DistroEmailValidation {
  const cleaned: string[] = [];
  for (const raw of values ?? []) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    cleaned.push(trimmed);
  }
  return buildValidation(dedupePreserveOrder(cleaned));
}

/**
 * Trim, dedupe (case-insensitive), and partition a stored address array into
 * valid and invalid buckets. Pass an `alreadySeen` set to dedupe across
 * multiple buckets — e.g. so an address that appears in TO is not also
 * emitted in CC. The set is mutated in place.
 */
export function partitionDistroEmails(
  values: readonly string[] | null | undefined,
  alreadySeen: Set<string> = new Set(),
): DistroEmailPartition {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const raw of values ?? []) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (alreadySeen.has(key)) continue;
    alreadySeen.add(key);
    if (DISTRO_EMAIL_PATTERN.test(trimmed)) {
      valid.push(trimmed);
    } else {
      invalid.push(trimmed);
    }
  }
  return { valid, invalid };
}

function buildValidation(unique: string[]): DistroEmailValidation {
  const tokens: DistroEmailToken[] = unique.map((value) => ({
    value,
    valid: isValidDistroEmail(value),
  }));
  const validEmails: string[] = [];
  const invalidEmails: string[] = [];
  for (const token of tokens) {
    if (token.valid) validEmails.push(token.value);
    else invalidEmails.push(token.value);
  }
  return {
    tokens,
    validCount: validEmails.length,
    invalidCount: invalidEmails.length,
    validEmails,
    invalidEmails,
  };
}
