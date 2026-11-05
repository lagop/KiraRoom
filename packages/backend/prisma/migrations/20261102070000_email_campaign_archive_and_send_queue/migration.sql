-- Email campaigns: archive instead of delete, and sending in the background.
--
-- - email_campaigns.archivedAt: a campaign that emailed anyone is archived,
--   never deleted (deleting it removed its recipient rows, and with them the
--   unsubscribe links already in the clients' inboxes).
-- - email_campaigns.lastError: why the last send stopped or reached nobody.
-- - email_campaign_recipients.attempts / nextAttemptAt: the background sender
--   retries a 429/5xx with backoff, and leases a send in flight.
--
-- Additive only: every column is nullable or has a default, so existing rows
-- keep their meaning (attempts 0, nothing scheduled to retry).

ALTER TABLE "email_campaigns" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "email_campaigns" ADD COLUMN "lastError" TEXT;

ALTER TABLE "email_campaign_recipients" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "email_campaign_recipients" ADD COLUMN "nextAttemptAt" TIMESTAMP(3);

CREATE INDEX "email_campaign_recipients_campaignId_status_idx" ON "email_campaign_recipients"("campaignId", "status");
