-- Audit 8 D14: bug reports lose their personal data 12 months after they
-- are closed, and when their salon is anonymised. resolvedAt is the closing
-- date (set when a report becomes resolved / wont_fix / duplicate).
ALTER TABLE "bug_reports" ADD COLUMN "anonymizedAt" TIMESTAMP(3);

CREATE INDEX "bug_reports_resolvedAt_idx" ON "bug_reports"("resolvedAt");

-- Closed reports without a closing date (none expected): their last update
-- is the best date there is.
UPDATE "bug_reports"
SET "resolvedAt" = "updatedAt"
WHERE "resolvedAt" IS NULL
  AND "status" IN ('resolved', 'wont_fix', 'duplicate');
