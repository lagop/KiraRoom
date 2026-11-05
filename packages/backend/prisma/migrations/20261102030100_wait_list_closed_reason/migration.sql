-- Wait list: why and when an entry was closed by the system (expired) or by
-- the client ("Ya no me interesa"). Nullable, no backfill.
ALTER TABLE "wait_list" ADD COLUMN "closedReason" TEXT;
ALTER TABLE "wait_list" ADD COLUMN "closedAt" TIMESTAMP(3);
