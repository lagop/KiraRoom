-- The cash drawer at the till: opening and closing (apertura y cierre de
-- caja, arqueo). Additive only: two new tables, two enums, a nullable
-- column on payments and on refunds, and the foreign key that
-- pos_sales."cashSessionId" (added empty by 20261101210000) was waiting for.
-- Every existing pos_sales."cashSessionId" is NULL, so the key cannot fail.

CREATE TYPE "CashSessionStatus" AS ENUM ('open', 'closed');
CREATE TYPE "CashMovementType" AS ENUM ('in', 'out');

-- A session: opened with a float, closed with the cash counted. Amounts in
-- cents; expected and discrepancy are worked out and stored at close.
CREATE TABLE "cash_sessions" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "status" "CashSessionStatus" NOT NULL DEFAULT 'open',
    "openedById" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openingFloatCents" INTEGER NOT NULL,
    "openingNotes" VARCHAR(500),
    "closedById" TEXT,
    "closedAt" TIMESTAMP(3),
    "countedCashCents" INTEGER,
    "expectedCashCents" INTEGER,
    "discrepancyCents" INTEGER,
    "closingNotes" VARCHAR(500),
    "countBreakdown" JSONB,
    CONSTRAINT "cash_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "cash_sessions_opening_float_check" CHECK ("openingFloatCents" >= 0),
    CONSTRAINT "cash_sessions_counted_check" CHECK ("countedCashCents" IS NULL OR "countedCashCents" >= 0),
    -- A closed session says who closed it, when, and what was counted.
    CONSTRAINT "cash_sessions_closed_check" CHECK (
        "status" = 'open'
        OR ("closedAt" IS NOT NULL AND "closedById" IS NOT NULL AND "countedCashCents" IS NOT NULL
            AND "expectedCashCents" IS NOT NULL AND "discrepancyCents" IS NOT NULL)
    )
);
CREATE INDEX "cash_sessions_tenantId_openedAt_idx" ON "cash_sessions"("tenantId", "openedAt");
CREATE INDEX "cash_sessions_tenantId_status_idx" ON "cash_sessions"("tenantId", "status");
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- At most ONE open session per salon (the till has no location of its own).
-- Partial: Prisma 5 cannot declare it, so it is documented on the model and
-- lives only here. Two "Abrir caja" at once: the second insert fails (409).
CREATE UNIQUE INDEX "cash_sessions_one_open_per_tenant" ON "cash_sessions"("tenantId") WHERE "status" = 'open';

-- Money put into or taken out of the drawer during a session, with why.
CREATE TABLE "cash_movements" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "type" "CashMovementType" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "reason" VARCHAR(300) NOT NULL,
    "createdById" TEXT NOT NULL,
    CONSTRAINT "cash_movements_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "cash_movements_amount_check" CHECK ("amountCents" > 0)
);
CREATE INDEX "cash_movements_sessionId_idx" ON "cash_movements"("sessionId");
CREATE INDEX "cash_movements_tenantId_createdAt_idx" ON "cash_movements"("tenantId", "createdAt");
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "cash_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The session each sale, payment and refund at the till belongs to.
ALTER TABLE "payments" ADD COLUMN "cashSessionId" TEXT;
CREATE INDEX "payments_cashSessionId_idx" ON "payments"("cashSessionId");
ALTER TABLE "payments" ADD CONSTRAINT "payments_cashSessionId_fkey" FOREIGN KEY ("cashSessionId") REFERENCES "cash_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "refunds" ADD COLUMN "cashSessionId" TEXT;
CREATE INDEX "refunds_cashSessionId_idx" ON "refunds"("cashSessionId");
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_cashSessionId_fkey" FOREIGN KEY ("cashSessionId") REFERENCES "cash_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_cashSessionId_fkey" FOREIGN KEY ("cashSessionId") REFERENCES "cash_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
