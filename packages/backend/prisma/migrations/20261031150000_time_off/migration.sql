-- Time off: a professional away (vacation, a day off, sick leave, a few
-- hours), or, with no professional, the whole salon closed (holidays,
-- closures). Availability, booking, moves, the calendar and the receptionist
-- read it; nothing already booked is touched.
--
-- A new table only: no existing row is read or changed.

-- CreateEnum
CREATE TYPE "TimeOffKind" AS ENUM ('vacation', 'day_off', 'sick_leave', 'closure', 'other');

-- CreateTable
CREATE TABLE "time_off" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "professionalId" TEXT,
    "kind" "TimeOffKind" NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "startTime" TEXT,
    "endTime" TEXT,
    "note" VARCHAR(200),
    "createdById" TEXT,

    CONSTRAINT "time_off_pkey" PRIMARY KEY ("id"),
    -- The API validates the same rules (time-off-rules.ts); these keep rows
    -- written any other way readable by it.
    CONSTRAINT "time_off_dates_check" CHECK ("endDate" >= "startDate"),
    -- All day (no times), or a stretch of hours within one single day.
    CONSTRAINT "time_off_times_check" CHECK (
      ("startTime" IS NULL AND "endTime" IS NULL)
      OR (
        "startTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        AND "endTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        AND "endTime" > "startTime"
        AND "startDate" = "endDate"
      )
    ),
    -- A salon-wide block is a closure, and a closure is salon-wide.
    CONSTRAINT "time_off_closure_check" CHECK (("professionalId" IS NULL) = ("kind" = 'closure'))
);

-- CreateIndex
CREATE INDEX "time_off_tenantId_startDate_endDate_idx" ON "time_off"("tenantId", "startDate", "endDate");

-- CreateIndex
CREATE INDEX "time_off_professionalId_idx" ON "time_off"("professionalId");

-- AddForeignKey
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_professionalId_fkey" FOREIGN KEY ("professionalId") REFERENCES "professionals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
