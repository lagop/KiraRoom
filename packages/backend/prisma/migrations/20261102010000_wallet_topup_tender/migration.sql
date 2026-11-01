-- Wallet top-ups and withdrawals say how the money was paid in or handed
-- back, and count in the cash drawer. Additive only: three nullable columns
-- on wallet_transactions, an index, a check and a foreign key. Every
-- existing row gets NULL (no tender was recorded before this), so neither
-- the key nor the check can fail.

ALTER TABLE "wallet_transactions" ADD COLUMN "cashSessionId" TEXT,
ADD COLUMN "method" "PaymentMethod",
ADD COLUMN "recordedById" TEXT;

-- Real money: cash, card, Bizum or a transfer. A wallet, gift card or
-- points cannot load a wallet or be handed back from one.
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_topup_method_check"
  CHECK ("method" IS NULL OR "method" IN ('cash', 'card', 'bizum', 'bank_transfer'));

CREATE INDEX "wallet_transactions_cashSessionId_idx" ON "wallet_transactions"("cashSessionId");

ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_cashSessionId_fkey" FOREIGN KEY ("cashSessionId") REFERENCES "cash_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
