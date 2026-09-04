# PostgreSQL WAL archiving configuration

WAL archiving is required for point-in-time recovery — the ability to
restore the database to any second in the last N days, not just the
last full backup. This is critical for the GDPR right-to-erasure scenario:
if a customer requests erasure and you accidentally delete other tenants'
data, you can roll back to before the deletion.

## Setup (PostgreSQL ≥ 13)

Apply as the superuser:

```sql
-- 1. Set WAL level to replica (or logical, depending on replication needs).
ALTER SYSTEM SET wal_level = 'replica';

-- 2. Enable archive mode.
ALTER SYSTEM SET archive_mode = 'on';

-- 3. Set the archive command. The simplest setup is a local rsync to
--    a backup volume. Replace <BACKUP_HOST> with the backup server.
ALTER SYSTEM SET archive_command = 'rsync %p backup@<BACKUP_HOST>:/wal-archive/%f';

-- 4. Restart PostgreSQL for the changes to take effect.
-- (systemctl restart postgresql)
```

## Verify

```sql
-- Confirm archiving is active
SHOW archive_mode;     -- should return "on"
SHOW archive_command;  -- should show your rsync command

-- Force a checkpoint + WAL switch + verify a new archive file appears
CHECKPOINT;
SELECT pg_switch_wal();

-- Confirm the file appeared on the backup host
ls -lt /wal-archive/ | head -5
```

## Restore from WAL + base backup

```bash
# 1. Stop PostgreSQL
systemctl stop postgresql

# 2. Restore the most recent base backup
pg_restore --clean --if-exists --dbname="$DATABASE_URL" \
  /backups/kira-20260716T030000Z.dump

# 3. Configure recovery to a specific point in time
#    Edit postgresql.conf:
#    restore_command = 'cp /wal-archive/%f %p'
#    recovery_target_time = '2026-07-17 14:30:00 UTC'
#    recovery_target_action = 'promote'

# 4. Start PostgreSQL in single-user mode
#    (postgres single user) or via pg_ctl

# 5. Once recovery completes, restart normally
systemctl start postgresql
```

## Retention sizing

Each tenant generates roughly 100MB of WAL/day under normal load
(invoices + appointments + notifications). For 30 days of point-in-time
recovery that's 3GB of archive storage per tenant. For 100 tenants =
300GB. Plan accordingly.

For zero-budget deployment, a 1TB Hetzner Storage Box (€3.50/month) is
enough for the first 50 tenants.

## Quarterly restore drill

As part of the zero-budget launch roadmap (Workstream 1.3), the restore
drill must be performed quarterly:

1. **Block 2 hours** on the calendar.
2. Stop the running API.
3. Restore the most recent backup to a **fresh staging DB** (NOT the
   production DB).
4. Run `npm test` against the staging DB to verify the seed tenants +
   data are intact.
5. **Time the restore**. That's the documented Recovery Time Objective
   (RTO).
6. Update the runbook at `docs/runbook.md` with the new RTO.

If the drill reveals issues, fix them before the next backup window
opens (within 24 hours).
