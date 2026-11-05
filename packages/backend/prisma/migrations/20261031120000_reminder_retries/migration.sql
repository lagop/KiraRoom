-- Appointment reminders catch up and retry. The scheduler now selects every
-- appointment whose reminder is due and unsent (not an exact time window), so
-- the startTime index serves it; failed sends are retried up to a cap, counted
-- per reminder. The hourly loyalty sweep filters appointments by updatedAt.

-- AlterTable
ALTER TABLE "appointments" ADD COLUMN     "reminder1hAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reminder24hAttempts" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "appointments_startTime_idx" ON "appointments"("startTime");

-- CreateIndex
CREATE INDEX "appointments_updatedAt_idx" ON "appointments"("updatedAt");

