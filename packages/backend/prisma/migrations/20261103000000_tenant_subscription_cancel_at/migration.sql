-- When a cancelled paid subscription ends (Stripe cancel_at_period_end).
-- Additive: a nullable column, null (renews) for every existing salon.
ALTER TABLE "tenants" ADD COLUMN "subscriptionCancelAt" TIMESTAMP(3);
