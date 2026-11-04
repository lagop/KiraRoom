-- Who accepted which version of the Terms of Service (they include the
-- art. 28 GDPR data processing agreement) and the Privacy Policy, when and
-- from which address. Written on signup and on invite acceptance from now
-- on. Additive: a new table, nothing existing changes. Salons created
-- before this have no row (whether to ask them again is a pending decision).

CREATE TABLE "legal_acceptances" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "acceptedByUserId" TEXT,
    "termsVersion" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "source" TEXT NOT NULL,

    CONSTRAINT "legal_acceptances_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "legal_acceptances_tenantId_acceptedAt_idx" ON "legal_acceptances"("tenantId", "acceptedAt");

ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
