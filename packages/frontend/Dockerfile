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

# Build with NEXT_PUBLIC_* baked at build time. Defaulted to the
# production URLs; override via
#   --build-arg NEXT_PUBLIC_API_URL=...
# if you need a different target.
ARG NEXT_PUBLIC_API_URL=https://api.kiraroom.net/api/v1
ARG NEXT_PUBLIC_WS_URL=wss://api.kiraroom.net
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_PUBLIC_WS_URL=${NEXT_PUBLIC_WS_URL}

# Clean the Next.js SWC cache before building. Next.js downloads the
# SWC binary (~70 MB tarball) to /root/.cache/next-swc on first build,
# but if the download is interrupted the corrupted tarball persists
# and subsequent builds fail with 'ZlibError: zlib: unexpected end
# of file' on the SWC extraction. Clearing the cache forces a clean
# re-download.
RUN rm -rf /root/.cache/next-swc /tmp/next-* 2>/dev/null || true

RUN cd /repo/packages/frontend && npm run build

# Production stage: only .next + node_modules (for `next start`).
FROM node:20-alpine AS production

RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

WORKDIR /app

COPY --from=builder /repo/packages/frontend/.next ./.next
COPY --from=builder /repo/packages/frontend/package.json ./package.json
# 'next start' needs next CLI + frontend deps; both live at /repo/node_modules
# because npm ci --workspaces hoists all workspace deps to the root.
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/packages/shared/dist ./node_modules/@kira/shared/dist
COPY --from=builder /repo/packages/shared/package.json ./node_modules/@kira/shared/package.json

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

EXPOSE 3000

USER nodejs

# `next start` reads /app/.next and listens on PORT (default 3000).
CMD ["npx", "--", "next", "start", "-p", "3000"]
