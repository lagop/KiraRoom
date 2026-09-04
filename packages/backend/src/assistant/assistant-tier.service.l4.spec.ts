import { AssistantTierService, CopilotTier } from './assistant-tier.service';

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

function makePrisma(opts: { messages?: number; actions?: number }) {
  return {
    assistantMessage: {
      count: jest.fn().mockResolvedValue(opts.messages ?? 0),
    },
    actionApproval: {
      count: jest.fn().mockResolvedValue(opts.actions ?? 0),
    },
  };
}

describe('AssistantTierService (L-4)', () => {
  const FREE = { planFeatures: [] };
  const PRO = { planFeatures: ['copilot_read'] };
  const PREMIUM = { planFeatures: ['copilot_read', 'copilot_write'] };

  function makeConfig(softLaunchCsv?: string): any {
    return {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'COPILOT_SOFT_LAUNCH_TENANT_IDS') return softLaunchCsv ?? '';
        return undefined;
      }),
    };
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

  describe('isOverCostCap', () => {
    it('low usage → under cap', async () => {
      const svc = new AssistantTierService(
        makePrisma({ messages: 100, actions: 10 }) as any,
        makeFlags({}) as any,
        makeConfig() as any,
      );
      expect(await svc.isOverCostCap('t-1')).toBe(false);
    });
    it('20 000 messages + 1 000 actions → over cap', async () => {
      const svc = new AssistantTierService(
        makePrisma({ messages: 20_000, actions: 1_000 }) as any,
        makeFlags({}) as any,
        makeConfig() as any,
      );
      expect(await svc.isOverCostCap('t-1')).toBe(true);
    });
    it('zero usage → under cap', async () => {
      const svc = new AssistantTierService(makePrisma({}) as any, makeFlags({}) as any, makeConfig() as any);
      expect(await svc.isOverCostCap('t-1')).toBe(false);
    });
  });

  describe('soft-launch whitelist (sprint 16)', () => {
    it('GA mode (empty whitelist) allows every tenant', () => {
      const svc = new AssistantTierService(makePrisma({}) as any, makeFlags({}) as any, makeConfig() as any);
      expect(svc.isSoftLaunchAllowed('any-tenant')).toBe(true);
      expect(svc.isSoftLaunchAllowed('other-tenant')).toBe(true);
    });
    it('whitelist restricts to listed tenants only', () => {
      const cfg = makeConfig('tenant-a,tenant-b');
      const svc = new AssistantTierService(makePrisma({}) as any, makeFlags({}) as any, cfg as any);
      expect(svc.isSoftLaunchAllowed('tenant-a')).toBe(true);
      expect(svc.isSoftLaunchAllowed('tenant-b')).toBe(true);
      expect(svc.isSoftLaunchAllowed('tenant-c')).toBe(false);
    });
    it('trims whitespace and ignores empty entries', () => {
      const cfg = makeConfig(' tenant-a , , tenant-b ');
      const svc = new AssistantTierService(makePrisma({}) as any, makeFlags({}) as any, cfg as any);
      expect(svc.softLaunchWhitelist().size).toBe(2);
    });
  });
});
