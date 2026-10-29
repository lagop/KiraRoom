import { AiConversationCounterService } from './ai-conversation-counter.service';
import { SubscriptionsService } from '../../payments/services/subscriptions.service';

// P2A-receptionist-fairuse -- exercises the decision logic of
// AiConversationCounterService.evaluate() in isolation from Redis
// and from Prisma. Mocks the two collaborators it talks to
// (PrismaService, FeatureFlagService, SubscriptionsService) and
// drives the state machine.
describe('AiConversationCounterService.evaluate()', () => {
  function makeSvc(opts: {
    used: number;
    cap: number | null;
    hasAiExpansion?: boolean;
    plan?: 'esencial' | 'pro' | 'empresa';
  }) {
    const prisma = {
      tenant: {
        // P2A-receptionist-v2 -- reads `tenantAddOns` (the relation),
        // not the legacy `addons` JSON column.
        findUnique: jest.fn().mockResolvedValue({
          plan: opts.plan ?? 'esencial',
          aiConversationsUsed: opts.used,
          tenantAddOns: opts.hasAiExpansion
            ? [{ addOn: { key: 'ai_expansion' } }]
            : [],
        }),
        // For increment() Postgres path. Mocked so tests can assert
        // "was not called" when the cap is null.
        update: jest.fn().mockResolvedValue({ aiConversationsUsed: 1 }),
        // For getUsage Postgres path (Redis cache miss).
        $executeRaw: jest.fn(),
      },
    } as any;
    const config = { get: () => undefined } as any;
    const subs = {
      aiCap: jest.fn().mockReturnValue(opts.cap),
    } as any;
    const svc = new AiConversationCounterService(prisma, config, subs, { counter: () => ({ inc: () => undefined }) } as any);
    // Force Redis as unavailable so tests don't try to connect.
    (svc as any).redisAvailable = false;
    (svc as any).redis = null;
    return { svc, prisma, subs };
  }

  it('returns allowed=true with cap=null for Pro/Empresa (unlimited)', async () => {
    const { svc } = makeSvc({ used: 9999, cap: null, plan: 'pro' });
    const result = await svc.evaluate('tenant-1');
    expect(result.allowed).toBe(true);
    expect(result.cap).toBeNull();
    expect(result.reason).toBe('ok');
    expect(result.fairUseAction).toBe('degrade');
  });

  it('returns allowed=true when used < cap on Esencial', async () => {
    const { svc } = makeSvc({ used: 250, cap: 500, plan: 'esencial' });
    const result = await svc.evaluate('tenant-1');
    expect(result.allowed).toBe(true);
    expect(result.cap).toBe(500);
    expect(result.used).toBe(250);
  });

  it('returns allowed=false when used >= cap and action=degrade (default)', async () => {
    const { svc } = makeSvc({ used: 500, cap: 500, plan: 'esencial' });
    const result = await svc.evaluate('tenant-1');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('cap_exceeded');
    expect(result.fairUseAction).toBe('degrade');
  });

  it('returns allowed=false when used > cap on Esencial', async () => {
    const { svc } = makeSvc({ used: 750, cap: 500, plan: 'esencial' });
    const result = await svc.evaluate('tenant-1');
    expect(result.allowed).toBe(false);
    expect(result.used).toBe(750);
    expect(result.cap).toBe(500);
  });

  it('an AI pack raises the cap instead of removing it', async () => {
    const { svc } = makeSvc({ used: 999, cap: 1500, hasAiExpansion: true, plan: 'esencial' });
    const result = await svc.evaluate('tenant-1');
    expect(result.allowed).toBe(true);
    expect(result.cap).toBe(1500);
  });

  it('increment is a no-op for unlimited plans (no Postgres write)', async () => {
    const { svc, prisma } = makeSvc({ used: 5, cap: null, plan: 'pro' });
    await svc.increment('tenant-1');
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });
});

