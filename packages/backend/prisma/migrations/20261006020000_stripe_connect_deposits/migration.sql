-- Deposits against no-shows, charged on each salon's own Stripe account
-- through Stripe Connect.
ALTER TABLE "tenants" ADD COLUMN "stripeConnectAccountId" TEXT;
ALTER TABLE "tenants" ADD COLUMN "stripeConnectChargesEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "appointments" ADD COLUMN "depositCheckoutSessionId" TEXT;
ALTER TABLE "appointments" ADD COLUMN "depositExpiresAt" TIMESTAMP(3);
CREATE INDEX "appointments_depositExpiresAt_idx" ON "appointments"("depositExpiresAt");
