# Security Policy — MARLOG

MARLOG is a sibling module of [SPIRE](https://github.com/jeranaias/spire),
built during MDM 2026 by uniformed USMC personnel on duty time. The security
reporting path and responsible disclosure timeline follow SPIRE's policy.

---

## Reporting a vulnerability

**Do NOT open a public GitHub issue for security vulnerabilities.**

Email `jesse@thornveil.ai` (PGP key on request) with:

- A description of the vulnerability and its impact.
- Steps to reproduce against the synthetic seed dataset.
- Affected MARLOG version or `git rev-parse HEAD`.
- Whether you believe a real DoD deployment is at risk.

Acknowledgement within 48 hours. Patch + advisory timeline is usually
7–14 days for high-severity issues.

---

## What we consider in-scope

- **Role/data scoping bypass** — any path that lets a client read or write
  supply data outside its intended scope.
- **API input validation bypass** — any payload that reaches the database
  without passing Zod schema validation.
- **Sync outbox integrity** — any path that silently drops or corrupts a queued
  sync record before it is pushed to MDM.
- **Dependency vulnerabilities** — critical CVEs in MARLOG's direct dependencies
  that have a realistic exploit path in this stack.

---

## What we consider out-of-scope (for now)

- Brute-force or rate-limiting on the `/api/*` endpoints — production
  deployment targets IL5 infrastructure with its own reverse proxy / API
  gateway.
- Synthetic seed data exposure — the dataset is fictitious and contains no PII
  or classified information by design.

---

## Responsible disclosure timeline

1. **Day 0** — Report received, acknowledgement sent.
2. **Day 1–3** — Triage, severity assigned, reproduction confirmed.
3. **Day 4–10** — Patch developed + reviewed.
4. **Day 11–14** — Patched release tagged + advisory drafted.
5. **Day 15+** — Coordinated public disclosure via GitHub Security Advisory.

For a critical issue (active exploitation, audit-chain forgery), the timeline
shortens to 72 hours.

---

## Bug bounty

MARLOG is pre-revenue. No paid bounty today. See SPIRE's `SECURITY.md` for the
broader program posture.

## Point of contact

**Thornveil LLC / SSgt Jesse Morgan, USMC**
jesse@thornveil.ai · (831) 275-8979
