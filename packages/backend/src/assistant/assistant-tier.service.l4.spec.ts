import {
  AssistantTierService,
  COPILOT_DAILY_QUESTIONS,
  COPILOT_TRIAL_DAILY_QUESTIONS,
  CopilotTier,
} from './assistant-tier.service';

/**
 * L-4 contract tests for the copilot tier-gating service. We mock the
 * FeatureFlagService.getContext() to drive each plan and assert:
 *   - Free / Esencial: no tools, throws on assertReadAccess.
 *   - Pro: read-only, no write tools.
 *   - Premium: full read + write sets.
 *
 * Plus the cost-protection counter.
 */

function makeFlags(ctxByTenant: Record<string, any>) {
  return {
    getContext: jest.fn().mockImplementation(async (tenantId: string) => ctxByTenant[tenantId] ?? null),
  };
}

/** copilot_usage_days in memory, and the tenant's trial state. */
function makePrisma(opts: { rows?: Array<{ tenantId: string; day: string; messages?: number; costMicroUsd?: bigint }>; trialing?: boolean } = {}) {
  const rows = (opts.rows ?? []).map((r) => ({ messages: 0, costMicroUsd: 0n, ...r }));
  const find = (tenantId: string, day: string) => rows.find((r) => r.tenantId === tenantId && r.day === day);
  return {
    rows,
    tenant: {
      findUnique: jest.fn(async () =>
        opts.trialing
          ? { subscriptionStatus: 'trialing', trialEnd: new Date(Date.now() + 86_400_000) }
          : { subscriptionStatus: 'active', trialEnd: null },
      ),
    },
    copilotUsageDay: {
      aggregate: jest.fn(async ({ where }: any) => ({
        _sum: {
          costMicroUsd: rows
            .filter((r) => r.tenantId === where.tenantId && r.day.startsWith(where.day.startsWith))
            .reduce((a, r) => a + r.costMicroUsd, 0n),
        },
      })),
      findUnique: jest.fn(async ({ where }: any) => find(where.tenantId_day.tenantId, where.tenantId_day.day) ?? null),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const { tenantId, day } = where.tenantId_day;
        let row = find(tenantId, day);
        if (!row) {
          row = { messages: 0, costMicroUsd: 0n, ...create };
          rows.push(row as any);
          return row;
        }
        if (update.messages?.increment) row.messages += update.messages.increment;
        if (update.costMicroUsd?.increment) row.costMicroUsd += update.costMicroUsd.increment;
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const row = find(where.tenantId, where.day);
        if (!row || row.messages <= 0) return { count: 0 };
        row.messages -= data.messages.decrement;
        return { count: 1 };
      }),
    },
  };
}

