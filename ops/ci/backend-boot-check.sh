#!/usr/bin/env bash
#
# backend-boot-check.sh -- start the built backend (dist/main.js) and fail
# unless it boots: every module wired, connected to Postgres and Redis,
# answering HTTP.
#
# Why: unit tests build the services they test by hand, so a provider
# missing from a module, a circular import or a guard that throws at start-up
# passes every test and only shows when the app boots. That is how the API
# went down for about 10 minutes on the 1 October deploy (#107).
#
# Usage (from the repository root, after `npm run build` in packages/backend
# and `prisma migrate deploy` against DATABASE_URL):
#   DATABASE_URL=... REDIS_URL=... bash ops/ci/backend-boot-check.sh
#
# Runs in production mode so the production start-up guards run too. The
# secrets are throwaway values made here; no third-party key is set, so
# nothing outside this machine is called.

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${REDIS_URL:?REDIS_URL is required}"

PORT="${BOOT_CHECK_PORT:-3999}"
TIMEOUT="${BOOT_CHECK_TIMEOUT:-90}"
LOG="$(mktemp)"
BACKEND_DIR="$(cd "$(dirname "$0")/../../packages/backend" && pwd)"

secret() { node -e "process.stdout.write(require('crypto').randomBytes($1).toString('$2'))"; }

# Run from an empty directory: ConfigModule reads ./.env, and a developer's
# packages/backend/.env (real keys) must not be picked up.
WORKDIR="$(mktemp -d)"
cd "$WORKDIR"

env -i \
  PATH="$PATH" HOME="${HOME:-/tmp}" \
  NODE_ENV=production \
  PORT="$PORT" \
  DATABASE_URL="$DATABASE_URL" \
  REDIS_URL="$REDIS_URL" \
  JWT_SECRET="$(secret 48 hex)" \
  JWT_REFRESH_SECRET="$(secret 48 hex)" \
  OAUTH_STATE_SECRET="$(secret 24 hex)" \
  REBOOKING_OPT_OUT_SECRET="$(secret 24 hex)" \
  META_TOKEN_ENCRYPTION_KEY="$(secret 32 base64)" \
  FRONTEND_URL="http://localhost:3000" \
  CORS_ORIGINS="http://localhost:3000" \
  node "$BACKEND_DIR/dist/main.js" >"$LOG" 2>&1 &
PID=$!

fail() {
  echo "::error::$1"
  echo "----- backend output (last 80 lines) -----"
  tail -n 80 "$LOG"
  kill "$PID" 2>/dev/null || true
  exit 1
}

for _ in $(seq 1 "$TIMEOUT"); do
  if ! kill -0 "$PID" 2>/dev/null; then
    fail "The backend exited during start-up."
  fi
  # Any HTTP status means it is listening; 000 means not yet.
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/v1/auth/login" || true)"
  if [ "$code" != "000" ]; then
    break
  fi
  sleep 1
done

[ "${code:-000}" = "000" ] && fail "The backend did not answer HTTP within ${TIMEOUT}s."

# Nest logs some wiring problems without exiting; treat them as failures.
if grep -Eq "can't resolve dependencies|UnknownDependenciesException|Fatal bootstrap error" "$LOG"; then
  fail "The backend logged a start-up error."
fi

echo "Backend booted and answered HTTP $code on port $PORT."
kill "$PID"
wait "$PID" 2>/dev/null || true
