-- Reviews: rejection only with a listed reason (who and when), the client's
-- consent to show her review on the salon's site, the request email's id
-- (bounces and complaints suppress the address), and retries of a request
-- that failed to send. Additive.
ALTER TABLE "reviews" ADD COLUMN "moderationReason" TEXT;
ALTER TABLE "reviews" ADD COLUMN "moderatedById" TEXT;
ALTER TABLE "reviews" ADD COLUMN "moderatedAt" TIMESTAMP(3);
-- Every existing review was answered under the old notice ("podrá aparecer
-- en su página de reservas con tu nombre y la inicial de tu apellido").
ALTER TABLE "reviews" ADD COLUMN "publishConsent" TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE "reviews" ADD COLUMN "publishConsentVersion" TEXT;
ALTER TABLE "reviews" ADD COLUMN "publishConsentAt" TIMESTAMP(3);
ALTER TABLE "reviews" ADD COLUMN "requestMessageId" TEXT;
CREATE UNIQUE INDEX "reviews_requestMessageId_key" ON "reviews"("requestMessageId");

-- Rejections from before reasons existed: still excluded, flagged in the
-- panel so the salon can approve them or pick a reason.
UPDATE "reviews" SET "moderationReason" = 'legacy_unspecified'
WHERE "status" = 'rejected' AND "moderationReason" IS NULL;

ALTER TABLE "appointments" ADD COLUMN "reviewRequestAttempts" INTEGER NOT NULL DEFAULT 0;
