# SPIRE on Fly.io — public deploy

You're going from `docker compose up` to `https://spire-mdm.fly.dev` in
about 8 minutes. Fly was picked over the alternatives because:
- Single-Dockerfile deploy (uses `Dockerfile.web` in repo root)
- Free TLS at `*.fly.dev`, custom domain easy
- Persistent volume for the SQLite + audit chain
- `auto_stop_machines = "stop"` keeps cost near $0 when idle —
  cold-starts on first request after sleep
- Per-app secret store for `SPIRE_GITHUB_TOKEN` (way better than `.env`)

Realistic monthly cost: **~$0–3** for the pilot's traffic, since the
machine sleeps when idle and wakes on the first request (~1.5s cold
start). 1GB volume is $0.15/mo. If usage stays this low you're inside
the included free allowance.

## One-time setup

### 1 · Install Fly CLI + log in
```
# Already installed at C:\Users\jesse\.fly\bin\fly.exe
fly auth login   # opens browser, OAuth, done
fly auth whoami  # confirm: jesse@thornveil.ai
```

### 2 · Pick the app name
Fly app names are global. `spire-mdm` is what's wired into
`fly.toml`. If it's taken, edit `fly.toml` and change `app = "..."`.

### 3 · Bootstrap from `D:\projects\spire`
```
cd D:/projects/spire

# Creates the app on Fly without deploying yet (uses fly.toml as-is)
fly launch --no-deploy --copy-config --name spire-mdm --region iad

# Persistent volume for SQLite + audit chain
fly volume create spire_runtime --region iad --size 1 --yes

# Secrets — token + db passphrase + repo target
fly secrets set \
    SPIRE_GITHUB_TOKEN=$(grep ^SPIRE_GITHUB_TOKEN= .env | cut -d= -f2-) \
    SPIRE_GITHUB_REPO=jeranaias/spire \
    SPIRE_DB_PASSPHRASE=$(openssl rand -base64 32)

# First deploy — builds the combined image, uploads, boots a machine
fly deploy
```

### 4 · Verify
```
fly status                     # machine state
fly logs                       # tail combined nginx + uvicorn output
curl https://spire-mdm.fly.dev/healthz
curl https://spire-mdm.fly.dev/api/system/status | jq .dataset
open https://spire-mdm.fly.dev
```

The first request after a long idle period takes ~1.5s while the machine
wakes; subsequent requests are normal latency.

## Subsequent deploys

```
git pull && fly deploy
```

Fly does multi-stage Docker builds remotely on its builder VMs, so your
laptop doesn't need to rebuild — just upload the source and Fly compiles
the image in ~3 minutes.

## What the pilot sees

- **URL**: `https://spire-mdm.fly.dev` (or your custom domain — see below).
- **No login gate**: SPIRE has role *switching* not auth. The data is
  fully synthetic so a public URL is acceptable for the demo + pilot
  cohort. If you want to gate it, layer Cloudflare Access in front (free,
  Google login, ~5 min config) or add Caddy basic-auth on a sidecar.
- **Issue filing**: works identically to local — Shift+F drawer creates
  GitHub issues against `jeranaias/spire`.

## Custom domain (optional)

```
fly certs add spire.thornveil.ai
fly certs check spire.thornveil.ai     # shows DNS record to add
# At your registrar: CNAME spire → spire-mdm.fly.dev
fly certs check spire.thornveil.ai     # verify
```

## Cost guardrails

- `auto_stop_machines = "stop"` and `min_machines_running = 0` mean the
  machine *sleeps* when nobody's using it. That's the line item.
- Monitor with `fly dashboard metrics`.
- Hard cap: `fly scale count 1 --max-per-region 1` keeps Fly from
  scaling out under load.

## Tearing down

```
fly apps destroy spire-mdm   # also removes volumes, certs, secrets
```

## Troubleshooting

**Machine boots but `/api/system/status` 502s**
→ Check `fly logs`. Likely the SQLite path isn't writable. Confirm the
volume mounted: `fly machine list` and `fly ssh console -C "ls -la /opt/spire/runtime"`.

**`fly deploy` hangs on push**
→ Local Docker daemon issue. Set `fly deploy --remote-only` to skip
local Docker entirely; Fly's builders handle everything.

**Cold starts feel slow**
→ Keep at least one machine warm: edit `fly.toml`, set
`min_machines_running = 1`. That bumps cost to ~$3/mo for a 1gb
shared-1x machine.

**SPIRE_GITHUB_TOKEN didn't take**
→ `fly secrets list` (shows existence + sha but not value). Re-set with
`fly secrets set SPIRE_GITHUB_TOKEN=...`. The next request triggers a
machine restart automatically.
