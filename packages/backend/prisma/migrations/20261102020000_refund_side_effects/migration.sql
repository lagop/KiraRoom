-- What a refund changes besides the money (payments/refund-lines.ts), and
-- the loyalty reward on the invoice.
--
--   refunds."saleLines"                the till sale lines a refund gave back
--                                      ([{ lineId, quantity, cents }])
--   pos_sale_lines."refundedQuantity"  units given back (restocked products)
--   pos_sale_lines."refundedCents"     money given back of the line: its
--                                      commission counts only what is left
--   pos_sale_lines."loyaltyDiscountCents"  the loyalty reward's share of the
--                                      line (its total is after it)
--   invoice_lines."loyaltyDiscountCents"   the same on the invoice line
--                                      ("Descuento fidelidad" on the PDF)
--
-- Additive, with defaults: existing rows read as "nothing refunded, no
-- loyalty share", which is what they recorded.

ALTER TABLE "refunds" ADD COLUMN "saleLines" JSONB NOT NULL DEFAULT '[]';

ALTER TABLE "pos_sale_lines" ADD COLUMN "loyaltyDiscountCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "pos_sale_lines" ADD COLUMN "refundedQuantity" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "pos_sale_lines" ADD COLUMN "refundedCents" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "invoice_lines" ADD COLUMN "loyaltyDiscountCents" INTEGER NOT NULL DEFAULT 0;

-- A client's spend is net of partial refunds (src/clients/client-stats.ts):
-- the paid payments less what was given back of them. Until now a partial
-- refund left a payment "paid" and its whole amount in "totalSpent". Only
-- clients with such a refund are recomputed, with the same rules as
-- 20261101100000_client_stats_backfill; idempotent.
UPDATE "clients" AS c
SET
  "totalSpent"   = GREATEST(COALESCE(p.cents, 0) - COALESCE(r.cents, 0), 0) / 100.0,
  "averageSpent" = CASE
                     WHEN c."visitCount" > 0
                       THEN ROUND((GREATEST(COALESCE(p.cents, 0) - COALESCE(r.cents, 0), 0) / 100.0) / c."visitCount", 2)
                     ELSE 0
                   END
FROM "clients" AS c2
LEFT JOIN LATERAL (
  SELECT SUM(pay."amount")::bigint AS cents
  FROM "payments" pay
  WHERE pay."clientId" = c2."id"
    AND pay."tenantId" = c2."tenantId"
    AND pay."status" = 'paid'
    AND pay."method" <> 'loyalty_points'
) p ON TRUE
LEFT JOIN LATERAL (
  SELECT SUM(ref."amount")::bigint AS cents
  FROM "refunds" ref
  JOIN "payments" pay ON pay."id" = ref."paymentId"
  WHERE pay."clientId" = c2."id"
    AND pay."tenantId" = c2."tenantId"
    AND pay."status" = 'paid'
    AND pay."method" <> 'loyalty_points'
    AND ref."status" = 'succeeded'
) r ON TRUE
WHERE c."id" = c2."id"
  AND COALESCE(r.cents, 0) > 0;
