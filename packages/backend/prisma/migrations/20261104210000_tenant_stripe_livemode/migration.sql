-- The Stripe mode (livemode) each salon's Stripe customer and plan
-- subscription were created in (audit 8 P2): a test-mode customer or
-- subscription does not exist for the live keys, and the other way round.
ALTER TABLE "tenants" ADD COLUMN "stripeCustomerLivemode" BOOLEAN;
ALTER TABLE "tenants" ADD COLUMN "stripeSubscriptionLivemode" BOOLEAN;

-- Backfill: until now the platform console has held Stripe's TEST keys
-- (they override the live ones in the server's .env), so every customer and
-- subscription stored so far was created in test mode. Rows created with
-- live keys, if any, must be set to true by hand.
UPDATE "tenants" SET "stripeCustomerLivemode" = false WHERE "stripeCustomerId" IS NOT NULL;
UPDATE "tenants" SET "stripeSubscriptionLivemode" = false WHERE "stripeSubscriptionId" IS NOT NULL;
