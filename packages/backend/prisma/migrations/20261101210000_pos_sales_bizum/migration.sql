-- Bizum as a way of paying at the till.
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'bizum';

-- One row per sale at the till: its idempotency key, totals and invoice.
CREATE TABLE "pos_sales" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "clientId" TEXT,
    "createdById" TEXT,
    "kind" VARCHAR(20) NOT NULL DEFAULT 'checkout',
    "subtotalCents" INTEGER NOT NULL DEFAULT 0,
    "discountCents" INTEGER NOT NULL DEFAULT 0,
    "loyaltyDiscountCents" INTEGER NOT NULL DEFAULT 0,
    "totalCents" INTEGER NOT NULL DEFAULT 0,
    "changeCents" INTEGER NOT NULL DEFAULT 0,
    "invoiceId" TEXT,
    "result" JSONB NOT NULL DEFAULT '{}',
    CONSTRAINT "pos_sales_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "pos_sales_tenantId_requestId_key" ON "pos_sales"("tenantId", "requestId");
CREATE INDEX "pos_sales_tenantId_createdAt_idx" ON "pos_sales"("tenantId", "createdAt");
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Its lines (money, tax included), with who did a walk-in service.
CREATE TABLE "pos_sale_lines" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "saleId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "lineIndex" INTEGER NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "serviceId" TEXT,
    "productId" TEXT,
    "appointmentId" TEXT,
    "giftCardId" TEXT,
    "professionalId" TEXT,
    "description" VARCHAR(200) NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPriceCents" INTEGER NOT NULL,
    "discountCents" INTEGER NOT NULL DEFAULT 0,
    "totalCents" INTEGER NOT NULL,
    "taxRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "taxCents" INTEGER NOT NULL DEFAULT 0,
    "commissionBaseCents" INTEGER NOT NULL DEFAULT 0,
    "commissionRate" DECIMAL(5,2),
    "commissionAmount" DECIMAL(12,2),
    "commissionPaid" BOOLEAN NOT NULL DEFAULT false,
    "commissionDate" TIMESTAMP(3),
    CONSTRAINT "pos_sale_lines_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "pos_sale_lines_saleId_idx" ON "pos_sale_lines"("saleId");
CREATE INDEX "pos_sale_lines_tenantId_professionalId_idx" ON "pos_sale_lines"("tenantId", "professionalId");
ALTER TABLE "pos_sale_lines" ADD CONSTRAINT "pos_sale_lines_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "pos_sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The cash-drawer session (arqueo) a sale belongs to: filled by the arqueo
-- feature (follow-up).
ALTER TABLE "pos_sales" ADD COLUMN "cashSessionId" TEXT;
CREATE INDEX "pos_sales_cashSessionId_idx" ON "pos_sales"("cashSessionId");

-- Who recorded each payment at the till: staff see only their own sales.
ALTER TABLE "payments" ADD COLUMN "recordedById" TEXT;
CREATE INDEX "payments_tenantId_recordedById_idx" ON "payments"("tenantId", "recordedById");
