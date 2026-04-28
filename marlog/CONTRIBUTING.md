# Contributing to MARLOG

MARLOG is a sibling module contributed to
[SPIRE](https://github.com/jeranaias/spire) (MDM 2026 / MARCORLOGCOM AI Forum
Hackathon, 27–30 April 2026). Contribution rules follow SPIRE's conventions
closely. Read `SPIRE/CONTRIBUTING.md` first; this document calls out
MARLOG-specific additions.

---

## What MARLOG is, who owns it

MARLOG was built on government duty time by uniformed USMC personnel during the
MDM 2026 hackathon. Per SPIRE's `LICENSE.md`, MARLOG is a **government work
product**. Contributions made on duty time by USMC contributors are government
property. No Thornveil pre-existing IP is incorporated into MARLOG; the module
is standalone.

If you are unclear whether a contribution changes something inside MARLOG's
boundary or touches SPIRE's core, ask the maintainer in the PR description
before merging.

---

## Filing issues

Use [GitHub Issues](https://github.com/jeranaias/spire/issues/new/choose) on
the SPIRE repo, tagging the issue `module: marlog`. Include:

- The MARLOG version or commit hash.
- Steps to reproduce.
- Expected vs. actual behavior.
- Console output / stack trace if available.

Do not include real government data, PII, or classified information. MARLOG
ships with a synthetic seed dataset; reproduce issues against that.

---

## Pull requests

Branch from the SPIRE `develop` branch. PR back to `develop`. Use the prefix
`marlog/` for your branch name, e.g. `marlog/fix-dos-calculation`.

### Commit style

Match SPIRE's commit tone — imperative, sentence case, ≤ 72 chars:

```
MARLOG: Fix Class V DOS threshold comparison
MARLOG: Add Class IX forecast tracking endpoint
```

- **No AI attribution**, no "Generated with …" trailers, no "Co-Authored-By:"
  lines. The repo enforces this socially via maintainer review.

### Code style

- **Frontend**: TypeScript strict mode. Run `pnpm run typecheck` before PR.
  Use the existing design tokens (navy-black canvas, cyan accent, Space Mono
  headers). Do not introduce new colour primitives.
- **API / scripts**: TypeScript strict mode. Zod for all boundary validation.
  Run `pnpm run build` before PR.
- No emojis in code, comments, or commit messages unless the maintainer
  explicitly asked.

### What gets your PR merged fast

1. Tied to an open issue.
2. ≤ 400 lines of diff (split larger work).
3. `pnpm run build` passes (typecheck + build all packages).
4. `CHANGELOG.md` updated under the `## [Unreleased]` heading.
5. No new dependencies without a one-paragraph justification in the PR
   description (MARLOG targets edge/low-bandwidth environments — every 100 KB
   of dependency matters).

### What gets your PR rejected

- AI attribution anywhere.
- New dependencies without justification.
- UI changes that break existing role-scoped views without explicit test
  coverage.
- Edits to files outside the `marlog/` directory in the SPIRE repo (MARLOG
  PRs are additive to the sibling module only).

---

## Development setup

```bash
# Prerequisites: Node.js 24+, pnpm 9+, PostgreSQL

# Install
pnpm install

# Push DB schema (first time)
pnpm --filter @workspace/db run push

# Seed reference data
pnpm --filter @workspace/scripts run seed

# Run API server
pnpm --filter @workspace/api-server run dev

# Run frontend (separate terminal)
pnpm --filter @workspace/logistics run dev
```

---

## License + IP

See `LICENSE.md`. Short version: MARLOG contributions on duty time are
government work product. Thornveil pre-existing IP is not part of MARLOG;
the Thornveil/SPIRE boundary described in SPIRE's `LICENSE.md` does not
extend into this module.

## Maintainers

- @jeranaias (SSgt Morgan, primary developer + repo maintainer)
