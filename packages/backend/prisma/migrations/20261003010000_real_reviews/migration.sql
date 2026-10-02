-- Real review requests: the Google "write a review" link the salon enters,
-- when the client answered and whether they opened Google, and SMS as a
-- request channel.

-- AlterEnum
ALTER TYPE "ReviewSource" ADD VALUE 'sms_link' AFTER 'email_link';

-- AlterTable
ALTER TABLE "google_business_profiles" ADD COLUMN "placeId" TEXT,
ADD COLUMN "writeReviewUrl" TEXT;

-- AlterTable
ALTER TABLE "reviews" ADD COLUMN "googleLinkClickedAt" TIMESTAMP(3),
ADD COLUMN "submittedAt" TIMESTAMP(3);

-- The add-on was sold as "Reseñas Google auto" and unlocked nothing: no code
-- checked it. It now gates the automatic post-visit review requests, so it
-- unlocks the key the dispatcher checks, and its copy says what it does
-- (it does not post anything to Google: only the client can do that).
UPDATE "add_ons"
SET "unlocks" = '["google_reviews_auto"]'::jsonb,
    "name" = 'Reseñas tras la cita',
    "description" = 'Después de cada cita, pide su opinión a la clienta por email (o WhatsApp/SMS si lo tiene activado) y le ofrece dejarla también en tu ficha de Google con un clic. Tú moderas las reseñas desde el panel.',
    "updatedAt" = NOW()
WHERE "key" = 'google_reviews_auto';
