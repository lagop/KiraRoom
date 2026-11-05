-- The "Reseñas tras la cita" add-on asks by email only: since client
-- accounts went away nobody can turn on WhatsApp or SMS review requests, so
-- its description no longer promises them.
UPDATE "add_ons"
SET "description" = 'Después de cada cita, pide su opinión a la clienta por email y le ofrece dejarla también en tu ficha de Google con un clic. Tú moderas las reseñas desde el panel.',
    "updatedAt" = NOW()
WHERE "key" = 'google_reviews_auto';
