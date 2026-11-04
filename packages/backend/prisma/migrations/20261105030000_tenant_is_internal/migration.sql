-- KiraRoom's own salons (audit 8 D11): the Platform tenant and our test
-- salons. They are left out of platform figures and alerts, and are the
-- only salons allowed to use Stripe test mode. Set from the console.
ALTER TABLE "tenants" ADD COLUMN "isInternal" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: the Platform tenant (seed-saas-owner) and the test salons,
-- whose address has started with "zz-" so far.
UPDATE "tenants" SET "isInternal" = true WHERE "slug" = 'platform' OR "slug" LIKE 'zz-%';
