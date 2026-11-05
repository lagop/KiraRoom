-- Settings from the salon's general settings page that were shown but never
-- saved: its Instagram and Facebook (linked from its public page), the step
-- between the start times offered when booking, and whether online bookings
-- start confirmed.
--
-- Additive only: new columns, nullable or with a default that keeps today's
-- behaviour (half-hour starts, online bookings pending). No existing row is
-- read or changed.

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "instagram" TEXT,
ADD COLUMN     "facebook" TEXT,
ADD COLUMN     "bookingSlotMinutes" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "autoConfirmOnlineBookings" BOOLEAN NOT NULL DEFAULT false;
