-- Receptionist channels audit (M1, M5, M11, M13). Additive only.

-- WhatsApp: is KiraRoom's app subscribed to the account, when did the last
-- event arrive, and has Meta refused the token (and was the owner told).
ALTER TABLE "whatsapp_connections" ADD COLUMN     "attentionNotifiedAt" TIMESTAMP(3),
ADD COLUMN     "authError" TEXT,
ADD COLUMN     "authErrorAt" TIMESTAMP(3),
ADD COLUMN     "lastInboundAt" TIMESTAMP(3),
ADD COLUMN     "webhookError" TEXT,
ADD COLUMN     "webhookSubscribedAt" TIMESTAMP(3);

-- "BAJA" replies, written before anything else is done with them.
CREATE TABLE "whatsapp_opt_outs" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3),
    "clientsFound" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "whatsapp_opt_outs_pkey" PRIMARY KEY ("id")
);

-- Facebook Page / Instagram account / Telegram bot per salon, unique across salons.
CREATE TABLE "channel_accounts" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "channel" "ChatChannel" NOT NULL,
    "externalId" TEXT NOT NULL,
    "authErrorAt" TIMESTAMP(3),
    "authError" TEXT,
    "attentionNotifiedAt" TIMESTAMP(3),

    CONSTRAINT "channel_accounts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "whatsapp_opt_outs_processedAt_idx" ON "whatsapp_opt_outs"("processedAt");
CREATE UNIQUE INDEX "whatsapp_opt_outs_tenantId_messageId_key" ON "whatsapp_opt_outs"("tenantId", "messageId");
CREATE UNIQUE INDEX "channel_accounts_channel_externalId_key" ON "channel_accounts"("channel", "externalId");
CREATE UNIQUE INDEX "channel_accounts_tenantId_channel_key" ON "channel_accounts"("tenantId", "channel");

ALTER TABLE "whatsapp_opt_outs" ADD CONSTRAINT "whatsapp_opt_outs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "channel_accounts" ADD CONSTRAINT "channel_accounts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The accounts already connected, from Tenant.features.multichannel. When
-- two salons hold the same one (possible before), the one that connected it
-- first keeps it, as the "ya está conectada a otro salón" check intended.
INSERT INTO "channel_accounts" ("id", "tenantId", "channel", "externalId", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, t."id", 'facebook'::"ChatChannel", t."features"->'multichannel'->'meta'->>'pageId', NOW(), NOW()
FROM "tenants" t
WHERE jsonb_typeof(t."features") = 'object'
  AND COALESCE(t."features"->'multichannel'->'meta'->>'pageId', '') <> ''
ORDER BY t."features"->'multichannel'->'meta'->>'connectedAt' NULLS LAST, t."createdAt"
ON CONFLICT DO NOTHING;

INSERT INTO "channel_accounts" ("id", "tenantId", "channel", "externalId", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, t."id", 'instagram'::"ChatChannel", t."features"->'multichannel'->'meta'->>'instagramBusinessAccountId', NOW(), NOW()
FROM "tenants" t
WHERE jsonb_typeof(t."features") = 'object'
  AND COALESCE(t."features"->'multichannel'->'meta'->>'instagramBusinessAccountId', '') <> ''
ORDER BY t."features"->'multichannel'->'meta'->>'connectedAt' NULLS LAST, t."createdAt"
ON CONFLICT DO NOTHING;

INSERT INTO "channel_accounts" ("id", "tenantId", "channel", "externalId", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, t."id", 'telegram'::"ChatChannel", t."features"->'multichannel'->'telegram'->>'botId', NOW(), NOW()
FROM "tenants" t
WHERE jsonb_typeof(t."features") = 'object'
  AND COALESCE(t."features"->'multichannel'->'telegram'->>'botId', '') <> ''
ORDER BY t."features"->'multichannel'->'telegram'->>'connectedAt' NULLS LAST, t."createdAt"
ON CONFLICT DO NOTHING;

-- One active connection per WhatsApp number: two connections racing past
-- the "already connected" check both got saved, and the number then routed
-- nowhere. Partial (inactive rows and the empty id are not numbers in use),
-- so Prisma cannot declare it: documented on the model, lives only here.
-- Created only when no number is held twice already, so the migration
-- cannot fail on existing data (those numbers keep routing nowhere, as now,
-- and are logged by WhatsAppService).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "whatsapp_connections"
    WHERE "isActive" AND "phoneNumberId" <> ''
    GROUP BY "phoneNumberId" HAVING COUNT(*) > 1
  ) THEN
    CREATE UNIQUE INDEX "whatsapp_connections_active_phone_number_key"
      ON "whatsapp_connections"("phoneNumberId")
      WHERE "isActive" AND "phoneNumberId" <> '';
  ELSE
    RAISE NOTICE 'whatsapp_connections: a phone number is active in two salons; unique index not created';
  END IF;
END $$;
