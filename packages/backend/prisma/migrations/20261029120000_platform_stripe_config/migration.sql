-- KiraRoom's own Stripe account settings, set from the SaaS console. Every
-- column is optional: an empty one falls back to the server's .env.
CREATE TABLE "platform_stripe_config" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "secretKeyEncrypted" TEXT,
    "publishableKey" TEXT,
    "webhookSecretEncrypted" TEXT,
    "taxEnabled" BOOLEAN,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "platform_stripe_config_pkey" PRIMARY KEY ("id")
);
