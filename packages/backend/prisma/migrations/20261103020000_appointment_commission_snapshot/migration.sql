-- Appointment commissions (commissions/appointment-commission.ts).
--
-- Every appointment was created with "commissionAmount" = 0 (the column's
-- default) and nothing in the panel wrote it again, so visits earned 0 EUR of
-- commission. From now on the amount is null until it is worked out (a real
-- 0 % rate stores 0) and is stored when the visit is completed and paid.

-- 1. No default: a new appointment starts with no commission worked out.
--    Existing values are kept as they are.
ALTER TABLE "appointments" ALTER COLUMN "commissionAmount" DROP DEFAULT;

-- 2. The snapshot for the visits that are completed, paid and not paid out
--    yet, whose stored amount is the old default (0, or none) while a rate
--    above 0 applies: the effective rate (the appointment's own, else the
--    professional's, else the 10 % default of commission-rate.ts) and
--    round(totalAmount x rate / 100), whole cents.
--    Appointments whose commission was already marked paid
--    ("commissionPaid" = true) are left untouched: what to do with those
--    paid at 0 EUR is the salon owner's decision.
UPDATE "appointments" AS a
SET "commissionRate" = COALESCE(a."commissionRate", p."commissionRate", 10),
    "commissionAmount" = ROUND(a."totalAmount" * COALESCE(a."commissionRate", p."commissionRate", 10) / 100)
FROM "professionals" AS p
WHERE p."id" = a."professionalId"
  AND a."status" = 'completed'
  AND a."paymentStatus" = 'paid'
  AND a."commissionPaid" = false
  AND (a."commissionAmount" IS NULL OR a."commissionAmount" = 0)
  AND COALESCE(a."commissionRate", p."commissionRate", 10) > 0;
