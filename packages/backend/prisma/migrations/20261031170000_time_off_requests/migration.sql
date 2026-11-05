-- Time off requests: a professional asks for time off for themselves, and
-- whoever runs the salon approves or rejects it. Only approved time off
-- blocks the agenda (availability, booking, moves, the calendar).
--
-- Additive: every existing row was recorded by the salon, so it becomes
-- approved through the column's default; nothing else is read or changed.

-- CreateEnum
CREATE TYPE "TimeOffStatus" AS ENUM ('approved', 'pending', 'rejected');

-- AlterTable
ALTER TABLE "time_off" ADD COLUMN     "decidedAt" TIMESTAMP(3),
ADD COLUMN     "decidedById" TEXT,
ADD COLUMN     "decisionNote" VARCHAR(200),
ADD COLUMN     "requestedById" TEXT,
ADD COLUMN     "status" "TimeOffStatus" NOT NULL DEFAULT 'approved';

-- A closure is the salon's own decision: never a request.
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_closure_approved_check"
  CHECK ("professionalId" IS NOT NULL OR "status" = 'approved');

-- CreateIndex
CREATE INDEX "time_off_tenantId_status_idx" ON "time_off"("tenantId", "status");
