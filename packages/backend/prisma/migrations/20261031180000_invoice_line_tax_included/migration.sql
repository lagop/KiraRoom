-- Whether an invoice line's price was given with the tax included (the
-- salon's "precios incluyen impuesto"), so a rectification that credits part
-- of the line splits it the same way the original did.
--
-- Additive only: a new column with a default. Existing lines read as false
-- and are not backfilled; a full rectification copies their stored amounts,
-- so it does not need the flag.

-- AlterTable
ALTER TABLE "invoice_lines" ADD COLUMN     "taxIncluded" BOOLEAN NOT NULL DEFAULT false;
