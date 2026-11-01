-- What each appointment (and each service of a multi-service visit) was
-- booked at: the service's name, its price (EUROS, like services.price) and
-- its length in minutes.
--
-- The visit totals, the till, the invoice and the notices read the service
-- from the catalog, so editing a service's price or duration changed
-- appointments already made: an edit of the visit re-priced it at the new
-- price, the invoice lines and the agenda read the new figures. From now on
-- the application writes these at booking time (and when the salon switches
-- an appointment to another service) and reads them first
-- (src/appointments/appointment-snapshot.ts). NULL falls back to the live
-- service, as before.
--
-- 1. Three nullable columns on each table: no default, so adding them only
--    touches the catalog, not the rows.
-- 2. Backfill, from the CURRENT service values, of the appointments that can
--    still change: still to happen (from yesterday on, so no timezone is
--    missed) or not paid yet, and not cancelled or no-show. History (paid
--    and in the past) keeps NULL: its price is frozen and its invoice issued,
--    and stamping today's catalog on it would freeze a guess into the data.
--    The service rows of those appointments get the same.
--
--    In batches of 2000 rows, each UPDATE over rows picked by primary key.
--    Prisma runs the file as one transaction (a COMMIT inside a DO block is
--    refused there), so the row locks last until the end; only the open
--    appointments are touched, readers are never blocked (row locks), and
--    the agenda's writes to those rows wait for seconds at most. Idempotent:
--    only rows whose snapshot is still NULL are touched, so running the DO
--    blocks again (by hand, after a partial run) finishes the job.

-- AlterTable
ALTER TABLE "appointments" ADD COLUMN "serviceName" TEXT,
ADD COLUMN "servicePrice" DECIMAL(65,30),
ADD COLUMN "serviceDuration" INTEGER;

-- AlterTable
ALTER TABLE "appointment_services" ADD COLUMN "serviceName" TEXT,
ADD COLUMN "servicePrice" DECIMAL(65,30),
ADD COLUMN "serviceDuration" INTEGER;

-- Backfill: appointments.
DO $$
DECLARE
  done integer;
BEGIN
  LOOP
    WITH batch AS (
      SELECT a."id"
      FROM "appointments" a
      WHERE a."serviceName" IS NULL
        AND a."status" NOT IN ('cancelled', 'no_show')
        AND (
          a."scheduledDate" >= (CURRENT_DATE - 1)
          OR a."paymentStatus" IN ('pending', 'failed')
        )
      LIMIT 2000
    )
    UPDATE "appointments" AS a
    SET "serviceName" = s."name",
        "servicePrice" = s."price",
        "serviceDuration" = s."duration"
    FROM batch, "services" AS s
    WHERE a."id" = batch."id"
      AND s."id" = a."serviceId";
    GET DIAGNOSTICS done = ROW_COUNT;
    EXIT WHEN done = 0;
  END LOOP;
END $$;

-- Backfill: the service rows of those appointments.
DO $$
DECLARE
  done integer;
BEGIN
  LOOP
    WITH batch AS (
      SELECT r."id"
      FROM "appointment_services" r
      JOIN "appointments" a ON a."id" = r."appointmentId"
      WHERE r."serviceName" IS NULL
        AND a."status" NOT IN ('cancelled', 'no_show')
        AND (
          a."scheduledDate" >= (CURRENT_DATE - 1)
          OR a."paymentStatus" IN ('pending', 'failed')
        )
      LIMIT 2000
    )
    UPDATE "appointment_services" AS r
    SET "serviceName" = s."name",
        "servicePrice" = s."price",
        "serviceDuration" = s."duration"
    FROM batch, "services" AS s
    WHERE r."id" = batch."id"
      AND s."id" = r."serviceId";
    GET DIAGNOSTICS done = ROW_COUNT;
    EXIT WHEN done = 0;
  END LOOP;
END $$;
