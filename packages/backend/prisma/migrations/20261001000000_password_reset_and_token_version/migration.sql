-- Password reset for clients, and a session version for users and clients.
--
-- Nobody could reset a password: users had the two reset columns but no code
-- used them, and clients had neither. And logging out revoked nothing: the
-- tokens stayed valid until they expired. "tokenVersion" goes into each token
-- as "tv"; logging out or changing the password bumps it, and older tokens
-- are refused. Existing tokens carry no "tv" and count as version 0, so this
-- migration signs nobody out.
ALTER TABLE "clients" ADD COLUMN "passwordResetToken" TEXT;
ALTER TABLE "clients" ADD COLUMN "passwordResetExpires" TIMESTAMP(3);
ALTER TABLE "clients" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;
