-- CreateTable
CREATE TABLE "product_events" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tenantId" TEXT,
    "props" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_events_name_createdAt_idx" ON "product_events"("name", "createdAt");

-- CreateIndex
CREATE INDEX "product_events_tenantId_name_idx" ON "product_events"("tenantId", "name");

