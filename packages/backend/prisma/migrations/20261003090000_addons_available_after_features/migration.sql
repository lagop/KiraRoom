-- Runs after the add-on catalogue seed (20261003080000), which left these two
-- as "Próximamente" while their features were still being finished:
--   multichannel: the receptionist now answers on Messenger, Instagram and
--     Telegram (channels module).
--   google_reviews_auto: post-visit review requests with the Google link.
-- The reviews migration (20261003010000) renamed that add-on and pointed it
-- at the feature it unlocks, but it runs before the seed, so on a database
-- where the row did not exist yet it changed nothing: repeat it here.
UPDATE "add_ons"
SET "unlocks" = '["google_reviews_auto"]'::jsonb,
    "name" = 'Reseñas tras la cita',
    "description" = 'Después de cada cita, pide su opinión a la clienta por email (o WhatsApp/SMS si lo tiene activado) y le ofrece dejarla también en tu ficha de Google con un clic. Tú moderas las reseñas desde el panel.',
    "purchasable" = true,
    "updatedAt" = NOW()
WHERE "key" = 'google_reviews_auto';

UPDATE "add_ons"
SET "purchasable" = true,
    "updatedAt" = NOW()
WHERE "key" = 'multichannel';
