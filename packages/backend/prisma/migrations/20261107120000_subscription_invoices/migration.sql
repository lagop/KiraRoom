-- CreateTable
CREATE TABLE "subscription_invoices" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "stripeInvoiceId" TEXT NOT NULL,
    "tenantId" TEXT,
    "tenantName" TEXT NOT NULL,
    "stripeCustomerId" TEXT NOT NULL,
    "stripeChargeId" TEXT,
    "livemode" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL,
    "number" TEXT,
    "currency" TEXT NOT NULL,
    "amountDueCents" INTEGER NOT NULL,
    "amountPaidCents" INTEGER NOT NULL,
    "amountRefundedCents" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "invoiceCreatedAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "attemptCount" INTEGER,
    "hostedInvoiceUrl" TEXT,
    "invoicePdfUrl" TEXT,

    CONSTRAINT "subscription_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "subscription_invoices_stripeInvoiceId_key" ON "subscription_invoices"("stripeInvoiceId");

-- CreateIndex
CREATE INDEX "subscription_invoices_tenantId_invoiceCreatedAt_idx" ON "subscription_invoices"("tenantId", "invoiceCreatedAt");

-- CreateIndex
CREATE INDEX "subscription_invoices_livemode_invoiceCreatedAt_idx" ON "subscription_invoices"("livemode", "invoiceCreatedAt");

-- CreateIndex
CREATE INDEX "subscription_invoices_stripeChargeId_idx" ON "subscription_invoices"("stripeChargeId");

-- AddForeignKey
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
