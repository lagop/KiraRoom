-- Two-step sign-in for panel users. "twoFactorEnabled" and "twoFactorSecret"
-- exist since the first migration and were never used; these add the secret
-- waiting for confirmation, the last accepted step and the recovery codes.
ALTER TABLE "users" ADD COLUMN "twoFactorPendingSecret" TEXT;
ALTER TABLE "users" ADD COLUMN "twoFactorLastStep" INTEGER;
ALTER TABLE "users" ADD COLUMN "twoFactorRecoveryCodes" TEXT[] DEFAULT ARRAY[]::TEXT[];
