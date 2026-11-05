-- Loyalty (owner decisions 2026-11-02, audit L3/L4/L7/L8):
--   * points expire after 12 months with no visit (a paid visit or purchase
--     renews the whole balance);
--   * levels never go down (the tier follows the highest lifetime points
--     ever reached);
--   * the client's balance can be shown in the post-visit email.
-- Additive: new columns with defaults, and backfills of existing rows.

-- 1. Programmes: 12 months by default, also for the existing ones (the
--    column was never used). Nothing expires before deploy + 30 days.
ALTER TABLE "loyalty_programs" ALTER COLUMN "pointsExpirationDays" SET DEFAULT 365;
ALTER TABLE "loyalty_programs" ADD COLUMN "pointsExpiryStartsAt" TIMESTAMP(3);
ALTER TABLE "loyalty_programs" ADD COLUMN "showPointsInReviewEmail" BOOLEAN NOT NULL DEFAULT true;

UPDATE "loyalty_programs" SET "pointsExpirationDays" = 365 WHERE "pointsExpirationDays" IS NULL;
UPDATE "loyalty_programs" SET "pointsExpiryStartsAt" = CURRENT_TIMESTAMP + INTERVAL '30 days';

-- 2. Members.
ALTER TABLE "loyalty_members" ADD COLUMN "peakLifetimePoints" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "loyalty_members" ADD COLUMN "pointsRenewedAt" TIMESTAMP(3);

-- The level each member holds now is kept: the peak is at least what it needs.
UPDATE "loyalty_members" m
SET "peakLifetimePoints" = GREATEST(
  m."lifetimePoints",
  COALESCE((SELECT t."minPoints" FROM "loyalty_tiers" t WHERE t."id" = m."tierId"), 0),
  0
);

-- Inactivity counts from the last earn or the last completed visit (never a
-- future one), else from the sign-up.
UPDATE "loyalty_members" m
SET "pointsRenewedAt" = LEAST(
  CURRENT_TIMESTAMP,
  GREATEST(
    m."joinedAt",
    (SELECT MAX(x."createdAt") FROM "loyalty_transactions" x
      WHERE x."memberId" = m."id" AND x."type" = 'earn'),
    (SELECT MAX(COALESCE(a."completionTime", a."startTime", a."scheduledDate")) FROM "appointments" a
      WHERE a."clientId" = m."clientId" AND a."status" = 'completed'
        AND COALESCE(a."completionTime", a."startTime", a."scheduledDate") <= CURRENT_TIMESTAMP)
  )
);

CREATE INDEX "loyalty_members_programId_pointsRenewedAt_idx" ON "loyalty_members"("programId", "pointsRenewedAt");
