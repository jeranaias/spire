# SPIRE — frontend container.
# Vite/Rolldown build → static assets served by nginx with API proxy
# to the backend container. No Node runtime in the production image.

FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build


# Unprivileged nginx: runs as a non-root user and listens on 8080 by default
# (least privilege, 800-171 3.1 / 3.4.6). Matches the `listen 8080` in nginx.conf.
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/ > /dev/null || exit 1
