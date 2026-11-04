-- D2 (2026-11-04): when a salon first paid KiraRoom. Null = never paid, and
-- a never-paid salon sends at most 200 campaign emails a month.
ALTER TABLE "tenants" ADD COLUMN "firstPaidAt" TIMESTAMP(3);

-- Salons on an active Stripe subscription today have paid: their period
-- start is the best date there is. Past due / suspended ones are left null
-- (they may never have paid); their next paid invoice sets it.
UPDATE "tenants"
SET "firstPaidAt" = "currentPeriodStart"
WHERE "firstPaidAt" IS NULL
  AND "subscriptionStatus" = 'active'
  AND "stripeSubscriptionId" IS NOT NULL;
