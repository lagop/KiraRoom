-- Platform email settings (Resend) set from the SaaS console. Every column is
-- optional: an empty one falls back to the server's .env.
CREATE TABLE "platform_email_config" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "apiKeyEncrypted" TEXT,
    "fromAddress" TEXT,
    "webhookSecretEncrypted" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "platform_email_config_pkey" PRIMARY KEY ("id")
);
