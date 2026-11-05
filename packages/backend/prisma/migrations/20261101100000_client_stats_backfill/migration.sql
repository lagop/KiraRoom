-- Client visit and spend figures, filled in from what happened.
--
-- Nothing ever wrote clients."visitCount", "firstVisit", "lastVisit",
-- "totalSpent" or "averageSpent": every client had 0 visits, no last visit
-- and 0 EUR spent, so re-engagement campaigns took every client for an
-- inactive one. From now on src/clients/client-stats.ts recomputes them
-- after each status change and payment; this fills in existing clients
-- with the same rules:
--
--   visitCount    completed appointments
--   firstVisit    the first one's day ("scheduledDate"); with none, the
--                 day the client was created (the column is NOT NULL)
--   lastVisit     the latest one's day; NULL with none
--   totalSpent    paid payments of the client, without the part paid with
--                 loyalty points. payments.amount is in CENTS, the column
--                 is in EUROS, hence / 100.
--   averageSpent  totalSpent / visitCount, 2 decimals; 0 with no visit
--
-- Data only (no schema change), and idempotent: running it again gives the
-- same values. "updatedAt" is left as it is.

UPDATE "clients" AS c
SET
  "visitCount"   = COALESCE(v.cnt, 0),
  "firstVisit"   = COALESCE(v.first_visit, c."createdAt"),
  "lastVisit"    = v.last_visit,
  "totalSpent"   = COALESCE(p.cents, 0) / 100.0,
  "averageSpent" = CASE
                     WHEN COALESCE(v.cnt, 0) > 0
                       THEN ROUND((COALESCE(p.cents, 0) / 100.0) / v.cnt, 2)
                     ELSE 0
                   END
FROM "clients" AS c2
LEFT JOIN LATERAL (
  SELECT COUNT(*)::int            AS cnt,
         MIN(a."scheduledDate")   AS first_visit,
         MAX(a."scheduledDate")   AS last_visit
  FROM "appointments" a
  WHERE a."clientId" = c2."id"
    AND a."tenantId" = c2."tenantId"
    AND a."status" = 'completed'
) v ON TRUE
LEFT JOIN LATERAL (
  SELECT SUM(pay."amount")::bigint AS cents
  FROM "payments" pay
  WHERE pay."clientId" = c2."id"
    AND pay."tenantId" = c2."tenantId"
    AND pay."status" = 'paid'
    AND pay."method" <> 'loyalty_points'
) p ON TRUE
WHERE c."id" = c2."id";
