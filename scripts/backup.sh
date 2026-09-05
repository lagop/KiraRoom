#!/usr/bin/env bash
#
# scripts/backup.sh
#
# Daily PostgreSQL logical backup for KiraRoom SaaS.
#
# Schedule via cron at 03:00 UTC daily:
#   0 3 * * *  /opt/kiraroom/scripts/backup.sh
#
# Required environment variables:
#   DATABASE_URL        — postgres://user:pass@host:port/dbname
#   BACKUP_DIR          — local directory for backup files (default: /backups)
#   BACKUP_RSYNC_HOST   — optional remote host for off-site copy
#
# Behavior:
#   - Dumps the database in custom format (-Fc), compressed with gzip
#   - Keeps 30 days of local backups (older are deleted)
#   - If BACKUP_RSYNC_HOST is set, rsyncs to a remote host for off-site copy
#   - Logs to stdout (capture with cron → /var/log/kiraroom-backup.log)
#
# Restore: see scripts/restore.sh
#
# This script is part of Workstream 1.3 of the zero-budget launch
# roadmap. Verify recovery quarterly — the most-skipped production
# readiness item.

set -euo pipefail

# --- Configuration ---
DATABASE_URL="${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_RSYNC_HOST="${BACKUP_RSYNC_HOST:-}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
BASENAME="kira-${TS}"
DUMP_PATH="${BACKUP_DIR}/${BASENAME}.dump"

# --- Sanity checks ---
if ! command -v pg_dump >/dev/null 2>&1; then
  echo "[FATAL] pg_dump not found in PATH. Install postgresql-client." >&2
  exit 1
fi

mkdir -p "${BACKUP_DIR}"

# --- Dump ---
echo "[INFO] $(date -u +%FT%TZ) starting backup of $(echo "${DATABASE_URL}" | sed 's|.*@|@|')"
pg_dump \
  --format=custom \
  --compress=0 \
  --no-owner \
  --no-privileges \
  --file="${DUMP_PATH}" \
  "${DATABASE_URL}"

# Verify the dump is non-empty + sanity-check the magic header.
DUMP_BYTES=$(stat -c '%s' "${DUMP_PATH}" 2>/dev/null || stat -f '%z' "${DUMP_PATH}")
if [ "${DUMP_BYTES:-0}" -lt 1024 ]; then
  echo "[FATAL] dump is suspiciously small (${DUMP_BYTES} bytes)" >&2
  exit 2
fi
HEAD=$(head -c 5 "${DUMP_PATH}")
if [ "${HEAD}" != "PGDMP" ]; then
  echo "[FATAL] dump header invalid (expected PGDMP, got ${HEAD})" >&2
  exit 3
fi
echo "[INFO] dump ok: ${BASENAME}.dump (${DUMP_BYTES} bytes)"

# Compute a checksum for integrity verification during restore.
sha256sum "${DUMP_PATH}" | tee "${DUMP_PATH}.sha256"
echo "[INFO] checksum: ${BASENAME}.dump.sha256"

# --- Retention: prune anything older than RETENTION_DAYS ---
PRUNED=$(find "${BACKUP_DIR}" -maxdepth 1 -name "kira-*.dump*" -mtime +"${RETENTION_DAYS}" -print -delete | wc -l)
echo "[INFO] pruned ${PRUNED} backups older than ${RETENTION_DAYS} days"

# --- Off-site copy ---
if [ -n "${BACKUP_RSYNC_HOST}" ]; then
  echo "[INFO] rsyncing to ${BACKUP_RSYNC_HOST}"
  rsync -avz --progress "${DUMP_PATH}" "${DUMP_PATH}.sha256" "${BACKUP_RSYNC_HOST}:${BACKUP_DIR}/" \
    || echo "[WARN] rsync failed — local copy still present"
else
  echo "[INFO] BACKUP_RSYNC_HOST not set; skipping off-site copy"
fi

echo "[INFO] backup complete: ${DUMP_PATH}"
