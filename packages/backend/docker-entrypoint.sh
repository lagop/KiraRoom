#!/bin/sh
# Production entrypoint for Kira Studio Backend.
#
# Why this exists: the runbook (`docs/saas-admin-runbook.md` §11)
# documents that `prisma migrate deploy` MUST run before the new
# container starts serving traffic. Without this script the only
# enforcement is operator discipline, and a missed migration step
# means every /auth/impersonate and every /saas/tenants/:id DELETE
# throws P2021 ("relation does not exist") until someone runs the
# migration manually. The SaaS admin console is hard-broken during
# that gap.
#
# Behaviour:
#   1. Apply pending Prisma migrations (idempotent, no-op when up
#      to date).
#   2. Hand off to whatever command was passed (CMD in the Dockerfile).
#
# The script is intentionally minimal: no shell tricks, no error
# trapping — if migrate deploy fails, the container exits non-zero and
# the orchestrator restarts / surfaces the failure. That's the desired
# failure mode (better than serving 500s on every SaaS request).

set -e

echo "[entrypoint] Running prisma migrate deploy ..."
npx prisma migrate deploy

echo "[entrypoint] Migrations applied. Starting: $@"
exec "$@"