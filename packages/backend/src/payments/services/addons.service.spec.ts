import { AddOnsService } from './addons.service';
import { SubscriptionsService } from './subscriptions.service';

/**
 * P2A-receptionist-v2 -- exercises AddOnsService in isolation.
 * The Postgres paths (provisionFromStripe, cancelFromStripe,
 * grantManually) are exercised with a real Prisma mock so we can
 * assert on the `upsert` / `updateMany` shape.
 */
describe('AddOnsService', () => {
  function makeSvc(opts: {
    /** key -> unlocks[] */
    catalog?: Record<string, { id: string; unlocks: string[]; metered?: boolean }>;
    /** tenant.addons[] for the resolveEffectiveCap path */
    tenantAddons?: Array<{ addOn: { key: string } }>;
    plan?: 'esencial' | 'pro' | 'empresa';
    aiConversationsPerMonth?: number | null;
  } = {}) {
    const catalog = opts.catalog ?? {};
    const plan = opts.plan ?? 'esencial';
    const aiCap =
      opts.aiConversationsPerMonth !== undefined
        ? opts.aiConversationsPerMonth
        : 500;

    const prisma = {
      addOn: {
        findMany: jest.fn().mockImplementation(async () =>
          Object.entries(catalog).map(([key, row]) => ({
            id: row.id,
            key,
            name: `Test ${key}`,
            description: `Test desc ${key}`,
            monthlyPriceCents: 1200,
            currency: 'EUR',
            unlocks: row.unlocks,
            metered: row.metered ?? false,
            stripePriceId: null,
            isActive: true,
            sortOrder: 10,
            createdAt: new Date(),
            updatedAt: new Date(),
          })),
        ),
        findUnique: jest.fn().mockImplementation(async ({ where }) => {
          const row = catalog[where.key];
          if (!row) return null;
          return {
            id: row.id,
            key: where.key,
            name: `Test ${where.key}`,
            description: null,
            monthlyPriceCents: 1200,
            currency: 'EUR',
            unlocks: row.unlocks,
            metered: row.metered ?? false,
            stripePriceId: null,
            isActive: true,
            sortOrder: 10,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        }),
      },
      tenant: {
        findUnique: jest.fn().mockResolvedValue({
          plan,
          addons: opts.tenantAddons ?? [],
        }),
      },
      user: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      tenantAddOn: {
        upsert: jest.fn().mockResolvedValue({ id: 'row-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    } as any;
    const config = { get: (k: string) => (k === 'FRONTEND_URL' ? 'https://app.test' : undefined) } as any;
    const flags = {} as any;
    const subs = new SubscriptionsService({} as any, { get: () => undefined } as any);
    const email = {
      sendMultichannelActivated: jest.fn().mockResolvedValue({ success: true }),
    };
    const svc = new AddOnsService(
      prisma,
      config,
      subs,
      { counter: () => ({ inc: () => undefined }) } as any,
      email as any,
    );
    return { svc, prisma, subs, email };
  }

  it('listCatalog incluye los add-ons del catalogo', async () => {
    const { svc } = makeSvc({
      catalog: {
        ai_expansion: { id: 'a1', unlocks: ['virtual_receptionist_advanced'] },
        email_marketing: { id: 'a2', unlocks: ['email_marketing'] },
      },
    });
    const out = await svc.listCatalog();
    expect(out.map((o) => o.key).sort()).toEqual([
      'ai_expansion',
      'email_marketing',
    ]);
  });

  it('isRelevantForPlan filtra los add-ons redundantes en Pro', () => {
    // Plans that already include the feature -> add-on is irrelevant.
    const { svc } = makeSvc({
      plan: 'pro',
      catalog: {
        // Pro already grants email_marketing -> irrelevant.
        email_marketing: { id: 'a1', unlocks: ['email_marketing'] },
        // Pro does NOT include virtual_receptionist_advanced at plan
        // level (it's a paid add-on), so it should be relevant.
        ai_expansion: { id: 'a2', unlocks: ['virtual_receptionist_advanced'] },
      },
    });
    // isRelevantForPlan is private -- call listCatalog('pro') and
    // verify the filter.
    return svc.listCatalog('pro' as any).then((rows) => {
      const keys = rows.map((r) => r.key);
      expect(keys).not.toContain('email_marketing');
      // ai_expansion in Pro should ALSO be hidden because Pro already
      // unlocks virtual_receptionist_advanced at plan level.
      // (The matrix says Pro includes 'virtual_receptionist_advanced'
      // in the `pro` array, so the filter removes ai_expansion from
      // the Pro upsell list.)
      expect(keys).not.toContain('ai_expansion');
    });
  });

  it('isRelevantForPlan mantiene los add-ons que Pro NO cubre', () => {
    const { svc } = makeSvc({
      plan: 'pro',
      catalog: {
        // google_reviews_auto unlocks [] -- always relevant (metered
        // or non-feature add-ons are always shown).
        google_reviews_auto: { id: 'a1', unlocks: [] },
        // loyalty_giftcards unlocks loyalty+promotions+gift_cards;
        // Pro already covers all three -> irrelevant.
        loyalty_giftcards: {
          id: 'a2',
          unlocks: ['loyalty', 'promotions', 'gift_cards'],
        },
      },
    });
    return svc.listCatalog('pro' as any).then((rows) => {
      const keys = rows.map((r) => r.key);
      expect(keys).toContain('google_reviews_auto');
      expect(keys).not.toContain('loyalty_giftcards');
    });
  });

  it('provisionFromStripe hace upsert con (tenantId, addOnId) como target', async () => {
    const { svc, prisma } = makeSvc({
      catalog: { ai_expansion: { id: 'add-on-1', unlocks: [] } },
    });
    const row = await svc.provisionFromStripe({
      tenantId: 'tenant-1',
      addOnKey: 'ai_expansion',
      stripeSubscriptionItemId: 'si_123',
      status: 'active',
    });
    expect(row).not.toBeNull();
    expect(prisma.tenantAddOn.upsert).toHaveBeenCalledTimes(1);
    const args = prisma.tenantAddOn.upsert.mock.calls[0][0];
    expect(args.where).toEqual({
      tenantId_addOnId: { tenantId: 'tenant-1', addOnId: 'add-on-1' },
    });
    expect(args.create.stripeSubscriptionItemId).toBe('si_123');
    expect(args.create.status).toBe('active');
  });

  it('provisionFromStripe hace upsert idempotente (Stripe retries 3+ veces)', async () => {
    const { svc, prisma } = makeSvc({
      catalog: { ai_expansion: { id: 'add-on-1', unlocks: [] } },
    });
    // Stripe deliveries can repeat the same event; the upsert must
    // not error or duplicate the row.
    for (let i = 0; i < 3; i++) {
      await svc.provisionFromStripe({
        tenantId: 'tenant-1',
        addOnKey: 'ai_expansion',
        stripeSubscriptionItemId: 'si_123',
        status: 'active',
      });
    }
    expect(prisma.tenantAddOn.upsert).toHaveBeenCalledTimes(3);
    // All three call the same (tenantId, addOnId) key.
    const calls = prisma.tenantAddOn.upsert.mock.calls;
    calls.forEach((c) => {
      expect(c[0].where.tenantId_addOnId).toEqual({
        tenantId: 'tenant-1',
        addOnId: 'add-on-1',
      });
    });
  });

  it('provisionFromStripe sends a multichannel welcome email on first activation', async () => {
    const { svc, prisma, email } = makeSvc({
      catalog: {
        multichannel: { id: 'mc', unlocks: ['multichannel'] },
      },
    });
    prisma.tenant.findUnique.mockResolvedValue({ id: 'tenant-1', name: 'Mi Salon' });
    prisma.user.findFirst.mockResolvedValue({
      email: 'owner@salon.com',
      firstName: 'Maria',
      lastName: 'Lopez',
    });
    await svc.provisionFromStripe({
      tenantId: 'tenant-1',
      addOnKey: 'multichannel',
      stripeSubscriptionItemId: 'si_mc',
      status: 'active',
    });
    expect(email.sendMultichannelActivated).toHaveBeenCalledTimes(1);
    expect(email.sendMultichannelActivated.mock.calls[0][0]).toMatchObject({
      to: 'owner@salon.com',
      tenantName: 'Mi Salon',
      ownerName: 'Maria Lopez',
    });
  });

  it('provisionFromStripe does NOT send the welcome email for non-multichannel add-ons', async () => {
    const { svc, prisma } = makeSvc({
      catalog: { ai_expansion: { id: 'add-on-1', unlocks: [] } },
    });
    await svc.provisionFromStripe({
      tenantId: 'tenant-1',
      addOnKey: 'ai_expansion',
      stripeSubscriptionItemId: 'si_123',
      status: 'active',
    });
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it('cancelFromStripe marca cancelled sin borrar la fila (audit trail)', async () => {
    const { svc, prisma } = makeSvc({
      catalog: { ai_expansion: { id: 'add-on-1', unlocks: [] } },
    });
    const ok = await svc.cancelFromStripe({
      tenantId: 'tenant-1',
      addOnKey: 'ai_expansion',
    });
    expect(ok).toBe(true);
    expect(prisma.tenantAddOn.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-1',
          addOnId: 'add-on-1',
          status: { not: 'cancelled' },
        }),
        data: expect.objectContaining({
          status: 'cancelled',
        }),
      }),
    );
  });

  it('activeAddOnsForTenant solo incluye status=active', async () => {
    // arrange: prisma.tenantAddOn.findMany with custom mock.
    const { svc, prisma } = makeSvc({});
    prisma.tenantAddOn = {
      findMany: jest.fn().mockResolvedValue([
        { addOn: { key: 'ai_expansion' } },
        { addOn: { key: 'web_domain' } },
      ]),
    } as any;
    const keys = await svc.activeAddOnsForTenant('tenant-1');
    expect(keys.sort()).toEqual(['ai_expansion', 'web_domain']);
  });
});
