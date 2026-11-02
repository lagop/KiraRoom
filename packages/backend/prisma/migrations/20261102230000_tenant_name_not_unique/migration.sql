-- Two salons may share a name ("Salón Ana" in Madrid and in Sevilla); the
-- slug stays the unique identifier. Renaming to a name another salon used
-- answered a 500.
DROP INDEX IF EXISTS "tenants_name_key";
