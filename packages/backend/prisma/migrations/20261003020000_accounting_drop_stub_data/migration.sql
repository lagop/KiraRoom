-- Data only, no schema change.
--
-- The accounting integration used to be a stub: "connecting" Holded or Sage
-- stored random tokens, and every "synced" invoice got an id computed
-- locally (inv-..., sage-..., a3-stub-..., ncs-stub-...) that never existed in
-- any accounting program. Holded is now a real sync keyed on the salon's own
-- API key. Nothing the stub stored is usable by it, and a fake external id
-- would make the real sync believe an invoice had already been sent, so the
-- salon would never get it into Holded. Clear all three.

UPDATE "invoices"
SET "accountingExternalId" = NULL,
    "accountingSyncedAt"   = NULL,
    "accountingStatus"     = 'not_synced',
    "accountingError"      = NULL
WHERE "accountingExternalId" IS NOT NULL
   OR "accountingStatus" <> 'not_synced';

DELETE FROM "accounting_sync_logs";

DELETE FROM "accounting_connections";
