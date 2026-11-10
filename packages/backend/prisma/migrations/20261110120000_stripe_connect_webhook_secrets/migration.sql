-- Signing secrets of the Stripe webhook for connected accounts, one per mode.
ALTER TABLE "platform_stripe_config" ADD COLUMN "connectWebhookSecretTestEncrypted" TEXT;
ALTER TABLE "platform_stripe_config" ADD COLUMN "connectWebhookSecretLiveEncrypted" TEXT;
