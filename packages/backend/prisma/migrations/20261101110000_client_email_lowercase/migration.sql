-- A client's email is one address whatever its capitals.
--
-- `@@unique([tenantId, email])` compared emails as typed, and every lookup
-- did too, so "Ana@Mail.com" from the panel and "ana@mail.com" from the
-- booking site made two clients of one person. From now on the application
-- stores emails trimmed and in lower case (clients/client-contact.ts) and
-- looks them up ignoring case.
--
-- This migration never fails on existing data:
--
-- 1. A blank email becomes NULL (none).
-- 2. Every email is trimmed and lower-cased, EXCEPT where that would make
--    two clients of the same salon share an address: those rows are left
--    exactly as they are (the salon merges them from the client file,
--    "Fusionar con otra clienta").
-- 3. If no salon has such a pair left, a unique index on
--    ("tenantId", lower(email)) is added, so the database refuses a second
--    client with the same address in other capitals. If any pair remains,
--    the index is NOT created (the existing case-sensitive unique stays and
--    the application keeps new writes in lower case); a NOTICE lists how many
--    pairs each salon has, without the addresses. Running the DO block below
--    again after merging them adds the index.
--
-- The index is an expression index, which schema.prisma cannot describe; it
-- lives only here (see the comment on Client in schema.prisma). Prisma's
-- migrate diff does not see expression indexes, so it stays clean.

UPDATE "clients" SET "email" = NULL WHERE "email" IS NOT NULL AND btrim("email") = '';

UPDATE "clients" c
SET "email" = lower(btrim(c."email"))
WHERE c."email" IS NOT NULL
  AND c."email" <> lower(btrim(c."email"))
  AND NOT EXISTS (
    SELECT 1 FROM "clients" o
    WHERE o."tenantId" = c."tenantId"
      AND o."id" <> c."id"
      AND o."email" IS NOT NULL
      AND lower(btrim(o."email")) = lower(btrim(c."email"))
  );

DO $$
DECLARE
  pairs integer;
  r record;
BEGIN
  SELECT count(*) INTO pairs FROM (
    SELECT 1 FROM "clients"
    WHERE "email" IS NOT NULL
    GROUP BY "tenantId", lower("email")
    HAVING count(*) > 1
  ) d;

  IF pairs = 0 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS "clients_tenantId_lower_email_key"
      ON "clients" ("tenantId", lower("email"));
  ELSE
    RAISE NOTICE 'clients: % email(s) shared by several clients of one salon (ignoring case); unique index on (tenantId, lower(email)) NOT created, those rows left unchanged', pairs;
    FOR r IN
      SELECT "tenantId", count(*) AS n FROM (
        SELECT "tenantId" FROM "clients"
        WHERE "email" IS NOT NULL
        GROUP BY "tenantId", lower("email")
        HAVING count(*) > 1
      ) t
      GROUP BY "tenantId"
    LOOP
      RAISE NOTICE 'clients: tenant % has % shared email(s) to merge', r."tenantId", r.n;
    END LOOP;
  END IF;
END $$;
