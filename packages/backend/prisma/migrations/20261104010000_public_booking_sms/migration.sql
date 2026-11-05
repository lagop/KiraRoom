-- R3 (public booking audit): daily caps on the SMS that bookings from
-- outside the salon send. New table only; nothing existing changes.

-- CreateTable
CREATE TABLE "public_booking_sms" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "appointmentId" TEXT,
    "phoneHash" TEXT NOT NULL,
    "allowed" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "public_booking_sms_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "public_booking_sms_tenantId_createdAt_idx" ON "public_booking_sms"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "public_booking_sms_phoneHash_createdAt_idx" ON "public_booking_sms"("phoneHash", "createdAt");

-- CreateIndex
CREATE INDEX "public_booking_sms_appointmentId_idx" ON "public_booking_sms"("appointmentId");

