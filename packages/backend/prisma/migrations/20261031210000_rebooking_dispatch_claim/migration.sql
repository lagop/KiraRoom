-- Rebooking reminders: an atomic claim per cadence row.
--
-- The hourly dispatcher now takes a row by stamping dispatchClaimedAt in a
-- conditional update before sending, so two overlapping ticks (or two
-- backend instances) cannot both send the same "vuelve a reservar" email.
-- The stamp also spaces retries of a row to one per hourly tick.
--
-- Additive only: one nullable column, no backfill.

-- AlterTable
ALTER TABLE "client_cadences" ADD COLUMN     "dispatchClaimedAt" TIMESTAMP(3);
