// P2A-receptionist-v2 Phase 7 -- production backfill (one-time, idempotent).
//
// Run ONCE before cutover to Phase 7 to migrate legacy
// Tenant.addons.web_domain into tenant_add_ons rows. After verification
// (count of rows after == count of legacy grants before) uncomment
// the `UPDATE` at the bottom to drop the legacy JSON key.
//
// Re-running is safe: ON CONFLICT (tenantId, addOnId) DO NOTHING on the
// INSERT, and the UPDATE is gated by `addons ? 'web_domain'`.

const { Client } = require('pg');

const SQL = `
  -- 1. Insert tenant_add_ons for every legacy grant.
  INSERT INTO tenant_add_ons (
    "id", "tenantId", "addOnId", "status",
    "stripeSubscriptionItemId", "currentPeriodEnd", "startedAt"
  )
  SELECT
    gen_random_uuid()::text,
    t.id,
    a.id,
    'active',
    NULL,
    NULL,
    NOW()
  FROM "tenants" t
  JOIN "add_ons" a ON a.key = 'web_domain'
  WHERE (t.addons)::jsonb ? 'web_domain'
    AND (t.addons)::jsonb -> 'web_domain' ->> 'enabled' = 'true'
  ON CONFLICT ("tenantId", "addOnId") DO NOTHING;

  -- 2. After verification, drop the legacy JSON key.
  -- UPDATE "tenants"
  -- SET addons = addons - 'web_domain'
  -- WHERE addons ? 'web_domain';
`;

(async () => {
  const c = new Client({
    connectionString:
      process.env.DATABASE_URL ||
      'postgresql://kiraroom:kiraroom123@localhost:5432/kiraroom?schema=public',
  });
  await c.connect();

  const before = await c.query(
    "SELECT t.id, t.name FROM tenants t WHERE t.addons ? 'web_domain' AND (t.addons)->'web_domain'->>'enabled' = 'true'",
  );
  console.log(`Legacy grants to migrate: ${before.rows.length}`);
  for (const r of before.rows) console.log(' ', r);

  await c.query(SQL);
  console.log('Backfill SQL applied.');

  const after = await c.query(
    `SELECT t.name, ta.status
     FROM tenant_add_ons ta
     JOIN add_ons a ON a.id = ta."addOnId"
     JOIN tenants t ON t.id = ta."tenantId"
     WHERE a.key = 'web_domain' AND ta.status = 'active'`,
  );
  console.log(`tenant_add_ons rows created: ${after.rows.length}`);
  for (const r of after.rows) console.log(' ', r);

  if (before.rows.length === after.rows.length) {
    console.log('\nOK -- ready to drop the legacy JSON key (uncomment UPDATE in this script and re-run).');
  } else {
    console.log(
      `\nWAIT -- expected ${before.rows.length} new rows, got ${after.rows.length}. Investigate before dropping legacy data.`,
    );
  }
  await c.end();
})();
