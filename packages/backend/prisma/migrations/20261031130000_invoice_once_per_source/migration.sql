-- One invoice per source document: an appointment gets at most one invoice.
--
-- The automatic invoice issued when an appointment is completed was stored as
-- sourceType 'manual' with no sourceId; the appointment was only named in the
-- notes ("Generada desde cita <id>"). Nothing stopped completing twice, or two
-- completions at once, from issuing two invoices, and the appointment delete
-- guard (which looks for sourceType 'appointment') never saw them.
-- InvoiceService.fromAppointment now writes sourceType 'appointment' and
-- sourceId = the appointment's id, and this unique key makes a second insert
-- fail, so the second caller gets the first invoice back.
--
-- Built so it cannot fail on the data already there:
--   * Existing rows: no code ever wrote a sourceId, so every row has NULL there,
--     and NULLs never collide in a Postgres unique index.
--   * Step 1 links the invoices already issued from appointments: at most ONE
--     per appointment (DISTINCT ON), the earliest that is not cancelled
--     (else the earliest). Any duplicate already issued stays exactly as it
--     is (sourceType 'manual', no sourceId): nothing is deleted or renumbered,
--     and no amount, number or fiscal field is touched.
--   * Step 2 is a safety net for rows written by hand: if two rows still share
--     (tenantId, sourceType, sourceId), all but one lose the sourceId so the
--     index can be built. Expected to update nothing.
--
-- sourceType / sourceId are internal metadata: not sent to the AEAT, not part
-- of any fiscal hash, not read by the accounting sync or the tax reports.

-- 1. Link the invoices already issued from appointments.
UPDATE "invoices" AS i
SET "sourceType" = 'appointment', "sourceId" = pick."appointmentId"
FROM (
  SELECT DISTINCT ON (a."id") inv."id" AS "invoiceId", a."id" AS "appointmentId"
  FROM "invoices" AS inv
  JOIN "appointments" AS a
    ON a."id" = substring(inv."notes" FROM '^Generada desde cita ([0-9a-fA-F-]{36})')
   AND a."tenantId" = inv."tenantId"
  WHERE inv."sourceType" = 'manual'
    AND inv."sourceId" IS NULL
    AND inv."notes" LIKE 'Generada desde cita %'
    AND NOT EXISTS (
      SELECT 1 FROM "invoices" AS x
      WHERE x."tenantId" = inv."tenantId"
        AND x."sourceType" = 'appointment'
        AND x."sourceId" = a."id"
    )
  ORDER BY a."id", (inv."status" = 'cancelled'), inv."createdAt", inv."id"
) AS pick
WHERE i."id" = pick."invoiceId";

-- 2. Safety net: never let a pre-existing duplicate block the index.
UPDATE "invoices" AS i
SET "sourceId" = NULL
FROM (
  SELECT "id",
         row_number() OVER (
           PARTITION BY "tenantId", "sourceType", "sourceId"
           ORDER BY ("status" = 'cancelled'), "createdAt", "id"
         ) AS rn
  FROM "invoices"
  WHERE "sourceId" IS NOT NULL
) AS d
WHERE i."id" = d."id" AND d.rn > 1;

-- CreateIndex
CREATE UNIQUE INDEX "invoices_tenantId_sourceType_sourceId_key" ON "invoices"("tenantId", "sourceType", "sourceId");
