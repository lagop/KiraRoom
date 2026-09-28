-- Backfill appointments."startTime".
--
-- The reminder jobs (notifications.scheduler.ts) select appointments by
-- "startTime", and AppointmentsService.create never wrote it: only the
-- onboarding sample appointment had one. So no real appointment ever got a
-- 24-hour or 1-hour reminder. The service now writes it on create and on
-- reschedule; this fills it in for the rows that already exist.
--
-- "scheduledDate" holds the calendar day and "scheduledTime" the salon's wall
-- clock ("HH:MM"), in the tenant's timezone. (date + time) is that local
-- timestamp; AT TIME ZONE <tz> makes it an absolute instant; AT TIME ZONE
-- 'UTC' stores it as the UTC timestamp Prisma expects in TIMESTAMP(3).
--
-- Data only, and only rows where "startTime" IS NULL. Past appointments are
-- filled too but cannot trigger anything: the jobs look only at a window
-- around now + 24h and now + 1h.

UPDATE "appointments" AS a
SET "startTime" =
  ((a."scheduledDate"::date + a."scheduledTime"::time) AT TIME ZONE t."timezone")
    AT TIME ZONE 'UTC'
FROM "tenants" AS t
WHERE t."id" = a."tenantId"
  AND a."startTime" IS NULL
  AND a."scheduledTime" ~ '^[0-2][0-9]:[0-5][0-9]$';
