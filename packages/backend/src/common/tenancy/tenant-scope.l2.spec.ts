import { PrismaClient } from '@prisma/client';
import { JwtStrategy } from '../../auth/strategies/jwt.strategy';
import { webAddressTaken } from '../../web-address/web-address.service';
import { tenantScopeExtension } from './tenant-scope.extension';
import { tenantStorage, runUnscoped } from './tenant.context';

/**
 * L2: tenant isolation against a real database.
 *
 * Guards the fix for the cross-tenant exposure found in the September
 * 2026 review: `/admin/clients` listed every client on the platform and
 * `/clients/:id` read and wrote across tenants. The filter now lives in
 * a Prisma extension, so these assertions are what stops it regressing.
 *
 * Skipped when no database is reachable, so `npm test` stays green on a
 * workstation without Postgres. CI provides one.
 */
const base = new PrismaClient();
const raw: any = base;
const db: any = base.$extends(tenantScopeExtension());

const asTenant = (tenantId: string, fn: () => any): Promise<any> =>
  tenantStorage.run({ tenantId, bypass: false }, async () => await fn());
const unscoped = (fn: () => any): Promise<any> =>
  runUnscoped(async () => await fn()) as Promise<any>;

let reachable = false;
let tenantA: any;
let tenantB: any;
let clientA: any;
let clientB: any;

const tenantData = (name: string, slug: string) => ({
  name,
  slug,
  plan: 'esencial' as const,
  subscriptionStatus: 'trialing' as const,
  currentPeriodStart: new Date(),
  currentPeriodEnd: new Date(Date.now() + 864e5),
});

beforeAll(async () => {
  try {
    await base.$connect();
    reachable = true;
  } catch (e) {
    console.error('[l2] database unreachable, skipping:', (e as Error).message.slice(0, 160));
    return;
  }
  await unscoped(async () => {
    await raw.client.deleteMany({ where: { phone: { startsWith: '7000000' } } });
    await raw.tenant.deleteMany({ where: { slug: { startsWith: 'l2-tenancy-' } } });
    tenantA = await raw.tenant.create({ data: tenantData('L2 A', 'l2-tenancy-a') });
    tenantB = await raw.tenant.create({ data: tenantData('L2 B', 'l2-tenancy-b') });
    clientA = await raw.client.create({
      data: { tenantId: tenantA.id, firstName: 'Ana', lastName: 'A', phone: '70000001' },
    });
    clientB = await raw.client.create({
      data: { tenantId: tenantB.id, firstName: 'Bea', lastName: 'B', phone: '70000002' },
    });
  });
}, 30000);

afterAll(async () => {
  if (reachable) {
    await unscoped(async () => {
      await raw.client.deleteMany({ where: { phone: { startsWith: '7000000' } } });
      await raw.user.deleteMany({ where: { email: { startsWith: 'l2-tenancy-' } } });
      await raw.product.deleteMany({ where: { sku: { startsWith: 'L2-SKU' } } });
      await raw.tenant.deleteMany({ where: { slug: { startsWith: 'l2-tenancy-' } } });
    });
  }
  await base.$disconnect();
});

// A describe body runs before beforeAll, so the reachability flag cannot
// gate test registration -- it has to gate the test body instead.
const dbTest = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!reachable) return;
    await fn();
  });

