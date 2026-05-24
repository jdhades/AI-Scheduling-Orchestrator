# syntax=docker/dockerfile:1.7
#
# Orchestrator (NestJS API + workers de pg-boss).
#
# Multi-stage:
#   1. deps    → instala dependencies con pnpm para reusar cache de capa
#   2. builder → corre `nest build` para emitir dist/
#   3. runtime → image final mínima: solo dist + node_modules de prod
#
# Buildable arg: COMMIT — git short SHA, queda en label para trazabilidad
# desde el container hacia el commit que lo generó.

ARG NODE_VERSION=24-alpine

# ─── deps ────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.1.2 --activate
COPY package.json pnpm-lock.yaml ./
# Install completo (con dev) — el builder los necesita para nest-cli + tsc.
# `--ignore-scripts`: skipea lifecycle scripts de deps. pnpm 10+ bloquea
# unapproved scripts y falla con ERR_PNPM_IGNORED_BUILDS; los packages
# que detectó (@google/genai, @nestjs/core, protobufjs, supabase,
# unrs-resolver) son info-only o no necesarios en runtime — los .js
# vienen pre-compilados. Si alguna en el futuro requiere su script,
# se aprueba puntual y se quita esta flag.
RUN pnpm install --frozen-lockfile --ignore-scripts

# ─── builder ─────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.1.2 --activate
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# Después del build, reducimos node_modules a solo deps de prod.
# `--prod` saca devDependencies del árbol. Sigue ignorando scripts por
# la misma razón que la stage `deps`.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# ─── runtime ─────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}
ARG COMMIT=unknown
LABEL org.opencontainers.image.source="https://github.com/alternetica-io/AI-Scheduling-Orchestrator"
LABEL org.opencontainers.image.revision="${COMMIT}"
LABEL org.opencontainers.image.description="Hongoshop scheduling orchestrator (NestJS + pg-boss)"

# wget viene en alpine base — lo usamos en el healthcheck. tini no es
# necesario: NestJS maneja SIGTERM correctamente via OnApplicationShutdown.
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# nest-cli copia assets de `src/**/*.json` a `dist/` (stripping del
# `src/` prefix), pero el código compilado vive en `dist/src/`. El
# loader de i18n busca `__dirname/i18n` que en runtime resuelve a
# `/app/dist/src/i18n` — copiamos los assets ahí también para que
# coincida sin tocar app.module.ts.
RUN cp -r /app/dist/i18n /app/dist/src/i18n 2>/dev/null || true

# Non-root: la imagen node:alpine ya trae el user 'node' (uid 1000).
USER node

EXPOSE 3000

# Healthcheck contra /health (Terminus). El interval/timeout/retries dejan
# 30s × 3 = 90s antes de marcar unhealthy — suficiente para no flap en
# picos cortos. start-period 30s da margen al boot de NestJS + pg-boss
# (que migra schema en el primer arranque contra una DB virgen).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget --quiet --spider --timeout=4 http://localhost:3000/health || exit 1

# `nest build` con `sourceRoot: src` + scripts/ no excluido del tsconfig
# preserva la estructura top-level → main.js queda en dist/src/main.js,
# NO en dist/main.js. El script `start:prod` de package.json apunta al
# path viejo (legado) — corregirlo allá podría romper el dev. Acá vamos
# directo al path real del build.
CMD ["node", "dist/src/main.js"]
