/* eslint-disable no-console */
/**
 * Re-encrypts every secret from the old META_TOKEN_ENCRYPTION_KEY to a new
 * one. That variable is the single master key of EncryptionService (not only
 * Meta's): see src/common/encryption/reencrypt.ts for what it encrypts.
 *
 * Dry run by default: it only counts, per column, how many values would be
 * re-encrypted, are already on the new key, are not encrypted, or cannot be
 * opened by either key. It never prints a value. With --apply it writes
 * everything in one transaction (all or nothing).
 *
 * Usage (from packages/backend, against the database to change):
 *   DATABASE_URL=... OLD_KEY=<current value> NEW_KEY=<openssl rand -base64 32> \
 *     npx ts-node scripts/reencrypt-secrets.ts            # dry run
 *   ... npx ts-node scripts/reencrypt-secrets.ts --apply  # then write
 *
 * Then set META_TOKEN_ENCRYPTION_KEY=<NEW_KEY> in the server's .env and
 * recreate the backend (docker compose up -d backend) right away: between
 * --apply and the restart, the running backend cannot read the secrets.
 * The steps are in docs/runbook.md ("Rotating META_TOKEN_ENCRYPTION_KEY").
 */
import { PrismaClient } from "@prisma/client";
import {
  ENCRYPTED_COLUMNS,
  ENCRYPTED_JSON,
  ReencryptOutcome,
  parseMasterKey,
  reencryptJson,
  reencryptValue,
} from "../src/common/encryption/reencrypt";

const apply = process.argv.includes("--apply");
const oldKey = parseMasterKey(process.env.OLD_KEY, "OLD_KEY");
const newKey = parseMasterKey(process.env.NEW_KEY, "NEW_KEY");
if (oldKey.equals(newKey)) throw new Error("OLD_KEY and NEW_KEY are the same.");

const zero = (): Record<ReencryptOutcome, number> => ({ reencrypted: 0, "already-new": 0, "not-encrypted": 0, unreadable: 0 });
// Identifiers come from the fixed list in reencrypt.ts, never from input.
const q = (name: string) => `"${name.replace(/"/g, "")}"`;

async function main() {
  const prisma = new PrismaClient();
  const writes: Array<{ sql: string; params: unknown[] }> = [];
  let unreadable = 0;

  for (const { table, id, columns } of ENCRYPTED_COLUMNS) {
    for (const column of columns) {
      const counts = zero();
      let rows: Array<{ id: string; value: string }> = [];
      try {
        rows = await prisma.$queryRawUnsafe(
          `SELECT ${q(id)}::text AS id, ${q(column)} AS value FROM ${q(table)} WHERE ${q(column)} IS NOT NULL AND ${q(column)} <> ''`,
        );
      } catch (err) {
        console.log(`${table}.${column}: skipped (${(err as Error).message.split("\n")[0]})`);
        continue;
      }
      for (const row of rows) {
        const r = reencryptValue(row.value, oldKey, newKey);
        counts[r.outcome]++;
        if (r.outcome === "reencrypted") {
          writes.push({ sql: `UPDATE ${q(table)} SET ${q(column)} = $1 WHERE ${q(id)}::text = $2`, params: [r.value, row.id] });
        }
      }
      unreadable += counts.unreadable;
      console.log(`${table}.${column}: ${JSON.stringify(counts)}`);
    }
  }

  const { table, id, column, keySuffix } = ENCRYPTED_JSON;
  const jsonCounts = zero();
  const rows: Array<{ id: string; value: unknown }> = await prisma.$queryRawUnsafe(
    `SELECT ${q(id)}::text AS id, ${q(column)} AS value FROM ${q(table)} WHERE ${q(column)} IS NOT NULL`,
  );
  for (const row of rows) {
    const before = jsonCounts.reencrypted;
    const next = reencryptJson(row.value, oldKey, newKey, keySuffix, jsonCounts);
    if (jsonCounts.reencrypted > before) {
      writes.push({ sql: `UPDATE ${q(table)} SET ${q(column)} = $1::jsonb WHERE ${q(id)}::text = $2`, params: [JSON.stringify(next), row.id] });
    }
  }
  unreadable += jsonCounts.unreadable;
  console.log(`${table}.${column} (...${keySuffix}): ${JSON.stringify(jsonCounts)}`);

  if (unreadable > 0) {
    console.log(`\n${unreadable} value(s) cannot be opened with OLD_KEY (is it the key in use?). They would stay unreadable.`);
  }
  if (!apply) {
    console.log(`\nDry run: ${writes.length} value(s) would be re-encrypted. Run again with --apply to write them.`);
  } else {
    await prisma.$transaction(writes.map((w) => prisma.$executeRawUnsafe(w.sql, ...w.params)));
    console.log(`\nRe-encrypted ${writes.length} value(s). Now set META_TOKEN_ENCRYPTION_KEY to NEW_KEY and recreate the backend.`);
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
