-- Commissions, phase 2 (commissions/commission-terms.ts, commissions.service.ts).
--
-- Additive: new columns with defaults, a new table. Two data updates, both
-- keeping what salons see today or making it consistent:
--
--   1. "Comisión por defecto" (tenants.commissionDefaultRate): the rate a
--      service earns when neither the appointment nor the professional has
--      one. It was hard-coded to 10 %. Salons that exist now get 10, so their
--      figures do not change; salons created from now on start at 0 (the
--      column default after this migration).
--
--   2. "Comisión sobre" (tenants.commissionBase): "net" (without the tax, the
--      default) or "gross". Until now a salon whose prices include the tax
--      earned commission on the price with the tax, the others on the price
--      without it. Every salon is "net" now. Visits work their commission out
--      when they are read, so their pending figure follows on its own; the
--      walk-in service lines already sold, NOT paid out yet and with no
--      refund, of salons whose prices include the tax, are moved to the net
--      base here, so the pending figure is on one basis. Lines already paid
--      out (and lines with a refund, whose clawback was worked out on the old
--      figure) keep what they have: payouts are never rewritten.

-- AlterTable
ALTER TABLE "professionals" ADD COLUMN     "productCommissionRate" DECIMAL(5,2);

-- AlterTable: existing salons 10 %, new ones 0 %.
ALTER TABLE "tenants" ADD COLUMN     "commissionBase" VARCHAR(10) NOT NULL DEFAULT 'net',
ADD COLUMN     "commissionDefaultRate" DECIMAL(5,2) NOT NULL DEFAULT 10,
ADD COLUMN     "productCommissionDefaultRate" DECIMAL(5,2) NOT NULL DEFAULT 0;
ALTER TABLE "tenants" ALTER COLUMN "commissionDefaultRate" SET DEFAULT 0;

-- CreateTable
CREATE TABLE "commission_payouts" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" TEXT NOT NULL,
    "professionalId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "itemCount" INTEGER NOT NULL,
    "upTo" DATE,
    "items" JSONB NOT NULL,
    "createdById" TEXT,
    "undoneAt" TIMESTAMP(3),
    "undoneById" TEXT,

    CONSTRAINT "commission_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "commission_payouts_tenantId_professionalId_createdAt_idx" ON "commission_payouts"("tenantId", "professionalId", "createdAt");

-- CreateIndex
CREATE INDEX "commission_payouts_tenantId_createdAt_idx" ON "commission_payouts"("tenantId", "createdAt");

-- Pending walk-in service lines of salons whose prices include the tax: to
-- the net base, base - (base - round(base / (1 + rate))), as includedTaxCents.
UPDATE "pos_sale_lines" AS l
SET "commissionBaseCents" = ROUND(l."commissionBaseCents" / (1 + l."taxRate" / 100))::int,
    "commissionAmount" = ROUND(ROUND(l."commissionBaseCents" / (1 + l."taxRate" / 100)) * l."commissionRate" / 100)
FROM "tenants" AS t
WHERE t."id" = l."tenantId"
  AND (t."fiscalSettings" ->> 'pricesIncludeTax') = 'true'
  AND l."kind" = 'service'
  AND l."commissionPaid" = false
  AND l."commissionRate" IS NOT NULL
  AND l."taxRate" > 0
  AND l."refundedCents" = 0
  AND l."commissionBaseCents" > 0;