// The real cap rule (SubscriptionsService.aiCap), on what the tenant row says.
describe('AiConversationCounterService caps', () => {
  const DAY = 86_400_000;
  const today = new Date().toISOString().slice(0, 10);

  function svcFor(tenant: Record<string, unknown>, extra: { used?: number; usedToday?: number; managers?: number } = {}) {
    const row = {
      plan: 'esencial',
      subscriptionStatus: 'active',
      trialEnd: null,
      maxLocations: 1,
      tenantAddOns: [],
      aiConversationsUsed: extra.used ?? 0,
      aiMessagesToday: extra.usedToday ?? 0,
      aiMessagesDay: today,
      aiFairUseAction: 'degrade',
      ...tenant,
    };
    const prisma = {
      tenant: {
        findUnique: jest.fn().mockResolvedValue(row),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      user: { findMany: jest.fn().mockResolvedValue(Array.from({ length: extra.managers ?? 1 }, (_, i) => ({ id: 'u' + i }))) },
    } as any;
    const notifications = { create: jest.fn().mockResolvedValue({}) };
    const subs = new SubscriptionsService({} as any, { get: () => undefined } as any, { client: () => null, current: () => ({ taxEnabled: false }) } as any);
    const svc = new AiConversationCounterService(
      prisma,
      { get: () => undefined } as any,
      subs,
      { counter: () => ({ inc: () => undefined }) } as any,
      notifications as any,
    );
    (svc as any).redisAvailable = false;
    return { svc, prisma, notifications };
  }

  it('caps the trial at 500 even though it unlocks Pro', async () => {
    const { svc } = svcFor({ subscriptionStatus: 'trialing', trialEnd: new Date(Date.now() + 3 * DAY) });
    await expect(svc.getEffectiveCap('t1')).resolves.toBe(500);
  });

  it('caps Pro at 2,000 and Empresa at 3,000 per location', async () => {
    await expect(svcFor({ plan: 'pro' }).svc.getEffectiveCap('t1')).resolves.toBe(2000);
    await expect(svcFor({ plan: 'empresa', maxLocations: 2 }).svc.getEffectiveCap('t1')).resolves.toBe(6000);
  });

  it('adds 1,000 per AI pack, the retired ai_expansion counting as one', async () => {
    const packs = [{ addOn: { key: 'ai_messages_1000' } }, { addOn: { key: 'ai_expansion' } }, { addOn: { key: 'email_marketing' } }];
    await expect(svcFor({ plan: 'pro', tenantAddOns: packs }).svc.getEffectiveCap('t1')).resolves.toBe(4000);
  });

  it("stops at a tenth of the month's cap in one day", async () => {
    const ok = await svcFor({ plan: 'pro' }, { used: 300, usedToday: 199 }).svc.evaluate('t1');
    expect(ok.allowed).toBe(true);

    const stopped = await svcFor({ plan: 'pro' }, { used: 300, usedToday: 200 }).svc.evaluate('t1');
    expect(stopped.allowed).toBe(false);
    expect(stopped.reason).toBe('daily_cap_exceeded');
  });

  it("does not count yesterday's messages against today", async () => {
    const r = await svcFor({ plan: 'pro', aiMessagesDay: '2000-01-01' }, { used: 300, usedToday: 999 }).svc.evaluate('t1');
    expect(r.allowed).toBe(true);
  });

  it("tells the salon's managers once a day when a cap stops the receptionist", async () => {
    const { svc, prisma, notifications } = svcFor({ plan: 'pro' }, { used: 2000, managers: 2 });
    const r = await svc.evaluate('t1');
    expect(r).toMatchObject({ allowed: false, reason: 'cap_exceeded' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(prisma.tenant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { aiCapNotifiedOn: today } }),
    );
    expect(notifications.create).toHaveBeenCalledTimes(2);
    expect(notifications.create.mock.calls[0][0]).toMatchObject({ type: 'system_alert', data: { kind: 'ai_cap', limit: 2000 } });

    // Already told today: the claim matches no row, nobody is told again.
    prisma.tenant.updateMany.mockResolvedValue({ count: 0 });
    notifications.create.mockClear();
    await svc.evaluate('t1');
    await new Promise((resolve) => setImmediate(resolve));
    expect(notifications.create).not.toHaveBeenCalled();
  });
});
