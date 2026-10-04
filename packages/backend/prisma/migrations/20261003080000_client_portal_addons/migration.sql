-- Client portal: a client's choice about commercial communications is a
-- Consent record against a per-salon system form with purpose 'marketing'.
ALTER TABLE "consent_forms" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'service';
CREATE INDEX "consent_forms_tenantId_purpose_idx" ON "consent_forms"("tenantId", "purpose");

-- Add-ons: only the ones that work can be bought; the Stripe item of each
-- purchase is tied to its subscription and to the price it bills.
ALTER TABLE "add_ons" ADD COLUMN "purchasable" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tenant_add_ons" ADD COLUMN "stripeSubscriptionId" TEXT;
ALTER TABLE "tenant_add_ons" ADD COLUMN "monthlyPriceCents" INTEGER;

-- The catalogue. No migration ever inserted it (the table came from the
-- baseline, empty), so a fresh database had nothing to sell. Rows that
-- already exist keep their name, description, price and unlocks when set;
-- only `purchasable` is decided here:
--   ai_expansion, loyalty_giftcards, email_marketing: the features they
--     unlock are gated by plan and work, so they can be bought.
--   multichannel, google_reviews_auto, web_domain: being finished in their
--     own pull requests, which turn the flag on when they land.
--   deposits_antinoshow: deposits are not gated by it -- every salon already
--     has them -- so selling it would charge for nothing.
INSERT INTO "add_ons" ("id", "key", "name", "description", "monthlyPriceCents", "currency", "unlocks", "metered", "isActive", "purchasable", "sortOrder", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::text, 'ai_expansion', 'IA Expansion', 'Quita el límite de 500 conversaciones al mes y desbloquea cancelaciones, cambios de cita y derivaciones automáticas.', 2400, 'EUR', '["virtual_receptionist_advanced"]', false, true, true, 10, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'loyalty_giftcards', 'Fidelización y tarjetas regalo', 'Puntos, promociones y tarjetas regalo para que tus clientas vuelvan.', 1200, 'EUR', '["loyalty","promotions","gift_cards"]', false, true, true, 20, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'email_marketing', 'Email marketing', 'Campañas de email segmentadas por audiencia.', 1200, 'EUR', '["email_marketing"]', false, true, true, 30, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'multichannel', 'Multicanal', 'Messenger, Instagram y Telegram atendidos por la recepcionista IA.', 1900, 'EUR', '["multichannel"]', false, true, false, 40, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'google_reviews_auto', 'Reseñas de Google automáticas', 'Invitación automática a dejar reseña en Google después de cada cita.', 1900, 'EUR', '[]', false, true, false, 50, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'web_domain', 'Dominio personalizado', 'Tu web de reservas en tu propio dominio, con SSL.', 1500, 'EUR', '[]', false, true, false, 60, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'deposits_antinoshow', 'Depósitos anti-plantón', 'Cobra una señal al reservar para reducir las ausencias.', 500, 'EUR', '[]', false, true, false, 70, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO UPDATE SET
  "monthlyPriceCents" = COALESCE("add_ons"."monthlyPriceCents", EXCLUDED."monthlyPriceCents"),
  "unlocks" = CASE WHEN "add_ons"."unlocks" = '[]'::jsonb THEN EXCLUDED."unlocks" ELSE "add_ons"."unlocks" END,
  "description" = COALESCE("add_ons"."description", EXCLUDED."description"),
  "purchasable" = EXCLUDED."purchasable",
  "updatedAt" = CURRENT_TIMESTAMP;
