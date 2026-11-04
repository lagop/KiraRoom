-- D1 (2026-11-04): from this deploy, a salon whose owner has not confirmed
-- their email cannot send email campaigns or mass SMS / WhatsApp, cannot
-- connect its own Stripe account, and its web page is noindex and out of the
-- sitemaps (auth/email-verified/owner-email-verified.ts).
--
-- Salons that already exist were never asked to confirm under this rule and
-- some of them already send campaigns: their owners are treated as confirmed,
-- so nothing they use today stops working. Only salons created after this
-- deploy start unconfirmed. Runs once; owners added later are not touched.
UPDATE "users"
SET "isEmailVerified" = true
WHERE "role" = 'owner'
  AND "isEmailVerified" = false
  AND "tenantId" IN (SELECT "id" FROM "tenants" WHERE "createdAt" < now());
