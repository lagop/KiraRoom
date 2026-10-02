-- Loyalty: how points are earned, enrolment, and a ledger of every movement.
ALTER TABLE "loyalty_programs" ADD COLUMN "earnMode" TEXT NOT NULL DEFAULT 'per_euro';
ALTER TABLE "loyalty_programs" ADD COLUMN "pointsPerVisit" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "loyalty_programs" ADD COLUMN "autoEnroll" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "loyalty_programs" ADD COLUMN "allowSelfEnroll" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "loyalty_members" ADD COLUMN "enrolledVia" TEXT;

ALTER TABLE "loyalty_redemptions" ADD COLUMN "posSaleId" TEXT;

CREATE TABLE "loyalty_transactions" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "sourceId" TEXT,
    "description" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdById" TEXT,

    CONSTRAINT "loyalty_transactions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "loyalty_transactions_memberId_type_source_sourceId_key" ON "loyalty_transactions"("memberId", "type", "source", "sourceId");
CREATE INDEX "loyalty_transactions_tenantId_createdAt_idx" ON "loyalty_transactions"("tenantId", "createdAt");
CREATE INDEX "loyalty_transactions_memberId_createdAt_idx" ON "loyalty_transactions"("memberId", "createdAt");
CREATE INDEX "loyalty_transactions_tenantId_source_sourceId_idx" ON "loyalty_transactions"("tenantId", "source", "sourceId");

ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_programId_fkey" FOREIGN KEY ("programId") REFERENCES "loyalty_programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "loyalty_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Wait-list: what the last notice did, and automatic notices on cancellation.
ALTER TABLE "wait_list" ADD COLUMN "lastNotification" JSONB;
ALTER TABLE "wait_list" ADD COLUMN "notifyCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "tenants" ADD COLUMN "waitListAutoNotify" BOOLEAN NOT NULL DEFAULT false;

ALTER TYPE "NotificationType" ADD VALUE 'waitlist_slot_available';
