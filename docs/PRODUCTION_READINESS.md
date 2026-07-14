# SPIRE — Production-Readiness & Security-Review Grounding

> **Status:** TRL 4 prototype (1st place, Modern Day Marine 2026). This document
> grounds a MARSOC security review against **NIST SP 800-171 Rev. 3** and
> **FIPS 140-3**, scopes the review surface, and records the gap between what
> SPIRE *markets* and what the shipped default configuration *does*.
>
> **Companion:** [`PRODUCTION_CHECKLIST.md`](./PRODUCTION_CHECKLIST.md) — the
> actionable, trackable checkbox list derived from this report.
>
> _Compiled 2026-07-14 from a full-tree grounding pass (backend, frontend,
> dataset, deploy, CI). Findings are code-grounded with `file:line` anchors._

---

## 1. Bottom line

SPIRE is **honestly above hackathon-grade** on the things that are hardest to
retrofit — the crypto library choice is correct, RBAC is real and server-side,
and the audit hash-chain genuinely works. But it is **not production- or
ATO-ready as it ships by default.** The headline claims ("no-cloud / offline",
"AES-256 at rest", "tamper-evident audit", "CAC auth") are each **half-true**:
the capability exists but is gated behind env flags, mislabeled, or only
partially wired. A MARSOC reviewer will find the gap between the marketing and
the default build quickly.

The work to close that gap is well-scoped and mostly configuration- and
infrastructure-level, not a rewrite.

---

## 2. Repository facts (resolve before handover)

| Fact | Detail | Action |
|---|---|---|
| Local `master` is **41 commits ahead** of `origin/master` | The GitHub remote a reviewer clones is stale | Push, or the review targets old code |
| `rbac-hardening-orphan` branch: **238 commits** never merged | Orphaned hardening work — dead or needed? | Merge or delete; don't leave dangling |
| `marlog/` is a **whole second app** (185 files, ~15.8k LOC) bundled in-repo | Marine Logistics Calculator sibling | Decide scope; carving it out cuts ~16k LOC + one supply chain |
| **Live GitHub PAT** in on-disk `.env` (`github_pat_11BOVF…`) | Gitignored — *not* committed, but a real live credential in the working tree | **Rotate now**, treat as exposed |

---

## 3. Review surface (how many lines MARSOC reviews)

Tracked files: **610**. Language totals (git-tracked, excl. `node_modules`/`.venv`):

| Tier | LOC | Notes |
|---|---:|---|
| **Security-critical core** (auth, CAC, RBAC, at-rest crypto, audit chain, secrets, network monitor, LLM router, export gates) | **~8,000** | The line-by-line, must-read set |
| **SPIRE app, non-test source** (py+tsx+ts, excl. marlog) | **83,522** | The real product |
| ↳ backend Python (non-test) | ~46,500 | routes 15.3k · uis 13.2k · dataset engine 6.9k · core |
| ↳ frontend (tsx+ts, non-test) | ~52,900 | views + components |
| **`marlog/` sibling app** (non-test) | 15,774 | In-scope only if declared |
| **Tests** (py+ts/tsx) | ~16,300 | Reviewers skim, don't line-audit |
| **Infra/config** (Dockerfiles, nginx, CI, `deploy/`, yml/toml/sh) | ~8,400 | Small but security-dense |
| JSON / synthetic data | ~25,000 | Generated; not human-reviewed |

**Numbers to hand the reviewer:**
- **Full auditable source: ~99,300 LOC** (all py+tsx+ts, non-test, incl. marlog).
- **SPIRE-proper (no marlog): ~83,500 LOC.**
- **Deep-scrutiny surface: ~8k core + ~8.4k infra ≈ 16–17k LOC.** The rest is
  application logic the reviewer samples.

---

## 4. What's genuinely strong (credit this)

- **Correct crypto library everywhere:** `pyca/cryptography` (OpenSSL-backed,
  FIPS-*capable*). No `pynacl`/`pycryptodome`, no MD5, no `random` in a security
  path, no custom crypto. The one SHA-1 use (`state.py:153`) is correctly flagged
  `usedforsecurity=False`.
