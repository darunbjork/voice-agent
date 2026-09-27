FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# ── deps ──────────────────────────────────────────────────────────
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/api/package.json ./packages/api/
COPY packages/shared-types/package.json ./packages/shared-types/
RUN pnpm install --frozen-lockfile --filter @voice-agent/api...

# ── build ─────────────────────────────────────────────────────────
FROM base AS build
COPY --from=deps /app /app
COPY packages/shared-types ./packages/shared-types
COPY packages/api ./packages/api
COPY turbo.json ./
RUN pnpm --filter @voice-agent/shared-types build \
  && pnpm --filter @voice-agent/api exec prisma generate \
  && pnpm --filter @voice-agent/api build

# ── runner ────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate \
  && addgroup -S voice && adduser -S voice -G voice
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001

COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=build /app/packages/api/package.json ./packages/api/
COPY --from=build /app/packages/shared-types/package.json ./packages/shared-types/
COPY --from=build /app/packages/api/dist ./packages/api/dist
COPY --from=build /app/packages/api/prisma ./packages/api/prisma
COPY --from=build /app/packages/shared-types/dist ./packages/shared-types/dist
COPY --from=build /app/packages/api/src/generated ./packages/api/dist/generated
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/api/node_modules ./packages/api/node_modules
COPY --from=build /app/packages/shared-types/node_modules ./packages/shared-types/node_modules

USER voice
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/health || exit 1

CMD ["node", "packages/api/dist/app.js"]