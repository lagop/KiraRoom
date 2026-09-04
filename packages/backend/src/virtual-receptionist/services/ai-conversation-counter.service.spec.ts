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
      resolveEffectiveAiCap: jest.fn().mockReturnValue(opts.cap),
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

  it('ai_expansion removes the cap entirely (allowed=true even with used high)', async () => {
    const { svc, subs } = makeSvc({
      used: 999,
      cap: 500,
      hasAiExpansion: true,
      plan: 'esencial',
    });
    // SubscriptionsService.resolveEffectiveAiCap returns null when
    // ai_expansion is active (add-on removes cap).
    (subs as any).resolveEffectiveAiCap.mockReturnValue(null);
    const result = await svc.evaluate('tenant-1');
    expect(result.allowed).toBe(true);
    expect(result.cap).toBeNull();
  });

  it('increment is a no-op for unlimited plans (no Postgres write)', async () => {
    const { svc, prisma } = makeSvc({ used: 5, cap: null, plan: 'pro' });
    await svc.increment('tenant-1');
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });
});
