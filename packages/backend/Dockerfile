# Production Dockerfile for Kira Room Backend.
#
# Build context is the monorepo root (set in .github/workflows/ci.yml).
# The Dockerfile expects:
#   ./packages/backend/         <- source + backend package.json + prisma schema
#   ./packages/shared/          <- @kira/shared workspace (npm install resolves via workspaces)
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

# Production stage.
FROM node:20-alpine AS production

# OpenSSL: Prisma engines need libssl at runtime.
RUN apk add --no-cache openssl

# Create the runtime user.
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

WORKDIR /app

# Copy the compiled artifacts.
COPY --from=builder /repo/packages/backend/dist ./dist
COPY --from=builder /repo/packages/backend/prisma ./prisma
COPY --from=builder /repo/packages/shared ./node_modules/@kira/shared
COPY --from=builder /repo/packages/backend/package.json ./

# Install runtime deps in a single npm install. We do this here (not in
# the builder) so:
# 1. NODE_ENV=production in this stage drops devDeps (ts-node, @types/,
#    test tools) -- we don't need them in the ~250 MB image.
# 2. We explicitly include prisma and redis (which are in production
#    dependencies) plus the NestJS peer deps that nestjs doesn't list
#    as direct deps. Adding them as a single install avoids the
#    "each subsequent npm install --no-save modifies the tree" footgun
#    that left deps missing in earlier builds.
# 3. --legacy-peer-deps bypasses the strict peer check (bullmq@5 wants
#    redis@>=5, we ship redis@4 -- fine for runtime).
RUN npm install --omit=dev --legacy-peer-deps --no-audit --no-fund prisma@5.22.0 redis@^4.6.10 reflect-metadata@^0.2.2 rxjs@^7.8.0 ioredis@^5.9.3 @anthropic-ai/sdk @google/generative-ai openai

# Regenerate the Prisma client against the COPYed schema, so the
# runtime @prisma/client is in sync with the (possibly evolved)
# schema at /app/prisma/schema.prisma.
RUN npx prisma generate

COPY --from=builder /repo/packages/backend/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# The COPYs above ran as root; the runtime container runs as the
# unprivileged 'nodejs' user. Chown /app so the runtime can write
# (Prisma engines extracts binaries, schema validation writes a cache).
RUN chown -R nodejs:nodejs /app

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

USER nodejs

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