describe('tenant-scope extension', () => {
  dbTest('findMany only returns the caller tenant', async () => {
    const rows = await asTenant(tenantA.id, () => db.client.findMany({}));
    expect(rows.map((r: any) => r.id)).toEqual([clientA.id]);
  });

  dbTest('findUnique on another tenant row returns null', async () => {
    const row = await asTenant(tenantA.id, () => db.client.findUnique({ where: { id: clientB.id } }));
    expect(row).toBeNull();
  });

  dbTest('update cannot reach another tenant row', async () => {
    await expect(
      asTenant(tenantA.id, () => db.client.update({ where: { id: clientB.id }, data: { firstName: 'HACK' } })),
    ).rejects.toBeDefined();
    const after = await unscoped(() => raw.client.findUnique({ where: { id: clientB.id } }));
    expect(after.firstName).toBe('Bea');
  });

  dbTest('delete cannot reach another tenant row', async () => {
    await expect(
      asTenant(tenantA.id, () => db.client.delete({ where: { id: clientB.id } })),
    ).rejects.toBeDefined();
    const after = await unscoped(() => raw.client.findUnique({ where: { id: clientB.id } }));
    expect(after).not.toBeNull();
  });

  dbTest('create stamps the tenant from context, not from the body', async () => {
    const created = await asTenant(tenantA.id, () =>
      db.client.create({ data: { firstName: 'Nueva', lastName: 'C', phone: '70000003' } }),
    );
    expect(created.tenantId).toBe(tenantA.id);
  });

  dbTest('create with a foreign tenantId in the body is rejected', async () => {
    await expect(
      asTenant(tenantA.id, () =>
        db.client.create({ data: { tenantId: tenantB.id, firstName: 'X', lastName: 'Y', phone: '70000004' } }),
      ),
    ).rejects.toBeDefined();
  });

  // Time off decides what can be booked: another salon's closure must never
  // reach this salon's availability, nor be edited from it.
  dbTest('time off: reads and deletes stay inside the caller tenant', async () => {
    const day = new Date('2026-12-25T00:00:00.000Z');
    const closure = (tenantId: string) => ({ tenantId, kind: 'closure', startDate: day, endDate: day });
    const [, offB] = await unscoped(async () => [
      await raw.timeOff.create({ data: closure(tenantA.id) }),
      await raw.timeOff.create({ data: closure(tenantB.id) }),
    ]);
    const seen = await asTenant(tenantA.id, () => db.timeOff.findMany({ where: { startDate: { lte: day } } }));
    expect(seen.map((r: any) => r.tenantId)).toEqual([tenantA.id]);
    const removed = await asTenant(tenantA.id, () => db.timeOff.deleteMany({ where: { id: offB.id } }));
    expect(removed.count).toBe(0);
    const created = await asTenant(tenantA.id, () =>
      db.timeOff.create({ data: { kind: 'closure', startDate: day, endDate: day } }),
    );
    expect(created.tenantId).toBe(tenantA.id);
  });

  // runUnscoped(() => prisma.x.y()) used to hand back a lazy query that ran
  // after the context was left, and so was filtered by the salon again.
  dbTest('runUnscoped with a sync arrow still crosses tenants', async () => {
    const rows = await asTenant(tenantA.id, () =>
      runUnscoped(() => db.client.findMany({ where: { phone: { startsWith: '7000000' } } })),
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  // Audit 2026-11-06: a salon asking whether an address is free could not see
  // another salon's old address, which still redirects for 12 months.
  dbTest("a salon sees another salon's old address as taken", async () => {
    await unscoped(() =>
      raw.tenantSlugRedirect.create({
        data: { oldSlug: 'l2-tenancy-old', tenantId: tenantB.id, expiresAt: new Date(Date.now() + 864e5) },
      }),
    );
    const taken = await asTenant(tenantA.id, () => webAddressTaken(db, 'l2-tenancy-old', tenantA.id));
    expect(taken).toBe(true);
    expect(await asTenant(tenantA.id, () => webAddressTaken(db, 'l2-tenancy-free', tenantA.id))).toBe(false);
  });

  // Audit 2026-11-06: the platform owner is in another tenant, so inside a
  // support session the check that they are still active found nobody and
  // every request of the session answered 401.
  dbTest('a support session finds the platform owner outside the salon', async () => {
    const owner = await unscoped(() =>
      raw.user.create({
        data: {
          tenantId: tenantB.id,
          email: 'l2-tenancy-owner@example.com',
          firstName: 'Soporte',
          lastName: 'Plataforma',
          role: 'saas_owner',
          passwordHash: 'x',
        },
      }),
    );
    const strategy: any = Object.create(JwtStrategy.prototype);
    strategy.prisma = db;
    const payload = {
      impersonatedBy: owner.id,
      impersonationId: 'imp-1',
      impersonatedTenantId: tenantA.id,
      impersonationEndsAt: Math.floor(Date.now() / 1000) + 600,
      impersonatorTv: owner.tokenVersion,
    };
    await expect(asTenant(tenantA.id, () => strategy.assertSupportSessionLive(payload))).resolves.toBeUndefined();
  });

  // Audit 2026-11-06: a SKU was unique across the platform.
  dbTest('two salons can use the same SKU, one salon cannot repeat its own', async () => {
    const product = (tenantId: string) => ({ tenantId, name: 'Champú', sku: 'L2-SKU-1', price: 10, quantity: 1 });
    await unscoped(() => raw.product.create({ data: product(tenantA.id) }));
    await unscoped(() => raw.product.create({ data: product(tenantB.id) }));
    await expect(unscoped(() => raw.product.create({ data: product(tenantA.id) }))).rejects.toMatchObject({ code: 'P2002' });
  });

  dbTest('bypass still sees every tenant', async () => {
    const rows = await unscoped(() => db.client.findMany({ where: { phone: { startsWith: '7000000' } } }));
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });
});
