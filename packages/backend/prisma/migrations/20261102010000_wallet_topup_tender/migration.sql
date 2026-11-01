-- Wallet top-ups say how the client paid them, and count in the cash drawer.
-- Additive only: three nullable columns on wallet_transactions, an index and
-- a foreign key. Every existing row gets NULL (a top-up before this recorded
-- no tender), so neither the key nor the check can fail.

ALTER TABLE "wallet_transactions" ADD COLUMN "cashSessionId" TEXT,
ADD COLUMN "method" "PaymentMethod",
ADD COLUMN "recordedById" TEXT;

-- Money the client hands over: cash, card, Bizum or a transfer. A wallet,
-- gift card or points cannot load a wallet.
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_topup_method_check"
  CHECK ("method" IS NULL OR "method" IN ('cash', 'card', 'bizum', 'bank_transfer'));

CREATE INDEX "wallet_transactions_cashSessionId_idx" ON "wallet_transactions"("cashSessionId");

ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_cashSessionId_fkey" FOREIGN KEY ("cashSessionId") REFERENCES "cash_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
