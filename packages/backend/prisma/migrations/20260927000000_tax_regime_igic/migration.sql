-- Canary Islands support: IGIC instead of IVA.
--
-- Three changes, all additive and safe on a live database.
--
-- 1. A new value on the TaxReportType enum for the IGIC quarterly return
--    (Modelo 420, filed with the Agencia Tributaria Canaria rather than the
--    AEAT). Postgres appends an enum value without rewriting any table. It is
--    not referenced later in this migration, which is what makes it legal
--    inside the transaction Prisma wraps around it.
--
-- 2. A `taxRegime` key on every existing tenant's fiscalSettings, set to
--    "iva" so nothing changes for anyone today. The code also reads a missing
--    key as "iva", so this backfill is belt and braces rather than required.
--
-- 3. The column default, so new tenants carry the key from the start and
--    schema.prisma stops drifting from the database.

-- AlterEnum
ALTER TYPE "TaxReportType" ADD VALUE 'modelo_420';

-- Backfill: give every existing tenant an explicit regime.
-- fiscalSettings is JSONB NOT NULL, so there is no null case to handle.
UPDATE "tenants"
SET "fiscalSettings" = jsonb_set("fiscalSettings", '{taxRegime}', '"iva"', true)
WHERE NOT ("fiscalSettings" ? 'taxRegime');

-- AlterTable
ALTER TABLE "tenants"
ALTER COLUMN "fiscalSettings" SET DEFAULT '{"defaultSeries": "A", "defaultTaxRate": 21, "autoInvoiceAppointments": false, "diputacion": null, "taxRegime": "iva"}';