- **Real server-side RBAC:** `scoping.py` re-derives role from the signed session
  and *strips* any client-supplied `?role=` (`auth.py:527-540`). Not cosmetic.
- **Audit hash-chain is real and verified:** `SHA-256(prev || canonical)`,
  `verify_chain()` walks every row and runs on live paths (`persistence.py:343`).
- **Deliberate FIPS self-check module** with a boot-time algorithm allowlist
  (`security_posture.py::assert_fips_safe_config`), a **Vault secrets resolver**
  (`uis/secrets.py`), and strong CSP/security headers on the Fly nginx path.
- **No committed secrets** — trust anchors and signing keys load from env/disk,
  never source. `cac_trust/` ships empty by design.

---

## 5. Findings — ranked (800-171 / FIPS 140-3)

### Blocker-tier (before ATO/handover)

1. **FIPS 140-3 is intent, not fact.** Stock `python:3.12-slim` base ships default
   OpenSSL — **no CAVP-validated module**. Even with `SPIRE_FIPS_MODE=1`, crypto
   doesn't run in a validated boundary. The module's own docstring concedes this
   (`security_posture.py:4-10`). *Controls: 800-171 3.13.11; FIPS 140-3 boundary.*
2. **"AES-256 at rest" is false.** At-rest = **Fernet = AES-128-CBC**
   (`persistence.py:34`), not AES-256, and Fernet is not a validated construction.
   Claim is misreported to operators (`system.py:478,1254`) and `docker-compose.yml`.
   Plus a **hardcoded global KDF salt** (`persistence.py:54`) → same passphrase
   yields the same key on every install. Encryption is **opt-in** (plaintext
   SQLite unless `SPIRE_DB_PASSPHRASE` set). *Controls: 3.13.11, 3.13.16.*
3. **Default auth = any 6-digit PIN.** `SPIRE_AUTH_MODE` defaults to `mock`
   (`cac_auth.py:87`); `POST /api/auth/login` accepts any 6-digit numeric PIN
   (`auth.py:275-278`). The CAC path is genuine scaffolding but ships with an
   **empty trust store**, **one/two-hop chain validation** (no path-length,
   key-usage, name-constraints — `cac_auth.py:366-393`), and **revocation
   defaulting to `skip`** (`cac_auth.py:401-420`). *Controls: 3.5.1, 3.5.2, 3.5.3.*
4. **Ed25519 audit signatures are generated & stored but never verified in
   production.** `verify_entry_signature` (`audit_integrity.py:175`) is only
   called from a unit test; `verify_chain()` ignores signatures. An attacker who
   rewrites the SQLite *and* recomputes the hash chain (all inputs are in the row)
   passes `verify_chain()` cleanly. The **AU-9(5) offline-tamper-evidence claim is
   not actually exercised.** *Controls: 3.3.8, 3.3.9 (AU-9).*
5. **`gcss_export` leaks the entire fleet's SR/parts export** with no role gate
   and no unit scoping (`routes/gcss_export.py`, mounted `main.py:197-198`) — a
   parallel path that bypasses the custodian-only SENTRY export control.
   *Controls: 3.1.1, 3.1.2, 3.1.3.*

### High

6. **"No-cloud / offline" is refuted by default.** Airgap is achievable but not
   shipped: BASTION map **always** pulls tiles from CartoDB's CDN
   (`OkinawaMapCanvas.tsx:31` — no runtime override, needs a code change); the LLM
   router tries the **remote Tailscale RigRun proxy first** (`llm.py:254-289`,
   local Ollama is only fallback); feedback POSTs to `api.github.com`
   (`system.py:1726`). Live `spire-mdm.fly.dev` egresses on every map view and AI
   call. *Controls: 3.1.3, 3.13.1.*
7. **Authorization is not default-deny.** `copilot`, `gcss`, `integrations`,
   `decision_bridge`, `llm` route groups have no role gate; `decision_bridge/audit`
   leaks chain head-hash to any role (`decision_bridge.py:491`); `/api/llm/chat`
   hardcodes `X-Caller-Clearance: UNCLASSIFIED` instead of deriving from the
   session (`llm.py:364`). *Controls: 3.1.1, 3.1.2.*
