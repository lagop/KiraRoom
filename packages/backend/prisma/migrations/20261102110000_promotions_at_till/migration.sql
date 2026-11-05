-- Promotion codes applied at the till (POS). Additive only.

-- A promotion code is a third kind of till discount (PosDiscount.type).
ALTER TYPE "PosDiscountType" ADD VALUE 'promotion';

-- A promotion deleted after it was used is archived, not deleted.
ALTER TABLE "promotions" ADD COLUMN     "archivedAt" TIMESTAMP(3);

-- A use names its sale and can be released by a full refund; a sale
-- without a client may use a code with no per-client limit.
ALTER TABLE "promotion_usage" ADD COLUMN     "releasedAt" TIMESTAMP(3),
ADD COLUMN     "saleId" TEXT,
ALTER COLUMN "clientId" DROP NOT NULL;

-- The invoice names the promotion's part of a line's discount.
ALTER TABLE "invoice_lines" ADD COLUMN     "promotionCode" VARCHAR(50),
ADD COLUMN     "promotionDiscountCents" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "pos_discounts" ADD COLUMN     "promotionCode" VARCHAR(50),
ADD COLUMN     "promotionId" TEXT;

ALTER TABLE "pos_sales" ADD COLUMN     "promotionCode" VARCHAR(50),
ADD COLUMN     "promotionDiscountCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "promotionId" TEXT;

CREATE INDEX "promotion_usage_saleId_idx" ON "promotion_usage"("saleId");

-- Uses point at their promotion. Rows already orphaned by a deleted
-- promotion (before this, a delete left them behind) are kept: the key is
-- added NOT VALID, so it holds for every new row, and is validated only
-- when there is no orphan to keep.
ALTER TABLE "promotion_usage" ADD CONSTRAINT "promotion_usage_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "promotions"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "promotion_usage" u
    WHERE NOT EXISTS (SELECT 1 FROM "promotions" p WHERE p."id" = u."promotionId")
  ) THEN
    ALTER TABLE "promotion_usage" VALIDATE CONSTRAINT "promotion_usage_promotionId_fkey";
  END IF;
END $$;
