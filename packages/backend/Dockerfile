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

# The node:20-alpine base image defaults NODE_ENV=production, which makes
# `npm ci` skip devDependencies. That excludes `prisma` (the CLI) from
# the installed packages, so the entrypoint's `npx prisma migrate deploy`
# would fall back to npx fetching a fresh prisma@<latest> (currently 7.x)
# into a temp dir, which then rejects the schema's v5 syntax. Force the
# builder stage to dev so devDeps (prisma, ts-node, etc.) install.
ENV NODE_ENV=development

# Install all workspace deps (including dev) from the root lockfile.
COPY package.json package-lock.json ./
COPY tsconfig.json ./
COPY packages/backend/package.json ./packages/backend/
COPY packages/frontend/package.json ./packages/frontend/
COPY packages/shared/package.json ./packages/shared/
COPY packages/backend/tsconfig.json ./packages/backend/
COPY packages/shared/tsconfig.json ./packages/shared/
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
# Copy the workspace-hoisted node_modules (where prisma and other shared
# deps live) rather than the backend-specific node_modules. With
# `npm ci --workspaces`, every package gets hoisted to /repo/node_modules,
# so this single COPY gives the runtime all of them. The previous path
# (packages/backend/node_modules) only included @prisma/client (the
# runtime library), not the prisma CLI binary needed by the entrypoint.
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/packages/backend/package.json ./
COPY --from=builder /repo/packages/shared ./node_modules/@kira/shared

# Prisma client was generated during the builder stage and is baked
# into ./node_modules. The runtime image just needs the schema +
# migrations for `prisma migrate deploy` to run on container start.

COPY --from=builder /repo/packages/backend/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

USER nodejs

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
