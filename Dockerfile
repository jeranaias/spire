# syntax=docker/dockerfile:1.7
#
# MARLOG — Marine Logistics Calculator
# Multi-stage build for the SPIRE deployment bundle.
#
# Targets:
#   marlog-api  — Node 24 runtime serving the Express 5 API (port 3000).
#   marlog-web  — nginx:alpine serving the Vite SPA and proxying /api to the
#                 marlog-api service (port 80).
#
# Build:
#   docker build --target marlog-api -t marlog-api:local .
#   docker build --target marlog-web -t marlog-web:local .

# ---------------------------------------------------------------------------
# Stage: base — Node 24 + pnpm via Corepack.
# ---------------------------------------------------------------------------
FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

# ---------------------------------------------------------------------------
# Stage: deps — install workspace dependencies with a cached pnpm store.
# Manifests are copied first so dependency install layers stay cache-friendly.
# ---------------------------------------------------------------------------
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc tsconfig.base.json tsconfig.json ./
COPY artifacts/api-server/package.json   ./artifacts/api-server/
COPY artifacts/logistics/package.json    ./artifacts/logistics/
COPY artifacts/mockup-sandbox/package.json ./artifacts/mockup-sandbox/
COPY lib/db/package.json                 ./lib/db/
COPY lib/api-spec/package.json           ./lib/api-spec/
COPY lib/api-zod/package.json            ./lib/api-zod/
COPY lib/api-client-react/package.json   ./lib/api-client-react/
COPY scripts/package.json                ./scripts/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# Stage: build — typecheck + build all workspace packages.
# Vite needs PORT and BASE_PATH at build time because vite.config.ts reads
# them at module load.  PORT is meaningful only at runtime, but a placeholder
# is required to satisfy the validation guard.
# ---------------------------------------------------------------------------
FROM deps AS build
COPY . .
ENV NODE_ENV=production
ENV PORT=3000
ENV BASE_PATH=/
RUN pnpm run build

# ---------------------------------------------------------------------------
# Stage: marlog-api — minimal Node runtime serving the bundled API.
# The esbuild bundle in dist/ is self-contained (pino workers are emitted
# alongside index.mjs by esbuild-plugin-pino), so node_modules is not needed.
# ---------------------------------------------------------------------------
FROM node:24-alpine AS marlog-api
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=build /app/artifacts/api-server/dist ./dist
EXPOSE 3000
USER node
CMD ["node", "--enable-source-maps", "./dist/index.mjs"]

# ---------------------------------------------------------------------------
# Stage: marlog-web — nginx serving the Vite SPA, proxying /api upstream.
# ---------------------------------------------------------------------------
FROM nginx:1.27-alpine AS marlog-web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/artifacts/logistics/dist/public /usr/share/nginx/html
EXPOSE 80
