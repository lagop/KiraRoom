-- The Copilot's own usage counter per salon and UTC day (Copilot audit
-- M2/M3): questions asked (daily cap) and real model cost (monthly cap).
-- It no longer adds to tenants."aiConversationsUsed", the receptionist's.
CREATE TABLE "copilot_usage_days" (
    "tenantId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "messages" INTEGER NOT NULL DEFAULT 0,
    "costMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "copilot_usage_days_pkey" PRIMARY KEY ("tenantId","day")
);

CREATE INDEX "copilot_usage_days_day_idx" ON "copilot_usage_days"("day");
