-- Appointment commissions start on 1 November 2026 (owner's decision).
--
-- Until #245 every visit earned 0 EUR of commission, so the snapshot of
-- 20261103020000 would show each salon everything since it started as
-- pending. Visits before 2026-11-01 stay as they were: closed at 0 EUR, as
-- if paid out, with no payout row (they never appear in "Pagos" and an undo
-- cannot reopen them). Till lines are not touched: they always earned their
-- commission. Only completed, paid visits: the same ones the snapshot
-- touched and the report counts, so the report's sales figures don't change.
-- "scheduledDate" holds the salon's day.
UPDATE "appointments"
SET "commissionAmount" = 0,
    "commissionPaid" = true,
    "commissionDate" = COALESCE("commissionDate", NOW())
WHERE "commissionPaid" = false
  AND "status" = 'completed'
  AND "paymentStatus" = 'paid'
  AND "scheduledDate" < '2026-11-01';
