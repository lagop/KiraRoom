# Production Dockerfile for Kira Room Backend.
#
# Build context is the monorepo root (set in .github/workflows/ci.yml).
# The Dockerfile expects:
#   ./packages/backend/         <- source + backend package.json + prisma schema
#   ./packages/shared/          <- @kira/shared workspace (npm install resolves via workspaces)
#   ./packages/frontend/        <- workspace neighbor (npm install needs to see this)
#   ./package.json + ./package-lock.json <- root workspace manifest
#
# Builder stage: install all workspace deps, build @kira/shared, generate
# Prisma client, build the backend.
FROM node:20-alpine AS builder

WORKDIR /repo

# Install all workspace deps (including dev) from the root lockfile.
COPY package.json package-lock.json ./
COPY packages/backend/package.json ./packages/backend/
COPY packages/frontend/package.json ./packages/frontend/
COPY packages/shared/package.json ./packages/shared/
RUN npm ci --workspaces --include-workspace-root --no-audit --no-fund

# Build @kira/shared (needed at build-time for the backend import).
COPY packages/shared ./packages/shared
RUN npm --workspace @kira/shared run build

# Backend source + Prisma schema + entrypoint.
COPY packages/backend ./packages/backend
COPY packages/backend/docker-entrypoint.sh /repo/packages/backend/docker-entrypoint.sh

# Generate Prisma client + build backend.
RUN cd /repo/packages/backend && npx prisma generate && npm run build

# Production stage: only the runtime artifacts.
FROM node:20-alpine AS production

RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

WORKDIR /app

COPY --from=builder /repo/packages/backend/dist ./dist
COPY --from=builder /repo/packages/backend/prisma ./prisma
COPY --from=builder /repo/packages/backend/node_modules ./node_modules
COPY --from=builder /repo/packages/backend/package.json ./
COPY --from=builder /repo/packages/shared ./node_modules/@kira/shared

# Prisma client is now baked into the backend's node_modules, but
# re-run generate in the runtime stage to be safe (idempotent).
RUN cd /app && npx prisma generate

COPY --from=builder /repo/packages/backend/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

USER nodejs

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
