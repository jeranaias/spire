# SPIRE CAC trust anchors

Drop PEM-encoded DoD root + intermediate CA certificates here. Production
deployments populate this directory with the official DoD PKI bundle
(DoD Root CA 3, DoD Root CA 5, DoD ID CA-N intermediates, etc.). The
default ship is empty — `SPIRE_AUTH_MODE=cac` will refuse every cert
until at least one trust anchor is present.

## File rules

- Anything under `*.pem`, `*.crt`, or `*.cer` is loaded.
- A single file may contain multiple PEM blocks (the standard DoD bundle
  pattern); every block is parsed independently.
- Subdirectories are walked recursively, so you can mirror the DoD bundle
  layout if you prefer.

## Override

Set `SPIRE_CAC_TRUST_DIR=/etc/spire/cac_trust` to load from a managed
directory outside the repo. The cache is keyed on the resolved path and
refreshes automatically when the env var changes.

## Test fixtures

Tests under `tests/test_cac_auth.py` generate their own short-lived CA
chain via `cryptography.hazmat` and inject it into the trust cache via
`set_trust_anchors_for_testing()` — they do not consume this directory.
