-- A panel user's email is one address whatever its capitals.
--
-- Signup stored the email as typed and sign-in looked it up exactly, so an
-- owner who signed up as "Maria@Gmail.com" could not sign in as
-- "maria@gmail.com", and "ana@x.com" and "Ana@x.com" could be two accounts.
-- From now on the application stores emails trimmed and lower-cased
-- (auth/email-normalize.ts) and sign-in falls back to a case-insensitive
-- match.
--
-- This migration never fails on existing data:
--
-- 1. Every email is trimmed and lower-cased, EXCEPT where that would make
--    two users share an address ignoring case: those rows are left exactly
--    as they are. Sign-in still finds them (case-insensitive fallback; with
--    two matches the password decides), and support can merge or rename
--    them by hand.
-- 2. If no such pair is left, a unique index on lower(email) is added so
--    the database refuses a second account with the same address in other
--    capitals. If any pair remains, the index is NOT created and a NOTICE
--    says how many (without the addresses). Running the DO block again after
--    fixing them adds the index.
--
-- The index is an expression index, which schema.prisma cannot describe; it
-- lives only here (see the comment on User.email in schema.prisma).

UPDATE "users" u
SET "email" = lower(btrim(u."email"))
WHERE u."email" <> lower(btrim(u."email"))
  AND btrim(u."email") <> ''
  AND NOT EXISTS (
    SELECT 1 FROM "users" o
    WHERE o."id" <> u."id"
      AND lower(btrim(o."email")) = lower(btrim(u."email"))
  );

DO $$
DECLARE
  pairs integer;
BEGIN
  SELECT count(*) INTO pairs FROM (
    SELECT 1 FROM "users"
    GROUP BY lower(btrim("email"))
    HAVING count(*) > 1
  ) d;

  IF pairs = 0 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS "users_lower_email_key" ON "users" (lower("email"));
  ELSE
    RAISE NOTICE 'users: % email(s) shared by several accounts ignoring case; those rows left unchanged and unique index on lower(email) NOT created', pairs;
  END IF;
END $$;
