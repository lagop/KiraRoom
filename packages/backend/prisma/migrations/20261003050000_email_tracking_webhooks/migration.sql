-- Resend delivery events, recorded per campaign recipient.

-- Spam complaints, counted per campaign like bounces.
ALTER TABLE "email_campaigns" ADD COLUMN "complaints" INTEGER NOT NULL DEFAULT 0;

-- When the recipient marked the email as spam.
ALTER TABLE "email_campaign_recipients" ADD COLUMN "complainedAt" TIMESTAMP(3);

-- The webhook finds the recipient by the id Resend returned on send.
CREATE INDEX "email_campaign_recipients_messageId_idx" ON "email_campaign_recipients"("messageId");

-- svix-id of the webhook delivery: a redelivered event is recognised.
ALTER TABLE "email_campaign_analytics" ADD COLUMN "eventId" TEXT;
CREATE UNIQUE INDEX "email_campaign_analytics_eventId_key" ON "email_campaign_analytics"("eventId");

-- Addresses a salon's marketing must skip: hard bounces and complaints.
CREATE TABLE "email_suppressions" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "detail" TEXT,

    CONSTRAINT "email_suppressions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "email_suppressions_tenantId_email_key" ON "email_suppressions"("tenantId", "email");

ALTER TABLE "email_suppressions" ADD CONSTRAINT "email_suppressions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
