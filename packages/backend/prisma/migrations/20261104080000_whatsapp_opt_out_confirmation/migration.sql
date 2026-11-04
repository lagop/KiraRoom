-- Channels audit phase 2 (D23): a BAJA is answered with a confirmation, once.
-- Additive: rows already processed have their phone wiped, so they are never confirmed.
ALTER TABLE "whatsapp_opt_outs" ADD COLUMN "confirmedAt" TIMESTAMP(3);
