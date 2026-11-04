-- Audit 8 D2: whether the salon's owner lets KiraRoom support into her
-- panel. On by default, so every existing salon keeps today's behaviour.
ALTER TABLE "tenants" ADD COLUMN "allowSupportAccess" BOOLEAN NOT NULL DEFAULT true;
