#!/usr/bin/env bash
#
# KiraRoom production deploy — run by GitHub Actions after a successful
# build on `main`. Idempotent.
#
# Assumptions (set up by ops/deploy/bootstrap-hostinger.sh):
#   - The user this script runs as has passwordless sudo (or is root).
#   - /opt/kiraroom/ contains docker-compose.prod.yml + .env.production.
#   - The compose file pulls images by tag, not by digest.
#   - GitHub secrets VPS_SSH_KEY, VPS_HOST, VPS_USER are wired in CI.
#
# Strategy:
#   1. Pull the new images by tag (the tag is passed as $1 by CI).
#   2. `docker compose up -d` — recreates only the services whose image
#      digest changed. Backend's entrypoint runs `prisma migrate deploy`
#      before booting, so schema changes land on every deploy.
#   3. Wait for the backend healthcheck to come up. If it doesn't within
#      HEALTH_TIMEOUT_S, dump the backend logs and exit non-zero so CI
#      marks the deploy as failed.
#
# Exit codes:
#   0 — deploy succeeded, healthcheck green
#   1 — healthcheck never came up
#   2 — docker compose command failed
#
# Usage (locally):  ./deploy-prod.sh <image-tag>
# Usage (CI):       ./deploy-prod.sh "$IMAGE_TAG"
#
# This script does NOT roll back automatically. If healthcheck fails, the
# old containers are also down (docker compose up -d replaced them).
# To roll back: SSH in and run `./deploy-prod.sh <previous-tag>`.

set -euo pipefail

IMAGE_TAG="${1:-latest}"
APP_DIR="${APP_DIR:-/opt/kiraroom}"
COMPOSE_FILE="${COMPOSE_FILE:-${APP_DIR}/docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-${APP_DIR}/.env.production}"
HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-120}"
HEALTH_INTERVAL_S="${HEALTH_INTERVAL_S:-5}"

log() { echo "[deploy $(date -u +%H:%M:%SZ)] $*"; }

cd "${APP_DIR}"

if [[ ! -f "${COMPOSE_FILE}" ]]; then
  log "FATAL: ${COMPOSE_FILE} not found. Did bootstrap-hostinger.sh run?"
  exit 2
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  log "FATAL: ${ENV_FILE} not found. Copy from .env.production.example and fill it in."
  exit 2
fi

log "Pulling images for tag=${IMAGE_TAG} ..."
IMAGE_TAG="${IMAGE_TAG}" docker compose \
  --env-file "${ENV_FILE}" \
  -f "${COMPOSE_FILE}" \
  pull

log "Starting stack ..."
IMAGE_TAG="${IMAGE_TAG}" docker compose \
  --env-file "${ENV_FILE}" \
  -f "${COMPOSE_FILE}" \
  up -d --remove-orphans

log "Waiting for backend healthcheck (timeout ${HEALTH_TIMEOUT_S}s) ..."
ELAPSED=0
HEALTHY=0
while [[ "${ELAPSED}" -lt "${HEALTH_TIMEOUT_S}" ]]; do
  STATUS=$(docker inspect --format='{{.State.Health.Status}}' kiraroom-backend-prod 2>/dev/null || echo "starting")
  if [[ "${STATUS}" == "healthy" ]]; then
    HEALTHY=1
    break
  fi
  sleep "${HEALTH_INTERVAL_S}"
  ELAPSED=$((ELAPSED + HEALTH_INTERVAL_S))
done

if [[ "${HEALTHY}" -ne 1 ]]; then
  log "FATAL: backend did not become healthy within ${HEALTH_TIMEOUT_S}s."
  log "Last 80 lines of backend logs:"
  docker logs --tail 80 kiraroom-backend-prod 2>&1 || true
  exit 1
fi

log "Smoke check: GET /api/v1/ping ..."
PING_HTTP=$(docker exec kiraroom-backend-prod wget -qO- --tries=1 http://127.0.0.1:3001/api/v1/ping || echo "FAIL")
if [[ "${PING_HTTP}" != *"pong"* ]]; then
  log "WARN: /api/v1/ping did not return pong: ${PING_HTTP}"
fi

# Print running stack so the CI log shows what's up.
log "Running stack:"
docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" ps

log "Deploy OK at tag=${IMAGE_TAG}."
