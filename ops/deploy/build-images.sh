#!/usr/bin/env bash
#
# build-images.sh -- build the three custom KiraRoom images locally
# on the VPS, tag them as :local, and update the running stack.
#
# Why local builds instead of GHCR:
#   - The CI workflow uses cache: npm with cache-dependency-path:
#     package-lock.json. The cache key hashes the lockfile, but a
#     stale cached node_modules from an earlier run (with prisma@7.x
#     transitives) was being reused even after we pinned prisma@5.22.0.
#     The CI workflow is broken in a way that requires manual cache
#     invalidation to fix, and rebuilding from this VPS avoids the
#     dance entirely.
#   - Image size cost is small (the build artifacts are cached by
#     docker buildx locally).
#   - The first build takes ~5 min; subsequent builds with cached
#     layers take <30 s.
#
# Usage (from the VPS):
#   cd /opt/kiraroom
#   ./ops/deploy/build-images.sh
#
# This script is idempotent. It rebuilds the backend and frontend
# (their contexts are the repo root because the Dockerfiles COPY
# monorepo manifests first) and the nginx (context is docker/nginx).
# Run it after every PR merge to main, then `docker compose up -d`
# recreates the containers with the new images.

set -euo pipefail

APP_DIR="/opt/kiraroom"
cd "$APP_DIR"

echo "==> Building kiraroom-backend:local"
docker build \
  -f packages/backend/Dockerfile \
  -t kiraroom-backend:local \
  .

echo "==> Building kiraroom-frontend:local"
docker build \
  -f packages/frontend/Dockerfile \
  -t kiraroom-frontend:local \
  .

echo "==> Building kiraroom-nginx:local (referenced by the upstream Traefik)"
# Note: this compose no longer includes a kiraroom-nginx service (the
# Traefik integration moved reverse-proxy + TLS to the VPS's existing
# root-traefik-1). We still build the image because the custom Dockerfile
# is the reference for how to ship nginx.conf baked into a container.
docker build \
  -f docker/nginx/Dockerfile \
  -t kiraroom-nginx:local \
  .

echo ""
echo "==> Local images built. Recreating the stack..."
docker compose -p kiraroom \
  -f docker-compose.prod.yml \
  --env-file .env \
  up -d --force-recreate

echo ""
echo "==> Verifying Prisma version inside the backend container"
docker exec kiraroom-backend-prod npx prisma --version || true

echo ""
echo "==> Done. Tail of backend logs:"
docker logs --tail=20 kiraroom-backend-prod
