-- The other mode's webhook signing secret (audit 8 P8), encrypted like the
-- other secrets: events of that mode are verified and acknowledged, not
-- applied, instead of failing with a 400 until Stripe disables the endpoint.
ALTER TABLE "platform_stripe_config" ADD COLUMN "otherWebhookSecretEncrypted" TEXT;
