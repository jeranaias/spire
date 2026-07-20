# SPIRE — frontend container.
# Vite/Rolldown build → static assets served by nginx with API proxy
# to the backend container. No Node runtime in the production image.

# node:22-alpine
FROM node@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build


# Unprivileged nginx: runs as a non-root user and listens on 8080 by default
# (least privilege, 800-171 3.1 / 3.4.6). Matches the `listen 8080` in nginx.conf.
# nginxinc/nginx-unprivileged:1.27-alpine
FROM nginxinc/nginx-unprivileged@sha256:65e3e85dbaed8ba248841d9d58a899b6197106c23cb0ff1a132b7bfe0547e4c0
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

# The unprivileged image already defaults to uid 101; stated explicitly so a
# reviewer does not have to know that, and so a base-image change cannot
# silently restore root.
USER 101

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/ > /dev/null || exit 1
