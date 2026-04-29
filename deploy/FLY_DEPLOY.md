# MARLOG — Fly.io deployment

This document covers MARLOG's slice of the SPIRE Fly.io deployment. SPIRE
maintainers should read SPIRE's main `deploy/FLY_DEPLOY.md` first; the steps
below add MARLOG alongside the existing SPIRE backend.

---

## Layout

| File                   | Purpose                                                        |
|------------------------|----------------------------------------------------------------|
| `Dockerfile`           | Multi-stage build with `marlog-api` and `marlog-web` targets.  |
| `.dockerignore`        | Keeps build context lean (no `node_modules`, `dist`, `.git`).  |
| `docker-compose.yml`   | Local stand-up: `marlog-api`, `marlog-web`, `marlog-db`.       |
| `deploy/nginx.conf`    | nginx config baked into the `marlog-web` image.                |
| `fly.marlog.toml`      | Fly.io config for the `marlog-api` app (companion to `fly.toml`). |
| `fly.marlog-web.toml`  | Fly.io config for the `marlog-web` (nginx) app.                |
| `.github/workflows/ci.yml` | Typechecks, builds, and builds both Docker images.         |

The two Fly apps in this stack are:

- **`marlog-api`** — Node 24 Express API, port 3000, talks to Postgres.
- **`marlog-web`** — nginx serving the Vite SPA, port 80, proxies `/api` to
  `marlog-api`.

---

## Prerequisites

- `flyctl` 0.3+ authenticated against the SPIRE org.
- A Postgres cluster reachable from Fly. SPIRE's existing cluster can be
  reused — MARLOG's tables are namespaced and do not collide with SPIRE's
  schema.
- Repo cloned with the MARLOG module at `marlog/` (this directory).

---

## First-time deploy

All commands run from `marlog/`.

### 1. Create the API app

```bash
fly apps create marlog-api --org spire
fly secrets set DATABASE_URL='postgres://USER:PASS@HOST:5432/marlog' \
  --app marlog-api
fly deploy --config fly.marlog.toml \
           --app marlog-api \
           --build-target marlog-api
```

### 2. Push the schema and seed reference data

Run once against the production database. The seed is idempotent and safe
to re-run.

```bash
DATABASE_URL='postgres://...' pnpm --filter @workspace/db run push
DATABASE_URL='postgres://...' pnpm --filter @workspace/scripts run seed
```

### 3. Create the web app

`fly.marlog-web.toml` is committed and ready to use.

```bash
fly apps create marlog-web --org spire
fly deploy --config fly.marlog-web.toml --app marlog-web
```

The web container uses the upstream `marlog-api:3000` defined in
`deploy/nginx.conf` — that name resolves under docker-compose but not on
Fly. Before the first Fly web deploy, edit `deploy/nginx.conf` to point at
the API app's internal hostname:

```nginx
upstream marlog_api {
    server marlog-api.internal:3000;
}
```

Then run the `fly deploy` command above so the change is baked into the
image.

---

## Routine deploys

```bash
# API
fly deploy --config fly.marlog.toml --app marlog-api

# Web
fly deploy --config fly.marlog-web.toml --app marlog-web
```

Schema migrations (when `lib/db/src/schema/*` changes):

```bash
DATABASE_URL='postgres://...' pnpm --filter @workspace/db run push
```

---

## docker-compose (local / staging mirror)

```bash
docker compose up --build
# UI:  http://localhost:8080
# API: http://localhost:8080/api  (proxied by marlog-web)
```

After first start, push schema and seed:

```bash
DATABASE_URL='postgres://marlog:marlog@localhost:5432/marlog' \
  pnpm --filter @workspace/db run push
DATABASE_URL='postgres://marlog:marlog@localhost:5432/marlog' \
  pnpm --filter @workspace/scripts run seed
```

To wire MARLOG into SPIRE's existing compose stack, copy the `marlog-api`,
`marlog-web`, and `marlog-db` services into SPIRE's `docker-compose.yml`
and replace the `marlog-net` network with SPIRE's shared backend network
(set `external: true` and the network's name).

---

## CI

`.github/workflows/ci.yml` runs on every push and pull request:

1. **`marlog`** — `pnpm install --frozen-lockfile` then `pnpm run build`
   (typecheck + per-package build).
2. **`docker`** — builds `marlog-api` and `marlog-web` images in parallel
   with GitHub Actions cache.

When integrating into SPIRE's main `.github/workflows/ci.yml`, copy the
`marlog` and `docker` jobs into the SPIRE workflow and add:

```yaml
defaults:
  run:
    working-directory: marlog
```

so each step runs from the module root. Scope the path filter to MARLOG:

```yaml
on:
  push:
    paths: ["marlog/**", "!marlog/**/*.md"]
  pull_request:
    paths: ["marlog/**", "!marlog/**/*.md"]
```

---

## Rollback

```bash
fly releases --app marlog-api
fly releases rollback <version> --app marlog-api
```

Schema rollbacks are not automated. Drizzle pushes are forward-only; for
breaking schema changes, deploy a backwards-compatible migration first,
then deploy the application change.

---

## Troubleshooting

| Symptom                                      | Likely cause / fix                                                                 |
|----------------------------------------------|------------------------------------------------------------------------------------|
| `vite build` fails: PORT is required         | Build env missing — Dockerfile sets `PORT=3000` and `BASE_PATH=/`; CI sets both.   |
| `marlog-api` exits with `DATABASE_URL must be set` | Set the secret: `fly secrets set DATABASE_URL='...' --app marlog-api`.             |
| `marlog-web` 404s on /api routes             | nginx upstream points at the wrong host. Update `deploy/nginx.conf` and rebuild.   |
| `marlog-web` 404s on a deep link             | History fallback misconfigured — verify `try_files $uri $uri/ /index.html;` is intact. |
| Health check failing on `/api/healthz`       | API container not reachable on port 3000 — check `fly logs --app marlog-api`.      |
