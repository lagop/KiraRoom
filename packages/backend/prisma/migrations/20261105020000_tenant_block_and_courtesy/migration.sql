-- Audit 8 D4 / D6: "Bloquear" (abuse) and "Cortesía" (active without paying, with an end date).
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "blockedAt" TIMESTAMP(3);
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "blockedReason" TEXT;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "courtesyUntil" TIMESTAMP(3);
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "courtesyPlan" "SubscriptionPlan";
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "courtesyWarnedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "tenants_courtesyUntil_idx" ON "tenants"("courtesyUntil");

-- Salons active without a Stripe subscription (reactivated or activated by
-- hand from the console) become a courtesy that ends 30 days after this
-- migration runs, on the plan they have. Not the Platform tenant (slug
-- "platform", or the one a platform owner belongs to), not KiraRoom's test
-- salons (address starting "zz-", as 20261105030000_tenant_is_internal marks
-- them internal), not deleted or anonymised ones.
UPDATE "tenants" t
SET "courtesyUntil" = NOW() + INTERVAL '30 days',
    "courtesyPlan" = t."plan",
    "currentPeriodEnd" = NOW() + INTERVAL '30 days'
WHERE t."subscriptionStatus" = 'active'
  AND t."stripeSubscriptionId" IS NULL
  AND t."courtesyUntil" IS NULL
  AND t."deletedAt" IS NULL
  AND t."anonymizedAt" IS NULL
  AND t."slug" <> 'platform'
  AND t."slug" NOT LIKE 'zz-%'
  AND NOT EXISTS (
    SELECT 1 FROM "users" u WHERE u."tenantId" = t."id" AND u."role" = 'saas_owner'
  );

-- Audit 8 D3: a salon deleted from the console follows the same 60 days as
-- "Borrar mi salón" (read-only 30 days from the deletion, anonymised 30
-- after). Salons deleted before that rule have no read-only date: they get
-- the one their deletion would have set, so the retention job warns their
-- owner and anonymises them (at least 7 days after the warning).
UPDATE "tenants" t
SET "readOnlyUntil" = t."deletedAt" + INTERVAL '30 days',
    "subscriptionStatus" = 'cancelled',
    "cancelledAt" = COALESCE(t."cancelledAt", t."deletedAt")
WHERE t."deletedAt" IS NOT NULL
  AND t."anonymizedAt" IS NULL
  AND t."readOnlyUntil" IS NULL
  AND t."slug" <> 'platform'
  AND NOT EXISTS (
    SELECT 1 FROM "users" u WHERE u."tenantId" = t."id" AND u."role" = 'saas_owner'
  );