8. **Containers run as root on unpinned floating base images**; Orin installers
   are `curl | bash` / `curl | sudo bash` with **no checksum verification**
   (`deploy/orin/setup.sh:52,155`, `install_ollama.sh`); field box serves
   **cleartext HTTP on 0.0.0.0** (`spire.service:32`). *Controls: 3.4.1, 3.4.2,
   3.13.8, 3.14.x.*
9. **CI has zero security scanning** — no SAST, no dependency/secret scan
   (explicitly `--no-audit`, `ci.yml:44`), no image signing, mutable `@master`
   action pin (`ci.yml:79`). *Controls: 3.11.2, 3.14.1.*
10. **Egress monitor logs but does not block** — `network_monitor.py:8-11`
    monkey-patches `socket.create_connection` to *audit* only; "air-gap enforced"
    is non-enforcing as shipped.

### Medium / Low

11. Session cookie `Secure` off by default (`auth.py:300`) — transmissible over
    HTTP unless `SPIRE_SESSION_SECURE=1`. *3.13.8.*
12. De-identification hashing is **unsalted, 80-bit-truncated SHA-256**
    (`hashing.py:45`) — a 10-digit EDIPI is brute-forceable in seconds. *3.13.11.*
13. Wildcard CORS `allow_origin_regex=".*"` (`main.py:143`) — mitigated
    (credentials disabled) but STIG-flaggable.
14. `docker-compose` nginx path (`frontend/nginx.conf`) ships **no** security
    headers — the documented air-gap deploy path has no browser hardening.
15. Ed25519/EdDSA is approved only under **FIPS 186-5**; many validated providers
    still reject it — have an ECDSA/RSA fallback ready for a strict validated-module
    review.
16. Dependencies floor-pinned (`>=`/`^`), not exact; `uv.lock` exists but is
    **consumed by no build path** (dead lockfile); `pandas` floor inconsistent
    (`pyproject.toml:11` vs `dataset/requirements.txt:2`).
17. `system_boot` audit events never log — `_maybe_log_boot` queries a
    non-existent table `audit_chain` (should be `audit_log`), the error is
    swallowed (`persistence.py:1017`). Audit-completeness gap.
18. Chain-head pin consistency check only detects **shrinkage**, not equal-length
    in-place rewrites (`audit_integrity.py:320`); audit-write failures are silently
    swallowed across gates.

---

## 6. Streamlining opportunities (shrink the review, no product loss)

- **Carve `marlog/` into its own repo** → −16k LOC and one entire
  `package.json`/lockfile supply chain off the SPIRE review.
- **Delete the unused `uv.lock`** (or make builds consume it) — a lockfile nothing
  reads is worse than none.
- **Delete the scrapped About + Transition pages** (already flagged for removal in
  the session handoff).
- Remove the tracked `test-results/.last-run.json` (playwright churn artifact) from
  version control.

---

## 7. NIST SP 800-171 coverage snapshot

| Family | State | Evidence |
|---|---|---|
| 3.1 Access Control | **Partial** | Real RBAC, but not default-deny; `gcss_export`/`llm`/`decision_bridge` gaps |
| 3.3 Audit & Accountability | **Partial** | Hash-chain verified; signatures unverified; `system_boot` not logged |
| 3.4 Config Management | **Weak** | Root containers, unpinned images, no SBOM |
| 3.5 Identification & Auth | **Weak (default)** | Mock PIN default; CAC scaffold incomplete (revocation/chain) |
| 3.11 Risk Assessment | **Weak** | No SAST/dependency/secret scanning in CI |
| 3.13 System & Comms Protection | **Partial** | AES-128 (mislabeled 256), Secure-cookie opt-in, egress by default |
| 3.14 System Integrity | **Weak** | `curl\|bash` installers, no image scanning |

---

*See [`PRODUCTION_CHECKLIST.md`](./PRODUCTION_CHECKLIST.md) for the actionable
remediation tracker.*
