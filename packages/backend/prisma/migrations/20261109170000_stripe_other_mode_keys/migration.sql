-- The console keeps the unused mode's key pair next to the one in force, so the
-- owner can switch between test and live without pasting keys again.
ALTER TABLE "platform_stripe_config" ADD COLUMN "otherSecretKeyEncrypted" TEXT;
ALTER TABLE "platform_stripe_config" ADD COLUMN "otherPublishableKey" TEXT;
