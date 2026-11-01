-- A service's cleanup time ("tiempo de limpieza", "bufferTime") now blocks the
-- agenda after each appointment. Until now it was stored (15 by default) and
-- ignored. The salon owner's decision: no service has one until the salon
-- sets it, so every existing service starts at 0 and 0 is the default.
ALTER TABLE "services" ALTER COLUMN "bufferTime" SET DEFAULT 0;
UPDATE "services" SET "bufferTime" = 0 WHERE "bufferTime" <> 0;
