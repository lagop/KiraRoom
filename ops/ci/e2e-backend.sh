#!/usr/bin/env bash
#
# e2e-backend.sh -- run the built backend (dist/main.js) for the end-to-end
# booking test (e2e/booking), in the foreground. CI starts it in the
# background; locally run it in its own terminal.
#
# Usage (from anywhere, after `npm run build` in packages/backend and
# `prisma migrate deploy` against DATABASE_URL):
#   DATABASE_URL=... REDIS_URL=... [PORT=3001] [FRONTEND_URL=http://localhost:3000] \
#     bash ops/ci/e2e-backend.sh
#
# Same rules as backend-boot-check.sh: it runs from an empty directory, so a
# developer's packages/backend/.env (real keys) is never read, with a clean
# environment and throwaway secrets. No Stripe, Twilio, Resend, Meta, LLM or
# AWS key is set, so emails, SMS and WhatsApp messages are skipped ("not
# configured") and nothing outside this machine is called. Never point it at
# a real database.

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${REDIS_URL:?REDIS_URL is required}"

PORT="${PORT:-3001}"
FRONTEND_URL="${FRONTEND_URL:-http://localhost:3000}"
BACKEND_DIR="$(cd "$(dirname "$0")/../../packages/backend" && pwd)"

secret() { node -e "process.stdout.write(require('crypto').randomBytes($1).toString('$2'))"; }

WORKDIR="$(mktemp -d)"
cd "$WORKDIR"

# SYSTEMROOT and friends only exist on Windows, where Node needs them.
exec env -i \
  PATH="$PATH" HOME="${HOME:-/tmp}" \
  ${SYSTEMROOT:+SYSTEMROOT="$SYSTEMROOT"} \
  ${TEMP:+TEMP="$TEMP"} ${TMP:+TMP="$TMP"} \
  NODE_ENV=production \
  PORT="$PORT" \
  DATABASE_URL="$DATABASE_URL" \
  REDIS_URL="$REDIS_URL" \
  JWT_SECRET="$(secret 48 hex)" \
  JWT_REFRESH_SECRET="$(secret 48 hex)" \
  OAUTH_STATE_SECRET="$(secret 24 hex)" \
  REBOOKING_OPT_OUT_SECRET="$(secret 24 hex)" \
  META_TOKEN_ENCRYPTION_KEY="$(secret 32 base64)" \
  FRONTEND_URL="$FRONTEND_URL" \
  CORS_ORIGINS="$FRONTEND_URL" \
  node "$BACKEND_DIR/dist/main.js"
