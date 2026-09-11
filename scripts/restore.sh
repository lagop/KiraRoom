#!/usr/bin/env bash
#
# scripts/restore.sh
#
# Restore a KiraRoom PostgreSQL backup.
#
# Usage:
#   ./restore.sh <path-to-dump-file>
#
# Required environment variables:
#   DATABASE_URL  — postgres://user:pass@host:port/dbname (target)
#
# Examples:
#   # Restore the most recent backup
#   ./restore.sh "$(ls -t /backups/kira-*.dump | head -1)"
#
#   # Restore a specific date
#   ./restore.sh /backups/kira-20260716T030000Z.dump
#
# Behavior:
#   - Verifies dump file integrity (PGDMP magic + checksum)
#   - Drops existing connections to the target database
#   - Runs pg_restore --clean --if-exists to overwrite cleanly
#   - Logs restore metadata to stdout for audit
#
# This script is the operational counterpart to scripts/backup.sh.
# ALWAYS run a smoke test (./restore.sh + npm test) after any restore
# to verify the database is consistent. Quarterly restore drill is part
# of the zero-budget launch roadmap (Workstream 1.3).

set -euo pipefail

# --- Argument check ---
if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <path-to-dump-file>" >&2
  echo "  Example: $0 /backups/kira-20260716T030000Z.dump" >&2
  exit 1
fi
DUMP_FILE="$1"
DATABASE_URL="${DATABASE_URL:?DATABASE_URL is required}"

# --- Sanity checks ---
if [ ! -f "${DUMP_FILE}" ]; then
  echo "[FATAL] dump file not found: ${DUMP_FILE}" >&2
  exit 2
fi
HEAD=$(head -c 5 "${DUMP_FILE}")
if [ "${HEAD}" != "PGDMP" ]; then
  echo "[FATAL] dump header invalid (expected PGDMP, got ${HEAD})" >&2
  echo "         this file is not a pg_dump custom-format dump" >&2
  exit 3
fi

# Optional checksum verification if .sha256 file is alongside.
SHA_FILE="${DUMP_FILE}.sha256"
if [ -f "${SHA_FILE}" ]; then
  echo "[INFO] verifying checksum against ${SHA_FILE}"
  EXPECTED=$(awk '{print $1}' "${SHA_FILE}")
  ACTUAL=$(sha256sum "${DUMP_FILE}" | awk '{print $1}')
  if [ "${EXPECTED}" != "${ACTUAL}" ]; then
    echo "[FATAL] checksum mismatch:" >&2
    echo "  expected: ${EXPECTED}" >&2
    echo "  actual:   ${ACTUAL}" >&2
    exit 4
  fi
  echo "[INFO] checksum verified"
fi

if ! command -v pg_restore >/dev/null 2>&1; then
  echo "[FATAL] pg_restore not found in PATH. Install postgresql-client." >&2
  exit 5
fi

# --- Restore ---
echo "[INFO] $(date -u +%FT%TZ) starting restore of ${DUMP_FILE} into $(echo "${DATABASE_URL}" | sed 's|.*@|@|')"

# pg_restore with --clean --if-exists to overwrite cleanly.
# --no-owner --no-privileges match the backup script's flags.
pg_restore \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  --dbname="${DATABASE_URL}" \
  "${DUMP_FILE}"

echo "[INFO] restore complete. Run 'npm test' to verify consistency."
