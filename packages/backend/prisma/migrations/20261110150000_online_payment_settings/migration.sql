-- Online payments (señal / pago anticipado): per-service prepayment option and
-- the salon's exemption of returning clients from the señal.
ALTER TABLE "services" ADD COLUMN "allowPrepay" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tenants" ADD COLUMN "depositExemptReturning" BOOLEAN NOT NULL DEFAULT true;
