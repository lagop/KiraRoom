-- Discounts at the till (POS), given by hand and on record: a row per
-- discount (who, how much, on what line or ticket, why), and the salon's
-- limit for staff, in percent. 0 (the default) means only the owner or a
-- manager can discount, so no salon's till changes until it chooses.
--
-- Additive only: a new column with a default and a new table; no existing
-- row is read or changed.

-- CreateEnum
CREATE TYPE "PosDiscountScope" AS ENUM ('order', 'line');

-- CreateEnum
CREATE TYPE "PosDiscountType" AS ENUM ('percentage', 'fixed');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "maxStaffDiscountPercent" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "pos_discounts" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "scope" "PosDiscountScope" NOT NULL,
    "lineIndex" INTEGER,
    "serviceId" TEXT,
    "productId" TEXT,
    "appointmentId" TEXT,
    "description" VARCHAR(200) NOT NULL,
    "type" "PosDiscountType" NOT NULL,
    "value" DECIMAL(12,2) NOT NULL,
    "baseCents" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "reason" VARCHAR(120),
    "appliedById" TEXT,
    "appliedByRole" TEXT,

    CONSTRAINT "pos_discounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pos_discounts_tenantId_createdAt_idx" ON "pos_discounts"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "pos_discounts_saleId_idx" ON "pos_discounts"("saleId");

-- CreateIndex
CREATE INDEX "pos_discounts_appointmentId_idx" ON "pos_discounts"("appointmentId");

-- AddForeignKey
ALTER TABLE "pos_discounts" ADD CONSTRAINT "pos_discounts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
