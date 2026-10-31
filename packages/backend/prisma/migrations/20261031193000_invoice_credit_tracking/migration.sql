-- Partial credits across separate rectificativas, tracked per line.
--
-- Each line of a rectificativa that credits a line of the original names it
-- (rectifiesLineId), so what is left to credit of a line is its amounts minus
-- every non-cancelled rectificativa line naming it, and two partial
-- rectificativas can no longer credit the same line twice.
--
-- A discount given at the till on an appointment already invoiced is issued
-- as a rectificativa by difference; the discount's record names it
-- (pos_discounts.rectificationInvoiceId).
--
-- Additive only: two nullable columns, a self-referencing foreign key and an
-- index. Existing rows are not backfilled: rectificativas issued before this
-- have no line link and count against their original invoice as a whole
-- (invoices.service.ts, priorCredits).

-- AlterTable
ALTER TABLE "invoice_lines" ADD COLUMN     "rectifiesLineId" TEXT;

-- AlterTable
ALTER TABLE "pos_discounts" ADD COLUMN     "rectificationInvoiceId" TEXT;

-- CreateIndex
CREATE INDEX "invoice_lines_rectifiesLineId_idx" ON "invoice_lines"("rectifiesLineId");

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_rectifiesLineId_fkey" FOREIGN KEY ("rectifiesLineId") REFERENCES "invoice_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;
