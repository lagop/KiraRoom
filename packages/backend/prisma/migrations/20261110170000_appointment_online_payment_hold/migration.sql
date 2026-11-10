-- Online payment at booking: the slot is held while the client pays on the
-- salon's Stripe account; paid, it becomes the booking, unpaid it is deleted.
ALTER TABLE "appointments" ADD COLUMN "paymentHoldUntil" TIMESTAMP(3);
ALTER TABLE "appointments" ADD COLUMN "checkoutSessionId" TEXT;
ALTER TABLE "appointments" ADD COLUMN "onlinePaymentKind" TEXT;
ALTER TABLE "appointments" ADD COLUMN "statusAfterPayment" "AppointmentStatus";
CREATE UNIQUE INDEX "appointments_checkoutSessionId_key" ON "appointments"("checkoutSessionId");
CREATE INDEX "appointments_paymentHoldUntil_idx" ON "appointments"("paymentHoldUntil");
