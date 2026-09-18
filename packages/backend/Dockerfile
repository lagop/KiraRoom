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

# Install OpenSSL: Prisma engines need libssl at runtime to do things
# like verify TLS connections to Postgres. The default node:20-alpine
# image doesn't ship with it.
RUN apk add --no-cache openssl

# Create the runtime user. UID 1001 matches the CI run-as-user.
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

WORKDIR /app

COPY --from=builder /repo/packages/backend/dist ./dist
COPY --from=builder /repo/packages/backend/prisma ./prisma
# Copy the workspace-hoisted node_modules (where prisma and other
# shared deps live) rather than the backend-specific node_modules. With
# `npm ci --workspaces`, every package gets hoisted to /repo/node_modules,
# so this single COPY gives the runtime all of them.
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/packages/backend/package.json ./
COPY --from=builder /repo/packages/shared ./node_modules/@kira/shared

# Force-include the prisma CLI binary. The workspace hoisting in the
# builder stage places prisma in /repo/node_modules, but a previous
# build layer's stale COPY state can shadow it with a /app/node_modules
# that doesn't have prisma. `npm install --no-save prisma@5.22.0` in
# this layer explicitly adds the binary into the existing ./node_modules,
# overwriting any stale state.
RUN npm install --no-save --legacy-peer-deps prisma@5.22.0

# Also force-include the redis client. node-redis v4 lives at
# packages/backend/node_modules/redis when hoisting conflicts with
# another workspace dep. Same fix: explicit install.
RUN npm install --no-save --legacy-peer-deps redis@^4.6.10

# Belt-and-suspenders: copy the backend's nested node_modules for any
# other deps that npm hoisting didn't pick up.
COPY --from=builder /repo/packages/backend/node_modules /tmp/backend_nm
RUN cp -ran /tmp/backend_nm/. ./node_modules/ 2>/dev/null || true; \
    rm -rf /tmp/backend_nm

# Prisma client was generated during the builder stage and is baked
# into ./node_modules. The runtime image just needs the schema +
# migrations for `prisma migrate deploy` to run on container start.

COPY --from=builder /repo/packages/backend/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# The previous COPYs ran as root, which leaves the files owned by root.
# The runtime container runs as the unprivileged 'nodejs' user, which
# needs write access to /app/node_modules (Prisma engines writes
# extracted binaries there on first run, and the schema validator
# may write a cache). Chown the runtime tree to nodejs.
RUN chown -R nodejs:nodejs /app

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

USER nodejs

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
