-- The "Reseñas tras la cita" add-on asks by WhatsApp again: to clients who
-- asked for their appointment notices by WhatsApp, once Meta approves the
-- salon's review template (a utility template the salon submits from the
-- Reseñas settings), and by email to everyone else. No SMS. Text only.
UPDATE "add_ons"
SET "description" = 'Después de cada cita, pide su opinión a la clienta: por WhatsApp si pidió los avisos de sus citas por WhatsApp (con tu plantilla aprobada por Meta) y, si no, por email. Le ofrece dejarla también en tu ficha de Google con un clic. Tú moderas las reseñas desde el panel.',
    "updatedAt" = NOW()
WHERE "key" = 'google_reviews_auto';
