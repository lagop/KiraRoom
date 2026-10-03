-- 1. Holded: mirror in Holded the cancellation of an invoice already sent there.
-- CreateEnum
CREATE TYPE "InvoiceAccountingCancelStatus" AS ENUM ('pending', 'cancelled', 'failed');

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "accountingCancelStatus" "InvoiceAccountingCancelStatus";

-- 2. Appointments' location (multi-location report). No booking wrote
-- "locationId", so the report attributed every appointment by where its
-- professional works today. Filled in only where that is unambiguous: the
-- professional is assigned to exactly one location (of the same salon).
-- Professionals with several locations keep NULL and the report's fallback
-- (their primary location) -- guessing here would freeze a guess into data.
UPDATE "appointments" AS a
SET "locationId" = pl."locationId"
FROM (
    SELECT "professionalId", MIN("locationId") AS "locationId"
    FROM "professional_locations"
    GROUP BY "professionalId"
    HAVING COUNT(*) = 1
) AS pl
JOIN "locations" AS l ON l."id" = pl."locationId"
WHERE a."locationId" IS NULL
  AND a."professionalId" = pl."professionalId"
  AND l."tenantId" = a."tenantId";

-- 3. The onboarding wizard's first appointment (notes 'Created from
-- onboarding wizard') stored totalAmount and amountDue in euros, while every
-- other path stores cents. Its rows are recognisable without doubt: they
-- copy the service price in euros, so totalAmount = price (> 0). Rows fixed
-- since, or edited, no longer match and are left alone.
UPDATE "appointments"
SET "totalAmount" = ROUND("price" * 100),
    "amountDue" = CASE WHEN "amountDue" = "price" THEN ROUND("price" * 100) ELSE "amountDue" END
WHERE "notes" = 'Created from onboarding wizard'
  AND "price" > 0
  AND "totalAmount" = "price";

-- 4. The same rows stored scheduledDate and startTime as "date + time" read
-- in the SERVER's timezone instead of the day at midnight UTC and the
-- instant in the salon's timezone. Only rows whose stored clock time equals
-- scheduledTime are touched: that proves the server was on UTC (as the
-- production containers are), so the day is right and the instant can be
-- recomputed. A row written by a server on another timezone does not match
-- and is left as it is, since its day cannot be told for sure.
UPDATE "appointments" AS a
SET "scheduledDate" = date_trunc('day', a."scheduledDate"),
    "startTime" = ((date_trunc('day', a."scheduledDate")::date::text || ' ' || a."scheduledTime")::timestamp
                    AT TIME ZONE (CASE WHEN t."timezone" IN (SELECT "name" FROM pg_timezone_names)
                                       THEN t."timezone" ELSE 'Europe/Madrid' END))
                   AT TIME ZONE 'UTC'
FROM "tenants" AS t
WHERE t."id" = a."tenantId"
  AND a."notes" = 'Created from onboarding wizard'
  AND a."scheduledTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  AND to_char(a."scheduledDate", 'HH24:MI') = a."scheduledTime";
