-- Online payments: the salon's own Stripe account connected through the platform.
ALTER TABLE "tenants" ADD COLUMN "stripeConnectAccountId" TEXT;
ALTER TABLE "tenants" ADD COLUMN "stripeConnectLivemode" BOOLEAN;
ALTER TABLE "tenants" ADD COLUMN "stripeConnectChargesEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tenants" ADD COLUMN "stripeConnectPayoutsEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tenants" ADD COLUMN "stripeConnectDetailsSubmitted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tenants" ADD COLUMN "stripeConnectRequirementsDue" JSONB;
ALTER TABLE "tenants" ADD COLUMN "stripeConnectDisabledReason" TEXT;
ALTER TABLE "tenants" ADD COLUMN "stripeConnectCheckedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "tenants_stripeConnectAccountId_key" ON "tenants"("stripeConnectAccountId");
