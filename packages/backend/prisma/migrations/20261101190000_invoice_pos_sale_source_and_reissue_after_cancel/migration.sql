-- Two changes to how an invoice is tied to what it was issued for.
--
-- 1. A cancelled invoice no longer blocks issuing a new one for the same
--    source. "One invoice per source" (20261031130000_invoice_once_per_source)
--    was a plain unique index on (tenantId, sourceType, sourceId), so once an
--    appointment's invoice was cancelled (a wrong client, a wrong NIF) the
--    appointment could never be invoiced again. The index becomes partial:
--    one LIVE invoice per source; cancelled ones stay, with their sourceId, as
--    the record of what happened. Existing rows satisfied the stricter full
--    index, so they satisfy this one too. Prisma 5 cannot express a partial
--    index: schema.prisma no longer declares this one (an @@unique there would
--    make `prisma migrate dev` replace it with a full one); it lives only here,
--    under its old name.
--
-- 2. InvoiceSource gains 'pos_sale': the simplified invoice (factura
--    simplificada, series T) of a sale at the till, one per sale
--    (InvoiceService.issueSimplifiedInvoiceForSale). Only added here; no row
--    uses it until the till issues them.

ALTER TYPE "InvoiceSource" ADD VALUE IF NOT EXISTS 'pos_sale';

DROP INDEX IF EXISTS "invoices_tenantId_sourceType_sourceId_key";

CREATE UNIQUE INDEX "invoices_tenantId_sourceType_sourceId_key"
  ON "invoices"("tenantId", "sourceType", "sourceId")
  WHERE "status" <> 'cancelled';
