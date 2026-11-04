-- Audit 5 phase 2: the salon's own privacy policy URL, and how each
-- professional appears on the salon's public page.

-- CreateEnum
CREATE TYPE "ProfessionalWebName" AS ENUM ('full', 'initial', 'hidden');

-- AlterTable: optional, nothing to backfill.
ALTER TABLE "tenants" ADD COLUMN "privacyPolicyUrl" TEXT;

-- AlterTable: existing professionals keep what the page showed until now
-- (full name and photo); the column defaults then become the ones for new
-- professionals (first name and initial, no photo).
ALTER TABLE "professionals" ADD COLUMN "webNameDisplay" "ProfessionalWebName" NOT NULL DEFAULT 'full';
ALTER TABLE "professionals" ADD COLUMN "webShowPhoto" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "professionals" ALTER COLUMN "webNameDisplay" SET DEFAULT 'initial';
ALTER TABLE "professionals" ALTER COLUMN "webShowPhoto" SET DEFAULT false;
