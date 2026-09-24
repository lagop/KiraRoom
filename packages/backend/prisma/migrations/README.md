# Migrations

`00000000000000_init` is the **baseline**: a single migration generated from
`schema.prisma` with `prisma migrate diff --from-empty`, covering all 84
tables. It exists because migrations were previously gitignored
(`.gitignore` ignored `prisma/migrations/` under a comment claiming the
opposite), so the project had no migration history at all while
`docker-entrypoint.sh`, CI and the README all ran `prisma migrate deploy`.

## Fresh database

Nothing special — `prisma migrate deploy` creates everything:

```bash
DATABASE_URL=... npx prisma migrate deploy
```

## Database that ALREADY has the schema

Any database whose schema was created with `prisma db push` (every existing
dev and staging database, and production if it was ever pushed) has the
tables but no `_prisma_migrations` row. `migrate deploy` would try to create
them again and fail. Baseline it once, before the next deploy:

```bash
DATABASE_URL=... npx prisma migrate resolve --applied 00000000000000_init
```

Then verify there is no drift — this must print "empty migration":

```bash
npx prisma migrate diff --from-url "$DATABASE_URL" \
  --to-schema-datamodel prisma/schema.prisma --script
```

## From here on

Schema changes go through `npx prisma migrate dev --name <what_changed>` and
the generated directory is committed. Never `db push` against a database that
another environment shares.
