-- Commission clawback (commissions/commission-clawback.ts): a refund of a
-- visit or of a walk-in service line given after its commission was paid
-- records a negative adjustment for the professional ("Ajuste por
-- devolución"), linked to the refund. It counts in the summary until the next
-- payout settles it and in the payroll report of the period it was recorded
-- in; the paid period is not rewritten. One per refund and item.
--
-- New table only: additive, nothing existing changes.

CREATE TABLE "commission_adjustments" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" TEXT NOT NULL,
    "professionalId" TEXT NOT NULL,
    "kind" VARCHAR(20) NOT NULL DEFAULT 'refund',
    "refundId" TEXT NOT NULL,
    "appointmentId" TEXT,
    "posSaleLineId" TEXT,
    "sourceKey" VARCHAR(80) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "settled" BOOLEAN NOT NULL DEFAULT false,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "commission_adjustments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "commission_adjustments_refundId_sourceKey_key" ON "commission_adjustments"("refundId", "sourceKey");
CREATE INDEX "commission_adjustments_tenantId_professionalId_settled_idx" ON "commission_adjustments"("tenantId", "professionalId", "settled");
CREATE INDEX "commission_adjustments_tenantId_createdAt_idx" ON "commission_adjustments"("tenantId", "createdAt");
CREATE INDEX "commission_adjustments_appointmentId_idx" ON "commission_adjustments"("appointmentId");
CREATE INDEX "commission_adjustments_posSaleLineId_idx" ON "commission_adjustments"("posSaleLineId");

ALTER TABLE "commission_adjustments" ADD CONSTRAINT "commission_adjustments_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "refunds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
