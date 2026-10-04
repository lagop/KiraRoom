-- VERI*FACTU: per-salon record chain, records and submissions (RD 1007/2023, Orden HAC/1177/2024).

-- CreateEnum
CREATE TYPE "VerifactuRecordKind" AS ENUM ('alta', 'anulacion');

-- CreateEnum
CREATE TYPE "VerifactuRecordStatus" AS ENUM ('pending', 'accepted', 'accepted_with_errors', 'rejected');

-- AlterTable
ALTER TABLE "fiscal_certificates" ADD COLUMN     "certificateType" TEXT NOT NULL DEFAULT 'personal',
ADD COLUMN     "encryptedKeyPair" TEXT;

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "rectifiesInvoiceId" TEXT;

-- CreateTable
CREATE TABLE "verifactu_chains" (
    "tenantId" TEXT NOT NULL,
    "installationNumber" TEXT NOT NULL,
    "lastSequence" INTEGER NOT NULL DEFAULT 0,
    "lastHash" TEXT,
    "lastNif" TEXT,
    "lastNumSerie" TEXT,
    "lastFecha" TEXT,
    "lastGeneratedAt" TIMESTAMP(3),
    "nextSendAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "waitSeconds" INTEGER NOT NULL DEFAULT 60,
    "incidentSince" TIMESTAMP(3),
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verifactu_chains_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "verifactu_records" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "kind" "VerifactuRecordKind" NOT NULL,
    "invoiceId" TEXT,
    "nif" TEXT NOT NULL,
    "numSerie" TEXT NOT NULL,
    "fecha" TEXT NOT NULL,
    "tipoFactura" TEXT,
    "cuotaTotal" TEXT,
    "importeTotal" TEXT,
    "previousHash" TEXT,
    "generatedAt" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "xml" TEXT NOT NULL,
    "subsanacion" BOOLEAN NOT NULL DEFAULT false,
    "status" "VerifactuRecordStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "submissionId" TEXT,
    "sentAt" TIMESTAMP(3),
    "csv" TEXT,
    "errorCode" INTEGER,
    "errorDescription" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verifactu_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verifactu_submissions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "recordCount" INTEGER NOT NULL,
    "incidencia" BOOLEAN NOT NULL DEFAULT false,
    "httpStatus" INTEGER,
    "estadoEnvio" TEXT,
    "csv" TEXT,
    "waitSeconds" INTEGER,
    "faultCode" INTEGER,
    "error" TEXT,
    "response" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verifactu_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "verifactu_chains_nextSendAt_idx" ON "verifactu_chains"("nextSendAt");

-- CreateIndex
CREATE INDEX "verifactu_records_tenantId_status_sequence_idx" ON "verifactu_records"("tenantId", "status", "sequence");

-- CreateIndex
CREATE INDEX "verifactu_records_invoiceId_idx" ON "verifactu_records"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "verifactu_records_tenantId_sequence_key" ON "verifactu_records"("tenantId", "sequence");

-- CreateIndex
CREATE INDEX "verifactu_submissions_tenantId_createdAt_idx" ON "verifactu_submissions"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "verifactu_chains" ADD CONSTRAINT "verifactu_chains_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verifactu_records" ADD CONSTRAINT "verifactu_records_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verifactu_submissions" ADD CONSTRAINT "verifactu_submissions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Records are unalterable: the fields the fingerprint covers, and the XML
-- sent, never change once written, and no record is ever deleted. Only the
-- result of the submission (status, CSV, error, attempts) is updated.
CREATE OR REPLACE FUNCTION verifactu_records_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'VERI*FACTU records cannot be deleted (record %)', OLD."id";
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
    OR NEW."sequence" IS DISTINCT FROM OLD."sequence"
    OR NEW."kind" IS DISTINCT FROM OLD."kind"
    OR NEW."invoiceId" IS DISTINCT FROM OLD."invoiceId"
    OR NEW."nif" IS DISTINCT FROM OLD."nif"
    OR NEW."numSerie" IS DISTINCT FROM OLD."numSerie"
    OR NEW."fecha" IS DISTINCT FROM OLD."fecha"
    OR NEW."tipoFactura" IS DISTINCT FROM OLD."tipoFactura"
    OR NEW."cuotaTotal" IS DISTINCT FROM OLD."cuotaTotal"
    OR NEW."importeTotal" IS DISTINCT FROM OLD."importeTotal"
    OR NEW."previousHash" IS DISTINCT FROM OLD."previousHash"
    OR NEW."generatedAt" IS DISTINCT FROM OLD."generatedAt"
    OR NEW."hash" IS DISTINCT FROM OLD."hash"
    OR NEW."xml" IS DISTINCT FROM OLD."xml"
    OR NEW."subsanacion" IS DISTINCT FROM OLD."subsanacion"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'VERI*FACTU records cannot be changed: only the submission result is updated (record %)', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER verifactu_records_immutable
  BEFORE UPDATE OR DELETE ON "verifactu_records"
  FOR EACH ROW EXECUTE FUNCTION verifactu_records_immutable();
