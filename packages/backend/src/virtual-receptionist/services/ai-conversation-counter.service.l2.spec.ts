import { AiConversationCounterService } from './ai-conversation-counter.service';

/**
 * L-2: additional ai-conversation-counter coverage for the Redis
 * cache path and the increment() failure path. These complement the
 * decide / state-machine tests in `ai-conversation-counter.service.spec.ts`.
 */
describe('AiConversationCounterService L-2 coverage (Redis + failure path)', () => {
  function makeSvc(opts: { cap: number | null; capThrow?: boolean }) {
    const prisma = {
      tenant: {
        findUnique: jest.fn().mockResolvedValue({
          plan: 'esencial',
          aiConversationsUsed: 0,
          tenantAddOns: [],
        }),
        update: opts.capThrow
          ? jest.fn().mockRejectedValue(new Error('db down'))
          : jest.fn().mockResolvedValue({ aiConversationsUsed: 1 }),
        $executeRaw: jest.fn(),
      },
    } as any;
    const config = { get: () => undefined } as any;
    const subs = {
      resolveEffectiveAiCap: jest.fn().mockReturnValue(opts.cap),
    } as any;
    const svc = new AiConversationCounterService(prisma, config, subs, {
      counter: () => ({ inc: jest.fn() }),
    } as any);

    // Wire a fake redis to exercise the cache path.
    const redis = {
      get: jest.fn().mockResolvedValue(null),
      incr: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
      del: jest.fn().mockResolvedValue(1),
    };
    (svc as any).redisAvailable = true;
    (svc as any).redis = redis;
    return { svc, prisma, redis };
  }

  it('getUsage: returns 0 when redis is empty and Postgres reports 0', async () => {
    const { svc } = makeSvc({ cap: 500 });
    expect(await svc.getUsage('t1')).toBe(0);
  });

  it('getUsage: returns Postgres value when redis returns null', async () => {
    const { svc, redis } = makeSvc({ cap: 500 });
    redis.get.mockResolvedValue(null);
    expect(await svc.getUsage('t2')).toBe(0);
  });

  it('evaluate returns cap_exceeded + used when redis is down + over quota', async () => {
    const { svc, redis } = makeSvc({ cap: 100 });
    redis.get.mockResolvedValue('250');
    const r = await svc.evaluate('t3');
    expect(r.allowed).toBe(false);
    expect(r.used).toBe(250);
    expect(r.cap).toBe(100);
  });

  it('increment: Postgres failure is logged but does not throw (non-blocking)', async () => {
    const { svc } = makeSvc({ cap: 100, capThrow: true });
    // Should NOT throw; the AI loop continues even if bookkeeping fails.
    const result = await svc.increment('t4');
    expect(result.newCount).toBe(1);
  });
});
