-- D27: the onboarding wizard's test booking and its test client are marked,
-- so every figure leaves them out and a daily job deletes them the next
-- salon day. Additive: false for every existing row (a constant default, no
-- table rewrite on PostgreSQL 11+).
ALTER TABLE "appointments" ADD COLUMN "isTest" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "clients" ADD COLUMN "isTest" BOOLEAN NOT NULL DEFAULT false;

-- The cleanup job finds the few test rows without scanning the tables.
CREATE INDEX "appointments_isTest_idx" ON "appointments"("isTest") WHERE "isTest" = true;
