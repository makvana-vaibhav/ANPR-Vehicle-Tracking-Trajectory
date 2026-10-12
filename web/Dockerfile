# ══════════════════════════════════════════════════════════════════════
#  NagarNetra command centre
#
#  Two targets:
#    dev     — Vite dev server with HMR, used by `make web-dev`
#    runtime — static bundle served by nginx; this is the judge-facing path
# ══════════════════════════════════════════════════════════════════════

ARG NODE_VERSION=20

# ── Dependencies ──────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
# Copy manifests only, so a source edit does not invalidate the install layer.
COPY package.json package-lock.json* ./
# Use the lockfile when present (reproducible); fall back on first run.
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# ── Development server ────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS dev
WORKDIR /app
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 5173
CMD ["npm", "run", "dev"]

# ── Production build ──────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /app

# Vite inlines these at build time, so they must be present as build args.
ARG VITE_API_BASE_URL=""
ARG VITE_WS_URL=""
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL} \
    VITE_WS_URL=${VITE_WS_URL} \
    NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY . .
# `npm run build` runs `tsc --noEmit` first: a type error fails the image
# build rather than shipping a broken bundle.
RUN npm run build

# ── Runtime ───────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime

LABEL org.opencontainers.image.title="NagarNetra Command Centre" \
      org.opencontainers.image.description="Statewide CCTV intelligence platform — web tier" \
      org.opencontainers.image.licenses="Apache-2.0"

# openssl, for the self-signed certificate the HTTPS server falls back to when
# none is mounted (docker/30-contrail-tls.sh). Pinned to the 3.3 series that
# this Alpine release (3.21) ships.
RUN apk add --no-cache "openssl~3.3" \
 && rm -rf /usr/share/nginx/html/*
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY nginx/contrail-app.conf /etc/nginx/contrail/app.conf
COPY --chmod=0755 docker/30-contrail-tls.sh /docker-entrypoint.d/30-contrail-tls.sh

# 80: plain HTTP (published as 8080). 8443: HTTPS.
EXPOSE 80 8443

HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=12 \
    CMD wget -q -O- http://127.0.0.1:80/healthz >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]
