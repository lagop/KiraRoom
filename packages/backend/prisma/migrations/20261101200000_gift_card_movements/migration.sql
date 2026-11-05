-- Gift card movements record the balance they left and who made them.
ALTER TABLE "gift_card_transactions" ADD COLUMN "balanceAfter" INTEGER;
ALTER TABLE "gift_card_transactions" ADD COLUMN "createdById" TEXT;

-- A refund to a card looks up what a payment took from it.
CREATE INDEX "gift_card_transactions_paymentId_idx" ON "gift_card_transactions"("paymentId");

-- An expiry date picked in the panel ("2026-12-31") used to be stored as
-- midnight UTC at the START of that day, so the card stopped working on its
-- last day. Cards stored that way now end at 23:59:59.999 of that day in the
-- salon's own timezone, which is how new cards are stored.
UPDATE "gift_cards" AS g
SET "expiresAt" = (((g."expiresAt"::date + 1)::timestamp AT TIME ZONE t."timezone") AT TIME ZONE 'UTC') - INTERVAL '1 millisecond'
FROM "tenants" AS t
WHERE t."id" = g."tenantId"
  AND g."expiresAt" IS NOT NULL
  AND g."expiresAt"::time = '00:00:00'
  -- A salon with an unknown timezone keeps its value rather than failing the deploy.
  AND t."timezone" IN (SELECT "name" FROM pg_timezone_names);

-- The issue note was in English; the panel now shows the movements.
UPDATE "gift_card_transactions"
SET "note" = 'Tarjeta regalo emitida'
WHERE "type" = 'created' AND "note" = 'Gift card issued';
