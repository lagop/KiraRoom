-- Time off, phase 2.
--
-- 1. A few hours may now repeat on every day of a range (the mornings of a
--    week): the hours check no longer asks for a single day. Relaxing a CHECK
--    keeps every existing row valid.
-- 2. A closure may be of one location only (multi-local): a nullable
--    locationId, null for every location as before. Only on closures.
-- 3. Whether the time off requests also go by email (default on).
--
-- Additive only: no existing row is read or changed.

-- AlterTable
ALTER TABLE "time_off" DROP CONSTRAINT "time_off_times_check";
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_times_check" CHECK (
  ("startTime" IS NULL AND "endTime" IS NULL)
  OR (
    "startTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    AND "endTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    AND "endTime" > "startTime"
  )
);

ALTER TABLE "time_off" ADD COLUMN "locationId" TEXT;
-- A location's closure is a closure: a professional's time off has none.
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_location_check" CHECK ("locationId" IS NULL OR "professionalId" IS NULL);

-- CreateIndex
CREATE INDEX "time_off_locationId_idx" ON "time_off"("locationId");

-- AddForeignKey
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN "timeOffEmailNotices" BOOLEAN NOT NULL DEFAULT true;
