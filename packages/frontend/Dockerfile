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

# No SWC download should happen here. The Linux SWC binaries are declared as
# optionalDependencies of @kira/frontend and are in the lockfile, so `npm ci`
# above installs the one matching this platform.
#
# They were missing: the lockfile was generated on Windows and carried only
# @next/swc-win32-x64-msvc, so `npm ci` on Linux installed no binary at all and
# Next fell back to downloading a ~70 MB tarball mid-build. That download is
# flaky, and a truncated tarball fails the build with
# 'ZlibError: zlib: unexpected end of file'. This used to be papered over by
# deleting /root/.cache/next-swc before every build, which only guaranteed a
# fresh roll of the dice each time.
#
# Fail loudly rather than silently downloading, so a lockfile regenerated on a
# developer machine cannot quietly reintroduce the flake.
ENV NEXT_IGNORE_INCORRECT_LOCKFILE=1
RUN cd /repo/packages/frontend && \
    if [ ! -d /repo/node_modules/@next/swc-linux-x64-musl ] && \
       [ ! -d /repo/node_modules/@next/swc-linux-x64-gnu ]; then \
      echo "ERROR: no Linux @next/swc binary installed. The lockfile is missing" >&2; \
      echo "       them -- regenerate it with the optionalDependencies in" >&2; \
      echo "       packages/frontend/package.json present." >&2; \
      exit 1; \
    fi && \
    npm run build

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
