-- CreateTable
CREATE TABLE "tenant_llm_usage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" BIGINT NOT NULL DEFAULT 0,
    "cachedInputTokens" BIGINT NOT NULL DEFAULT 0,
    "cacheWriteTokens" BIGINT NOT NULL DEFAULT 0,
    "outputTokens" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_llm_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tenant_llm_usage_period_idx" ON "tenant_llm_usage"("period");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_llm_usage_tenantId_period_provider_model_key" ON "tenant_llm_usage"("tenantId", "period", "provider", "model");

