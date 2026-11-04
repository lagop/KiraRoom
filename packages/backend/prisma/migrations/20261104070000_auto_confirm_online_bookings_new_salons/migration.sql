-- New salons confirm their online bookings automatically (audit 5, D1).
-- Only the column default changes: every existing salon keeps the setting
-- it has today, and can switch it in Configuración → General either way.
ALTER TABLE "tenants" ALTER COLUMN "autoConfirmOnlineBookings" SET DEFAULT true;
