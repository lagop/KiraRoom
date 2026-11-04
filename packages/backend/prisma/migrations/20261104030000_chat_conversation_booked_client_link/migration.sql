-- A receptionist conversation that booked an appointment belongs to the client
-- the appointment was made for.
--
-- Until now a visitor's chat on the salon's site (and a Messenger, Instagram
-- or Telegram chat) kept "clientId" null after booking, so her data export
-- and her erasure, which find conversations by client, never saw it: the
-- name, phone and email she gave stayed behind. New bookings link the
-- conversation (receptionist-booking.ts); this links the ones booked before.
--
-- Only conversations with no client yet, and only to an appointment of the
-- same salon. Nothing is removed. Safe to run again.
UPDATE "chat_conversations" AS c
SET "clientId" = a."clientId"
FROM "appointments" AS a
WHERE c."clientId" IS NULL
  AND c."context" -> 'pendingBooking' ->> 'bookedAppointmentId' IS NOT NULL
  AND a."id" = c."context" -> 'pendingBooking' ->> 'bookedAppointmentId'
  AND a."tenantId" = c."tenantId";
