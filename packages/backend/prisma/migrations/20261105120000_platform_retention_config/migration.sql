-- The switch for the salon-data retention job, flipped by the saas_owner in
-- the console. Additive: a new table, no row until the owner saves; with no
-- row the job stays a dry run (RETENTION_ANONYMIZE_ENABLED=true still turns it on).
CREATE TABLE "platform_retention_config" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "platform_retention_config_pkey" PRIMARY KEY ("id")
);
