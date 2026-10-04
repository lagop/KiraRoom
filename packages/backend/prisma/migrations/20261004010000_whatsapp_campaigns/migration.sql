-- WhatsApp campaigns: the message the salon writes becomes a Meta MARKETING
-- template on its own WhatsApp Business account, reviewed by Meta, and is
-- sent only to clients who opted in to WhatsApp promotions.
ALTER TABLE "whatsapp_campaigns" ADD COLUMN "body" TEXT NOT NULL DEFAULT '';
ALTER TABLE "whatsapp_campaigns" ADD COLUMN "templateStatus" TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE "whatsapp_campaigns" ADD COLUMN "templateReason" TEXT;
ALTER TABLE "whatsapp_campaigns" ADD COLUMN "submittedAt" TIMESTAMP(3);
ALTER TABLE "whatsapp_campaigns" ADD COLUMN "createdById" TEXT;
ALTER TABLE "whatsapp_campaigns" ADD COLUMN "lastError" TEXT;

-- The old endpoint could create a recipient twice; keep the first of each.
DELETE FROM "whatsapp_campaign_recipients" r
USING "whatsapp_campaign_recipients" d
WHERE r."campaignId" = d."campaignId"
  AND r."clientId" = d."clientId"
  AND (r."createdAt", r."id") > (d."createdAt", d."id");

CREATE UNIQUE INDEX "whatsapp_campaign_recipients_campaignId_clientId_key" ON "whatsapp_campaign_recipients"("campaignId", "clientId");
CREATE INDEX "whatsapp_campaign_recipients_messageId_idx" ON "whatsapp_campaign_recipients"("messageId");
