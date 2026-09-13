# Production Dockerfile for Kira Room Frontend.
#
# Build context is the monorepo root (set in .github/workflows/ci.yml).
FROM node:20-alpine AS builder

WORKDIR /repo

# Install all workspace deps. Frontend needs @kira/shared source so the
# Next.js build can resolve the typed imports.
COPY package.json package-lock.json ./
COPY tsconfig.json ./
COPY packages/frontend/package.json ./packages/frontend/
COPY packages/backend/package.json ./packages/backend/
COPY packages/shared/package.json ./packages/shared/
COPY packages/shared/tsconfig.json ./packages/shared/
RUN npm ci --workspaces --include-workspace-root --no-audit --no-fund

# Build @kira/shared first.
COPY packages/shared ./packages/shared
RUN npm --workspace @kira/shared run build

# Frontend source.
COPY packages/frontend ./packages/frontend

# Build with NEXT_PUBLIC_* baked at build time. These are the production
# URLs; if you need to rebuild with different URLs (e.g. against a
# staging API), pass them as build args and reference them in the
# Dockerfile as ARG NEXT_PUBLIC_API_URL=...
ARG NEXT_PUBLIC_API_URL=https://api.kiraroom.net/api/v1
ARG NEXT_PUBLIC_WS_URL=wss://api.kiraroom.net
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_PUBLIC_WS_URL=${NEXT_PUBLIC_WS_URL}

RUN cd /repo/packages/frontend && npm run build

# Production stage: only the runtime artifacts.
FROM node:20-alpine AS production

RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

WORKDIR /app

COPY --from=builder /repo/packages/frontend/.next ./.next
COPY --from=builder /repo/packages/frontend/public ./public
COPY --from=builder /repo/packages/frontend/server.js ./server.js
COPY --from=builder /repo/packages/frontend/package.json ./package.json
COPY --from=builder /repo/packages/frontend/node_modules ./node_modules

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

EXPOSE 3000

USER nodejs

CMD ["node", "server.js"]
