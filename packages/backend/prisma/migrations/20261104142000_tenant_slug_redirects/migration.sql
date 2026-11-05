-- D4 (2026-11-04): the owner can change the salon's web address once. The
-- old address redirects (301) to the new one for 12 months, then is free.
ALTER TABLE "tenants" ADD COLUMN "slugChangedAt" TIMESTAMP(3);

CREATE TABLE "tenant_slug_redirects" (
    "id" TEXT NOT NULL,
    "oldSlug" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_slug_redirects_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenant_slug_redirects_oldSlug_key" ON "tenant_slug_redirects"("oldSlug");
CREATE INDEX "tenant_slug_redirects_tenantId_idx" ON "tenant_slug_redirects"("tenantId");

ALTER TABLE "tenant_slug_redirects" ADD CONSTRAINT "tenant_slug_redirects_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
