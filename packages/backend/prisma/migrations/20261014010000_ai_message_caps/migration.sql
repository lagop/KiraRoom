-- Every plan has an AI message cap now (Esencial 500, Pro 2,000, Empresa
-- 3,000 per location, trial 500), plus a daily share of it.

ALTER TABLE "tenants"
  ADD COLUMN "aiMessagesToday" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "aiMessagesDay" TEXT,
  ADD COLUMN "aiCapNotifiedOn" TEXT;

-- The AI pack: 1,000 more messages a month for 19 EUR, on any plan.
-- No unlocks: it adds messages, not features.
INSERT INTO "add_ons" ("id", "key", "name", "description", "monthlyPriceCents", "currency", "unlocks", "metered", "isActive", "purchasable", "sortOrder", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::text, 'ai_messages_1000', '1.000 mensajes de IA', '1.000 mensajes más al mes para la recepcionista IA, en cualquier plan.', 1900, 'EUR', '[]', false, true, true, 10, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "monthlyPriceCents" = EXCLUDED."monthlyPriceCents",
  "unlocks" = EXCLUDED."unlocks",
  "isActive" = true,
  "purchasable" = true,
  "updatedAt" = CURRENT_TIMESTAMP;

-- The old "IA Expansion" (24 EUR, no cap at all) is no longer sold. A salon
-- that still has it active counts it as one pack of 1,000 messages.
UPDATE "add_ons"
SET "purchasable" = false,
    "description" = 'Ya no se vende: cuenta como un paquete de 1.000 mensajes de IA.',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'ai_expansion';
