-- AlterTable
ALTER TABLE "email_campaigns" ADD COLUMN     "capPausedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "platform_email_config" ADD COLUMN     "marketingPackEmails" INTEGER,
ADD COLUMN     "marketingPackPriceCents" INTEGER;

-- CreateTable
CREATE TABLE "email_marketing_usage" (
    "tenantId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "planSent" INTEGER NOT NULL DEFAULT 0,
    "packSent" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_marketing_usage_pkey" PRIMARY KEY ("tenantId","month")
);

-- CreateTable
CREATE TABLE "email_credit_wallet" (
    "tenantId" TEXT NOT NULL,
    "creditsRemaining" INTEGER NOT NULL DEFAULT 0,
    "creditsPurchasedTotal" INTEGER NOT NULL DEFAULT 0,
    "creditsUsedTotal" INTEGER NOT NULL DEFAULT 0,
    "lastTopupAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_credit_wallet_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "email_pack_purchases" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" TEXT NOT NULL,
    "emails" INTEGER NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'stripe',
    "stripeCheckoutSessionId" TEXT,

    CONSTRAINT "email_pack_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_pack_purchases_stripeCheckoutSessionId_key" ON "email_pack_purchases"("stripeCheckoutSessionId");

-- CreateIndex
CREATE INDEX "email_pack_purchases_tenantId_createdAt_idx" ON "email_pack_purchases"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "email_marketing_usage" ADD CONSTRAINT "email_marketing_usage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_credit_wallet" ADD CONSTRAINT "email_credit_wallet_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_pack_purchases" ADD CONSTRAINT "email_pack_purchases_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- The month so far: marketing emails already sent this month count against
-- the cap from the start. Grouped by the month on the salon's clock (an
-- unknown timezone name falls back to Europe/Madrid instead of failing the
-- migration). Only the last two months are read: older ones never matter.
INSERT INTO "email_marketing_usage" ("tenantId", "month", "planSent", "packSent", "updatedAt")
SELECT
    c."tenantId",
    to_char(
        (r."sentAt" AT TIME ZONE 'UTC') AT TIME ZONE
            CASE WHEN EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z.name = t."timezone")
                 THEN t."timezone" ELSE 'Europe/Madrid' END,
        'YYYY-MM'
    ) AS "month",
    COUNT(*)::INTEGER,
    0,
    CURRENT_TIMESTAMP
FROM "email_campaign_recipients" r
JOIN "email_campaigns" c ON c."id" = r."campaignId"
JOIN "tenants" t ON t."id" = c."tenantId"
WHERE r."sentAt" IS NOT NULL
  AND r."sentAt" >= date_trunc('month', CURRENT_TIMESTAMP) - INTERVAL '1 month'
GROUP BY 1, 2
ON CONFLICT ("tenantId", "month") DO NOTHING;
