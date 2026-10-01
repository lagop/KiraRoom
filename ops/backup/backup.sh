#!/bin/sh
# Nightly PostgreSQL backup: dump, check it restores, encrypt, copy off the server.
#
# The dumps used to stay on the server's own disk, unencrypted, for 14 days:
# losing the server lost the database and every copy of it, and anyone who
# could read the volume read every client record and invoice.
#
# Now each dump is
#   1. checked with pg_restore --list (a dump that cannot be read is not a backup);
#   2. encrypted with age to BACKUP_AGE_RECIPIENT, a public key: the server can
#      encrypt but not decrypt, and the private key stays offline with the owner;
#   3. copied with rclone to BACKUP_REMOTE (any S3-compatible bucket).
# Remote retention: every day for BACKUP_REMOTE_RETENTION_DAYS (35), and the
# dump from the 1st of each month for BACKUP_MONTHLY_RETENTION_DAYS (400).
#
# Usage: backup.sh          run daily at BACKUP_AT_UTC (HHMM, default 0315)
#        backup.sh once     one backup now (restore drills, tests)
# Restore steps: docs/runbook.md, "Restoring from the off-site backup".
set -eu

DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
REMOTE_RETENTION_DAYS="${BACKUP_REMOTE_RETENTION_DAYS:-35}"
MONTHLY_RETENTION_DAYS="${BACKUP_MONTHLY_RETENTION_DAYS:-400}"
AT="${BACKUP_AT_UTC:-0315}"
RECIPIENT="${BACKUP_AGE_RECIPIENT:-}"
REMOTE="${BACKUP_REMOTE:-}"
PING_URL="${BACKUP_PING_URL:-}"
export PGHOST="${PGHOST:-postgres}" PGUSER="${PGUSER:-kiraroom}" PGDATABASE="${PGDATABASE:-kiraroom}"

log() { echo "[backup] $*"; }
fail() { echo "[backup] FAILED: $* -- see runbook: Failure: Backup fails to run" >&2; }

run_once() {
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  base="$DIR/kiraroom-$stamp.dump"
  log "starting $base"

  if ! pg_dump -Fc -f "$base.partial"; then
    rm -f "$base.partial"; fail "pg_dump"; return 1
  fi
  if ! pg_restore --list "$base.partial" >/dev/null; then
    rm -f "$base.partial"; fail "pg_restore cannot read the dump"; return 1
  fi

  if [ -n "$RECIPIENT" ]; then
    if ! age -r "$RECIPIENT" -o "$base.age" "$base.partial"; then
      rm -f "$base.partial" "$base.age"; fail "encryption"; return 1
    fi
    rm -f "$base.partial"
    file="$base.age"
  else
    mv "$base.partial" "$base"
    file="$base"
    log "WARNING: BACKUP_AGE_RECIPIENT is not set, so this dump is NOT encrypted"
  fi
  log "ok $file ($(du -h "$file" | cut -f1))"
  find "$DIR" -name 'kiraroom-*.dump*' -type f -mtime +"$RETENTION_DAYS" -delete

  if [ -z "$REMOTE" ]; then
    log "WARNING: BACKUP_REMOTE is not set, so the only copy is on this server"
    return 0
  fi
  if [ -z "$RECIPIENT" ]; then
    fail "not copying an unencrypted dump off the server; set BACKUP_AGE_RECIPIENT"; return 1
  fi
  if ! rclone copy "$file" "$REMOTE"; then
    fail "upload to $REMOTE"; return 1
  fi
  log "copied to $REMOTE"

  # Pruning failures are logged, not fatal: the new copy is already safe.
  rclone delete "$REMOTE" --min-age "${REMOTE_RETENTION_DAYS}d" \
    --filter '- kiraroom-??????01T*' --filter '+ kiraroom-*.dump.age' --filter '- *' \
    || log "WARNING: could not prune daily copies on $REMOTE"
  rclone delete "$REMOTE" --min-age "${MONTHLY_RETENTION_DAYS}d" \
    --filter '+ kiraroom-*.dump.age' --filter '- *' \
    || log "WARNING: could not prune monthly copies on $REMOTE"

  if [ -n "$PING_URL" ]; then
    wget -q -T 10 -O /dev/null "$PING_URL" || log "WARNING: could not reach BACKUP_PING_URL"
  fi
}

if [ "${1:-}" = "once" ]; then
  run_once
  exit $?
fi

log "service up: daily at ${AT} UTC, local ${RETENTION_DAYS}d, encrypted=$([ -n "$RECIPIENT" ] && echo yes || echo NO), off-site=$([ -n "$REMOTE" ] && echo "$REMOTE" || echo NONE)"
while true; do
  if [ "$(date -u +%H%M)" = "$AT" ]; then
    run_once || true
    sleep 3600
  fi
  sleep 30
done
