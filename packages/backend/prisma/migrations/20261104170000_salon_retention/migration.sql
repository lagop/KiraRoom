-- Audit 7 D7: retention of a salon that left (read-only 30 days, then
-- anonymised 30 days later) and the owner's own "Borrar mi salón".
-- Additive: nullable columns, nothing is written to existing rows.
ALTER TABLE "tenants" ADD COLUMN "anonymizationWarnedAt" TIMESTAMP(3);
ALTER TABLE "tenants" ADD COLUMN "anonymizationWarnedFor" TIMESTAMP(3);
ALTER TABLE "tenants" ADD COLUMN "anonymizedAt" TIMESTAMP(3);
ALTER TABLE "tenants" ADD COLUMN "deletionRequestedAt" TIMESTAMP(3);
ALTER TABLE "tenants" ADD COLUMN "deletionRestore" JSONB;