describe('AssistantTierService (L-4)', () => {
  const FREE = { planFeatures: [] };
  const PRO = { planFeatures: ['copilot_read'] };
  const PREMIUM = { planFeatures: ['copilot_read', 'copilot_write'] };

  function makeConfig(env: Record<string, string> = {}): any {
    return { get: jest.fn().mockImplementation((key: string) => env[key]) };
  }

  describe('resolveTier', () => {
    it('returns free when no context', async () => {
      const svc = new AssistantTierService(makePrisma({}) as any, makeFlags({}) as any, makeConfig() as any);
      const tier = await svc.resolveTier('t-1');
      expect(tier).toBe<CopilotTier>('free');
    });
    it('returns pro for Pro plan', async () => {
      const svc = new AssistantTierService(makePrisma({}) as any, makeFlags({ 't-1': PRO }) as any, makeConfig() as any);
      expect(await svc.resolveTier('t-1')).toBe('pro');
    });
    it('returns premium for Premium plan', async () => {
      const svc = new AssistantTierService(makePrisma({}) as any, makeFlags({ 't-1': PREMIUM }) as any, makeConfig() as any);
      expect(await svc.resolveTier('t-1')).toBe('premium');
    });
    it('returns free for an Esencial plan without copilot_read', async () => {
      const svc = new AssistantTierService(makePrisma({}) as any, makeFlags({ 't-1': FREE }) as any, makeConfig() as any);
      expect(await svc.resolveTier('t-1')).toBe('free');
    });
  });

  describe('assertReadAccess', () => {
    it('throws for free tenants with COPILOT_NOT_IN_PLAN code', async () => {
      const svc = new AssistantTierService(makePrisma({}) as any, makeFlags({ 't-1': FREE }) as any, makeConfig() as any);
      await expect(svc.assertReadAccess('t-1')).rejects.toMatchObject({
        response: { code: 'COPILOT_NOT_IN_PLAN' },
      });
    });
    it('resolves for pro tenants', async () => {
      const svc = new AssistantTierService(makePrisma({}) as any, makeFlags({ 't-1': PRO }) as any, makeConfig() as any);
      await expect(svc.assertReadAccess('t-1')).resolves.toEqual({ tier: 'pro' });
    });
  });

  describe('allowedWriteTools', () => {
    it('free → empty', async () => {
      const svc = new AssistantTierService(makePrisma({}) as any, makeFlags({ 't-1': FREE }) as any, makeConfig() as any);
      expect(await svc.allowedWriteTools('t-1')).toEqual([]);
    });
    it('pro → empty (write is Premium+)', async () => {
      const svc = new AssistantTierService(makePrisma({}) as any, makeFlags({ 't-1': PRO }) as any, makeConfig() as any);
      expect(await svc.allowedWriteTools('t-1')).toEqual([]);
    });
    it('premium → 6 tools', async () => {
      const svc = new AssistantTierService(makePrisma({}) as any, makeFlags({ 't-1': PREMIUM }) as any, makeConfig() as any);
      const tools = await svc.allowedWriteTools('t-1');
      expect(tools).toHaveLength(6);
      expect(tools).toContain('create_coupon');
      expect(tools).toContain('mark_no_show');
      expect(tools).toContain('close_waitlist_slot');
    });
  });

  describe('allowedReadTools', () => {
    it('free → empty', async () => {
      const svc = new AssistantTierService(makePrisma({}) as any, makeFlags({ 't-1': FREE }) as any, makeConfig() as any);
      expect(await svc.allowedReadTools('t-1')).toEqual([]);
    });
    it('pro → all 8 read tools', async () => {
      const svc = new AssistantTierService(makePrisma({}) as any, makeFlags({ 't-1': PRO }) as any, makeConfig() as any);
      const tools = await svc.allowedReadTools('t-1');
      expect(tools).toContain('get_my_agenda');
      expect(tools).toContain('get_low_stock');
      expect(tools).toContain('get_client_360');
    });
  });

  describe("the copilot's own counter (M2/M3, D3/D4)", () => {
    const NOW = new Date('2026-11-14T12:00:00Z');
    const svcWith = (prisma: any, env: Record<string, string> = {}) =>
      new AssistantTierService(prisma, makeFlags({}) as any, makeConfig(env));

    it('counts the question on its own row, not the receptionist counter', async () => {
      const prisma = makePrisma();
      const svc = svcWith(prisma);
      expect(await svc.claimQuestion('t-1', NOW)).toEqual({ ok: true });
      expect(prisma.rows).toEqual([expect.objectContaining({ tenantId: 't-1', day: '2026-11-14', messages: 1 })]);
    });

    it('refuses past the daily questions and gives the refused one back', async () => {
      const prisma = makePrisma({ rows: [{ tenantId: 't-1', day: '2026-11-14', messages: COPILOT_DAILY_QUESTIONS }] });
      const res = await svcWith(prisma).claimQuestion('t-1', NOW);
      expect(res).toMatchObject({ ok: false, reason: 'daily' });
      expect(prisma.rows[0].messages).toBe(COPILOT_DAILY_QUESTIONS);
    });

    it('a salon in its free trial has the lower daily cap (D4)', async () => {
      const prisma = makePrisma({ trialing: true, rows: [{ tenantId: 't-1', day: '2026-11-14', messages: COPILOT_TRIAL_DAILY_QUESTIONS }] });
      expect(await svcWith(prisma).claimQuestion('t-1', NOW)).toMatchObject({ ok: false, reason: 'daily' });
    });

    it('records the real cost from the tokens and the model price', async () => {
      const prisma = makePrisma();
      const svc = svcWith(prisma);
      // Haiku 5.5: 0,10 $ / M input, 0,50 $ / M output → 10 000 in + 2 000 out = 0,002 $.
      await svc.recordCost('t-1', 'claude-haiku-5-5', { promptTokens: 10_000, completionTokens: 2_000 }, NOW);
      expect(prisma.rows[0].costMicroUsd).toBe(2000n);
      expect(await svc.costThisMonthUsd('t-1', NOW)).toBeCloseTo(0.002);
    });

    it('stops at the month cost cap, counting only this month', async () => {
      const prisma = makePrisma({
        rows: [
          { tenantId: 't-1', day: '2026-10-31', costMicroUsd: 99_000_000n },
          { tenantId: 't-1', day: '2026-11-02', costMicroUsd: 24_000_000n },
        ],
      });
      const svc = svcWith(prisma);
      expect(await svc.isOverCostCap('t-1', NOW)).toBe(false);
      await svc.recordCost('t-1', 'claude-haiku-5-5', { completionTokens: 2_000_000 }, NOW); // +1 $
      expect(await svc.isOverCostCap('t-1', NOW)).toBe(true);
      expect(await svc.claimQuestion('t-1', NOW)).toMatchObject({ ok: false, reason: 'monthly' });
    });

    it('the cap can be set in the environment', async () => {
      const prisma = makePrisma({ rows: [{ tenantId: 't-1', day: '2026-11-02', costMicroUsd: 6_000_000n }] });
      expect(await svcWith(prisma, { COPILOT_MONTHLY_COST_CAP_USD: '5' }).isOverCostCap('t-1', NOW)).toBe(true);
    });

    it('a model with no price adds nothing (and does not crash)', async () => {
      const prisma = makePrisma();
      await svcWith(prisma).recordCost('t-1', 'some-gateway-model', { promptTokens: 1000 }, NOW);
      expect(prisma.rows).toEqual([]);
    });
  });
});
