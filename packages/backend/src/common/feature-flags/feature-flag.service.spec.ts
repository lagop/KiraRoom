import { FeatureFlagService } from './feature-flag.service';
import { SubscriptionsService, PLAN_MATRIX } from '../../payments/services/subscriptions.service';

/**
 * P2A-receptionist-v2 -- gating is the union(plan, addons) for
 * every FeatureKey, with two carve-outs:
 *  - `cancelled` / `suspended` tenants: nothing unlocks.
 *  - `web_domain`: only the `tenantAddOns` table counts; the
 *    legacy Tenant.addons JSON is no longer read.
 */
describe('FeatureFlagService (v2 union gating)', () => {
  function makeSvc(plan: 'esencial' | 'pro' | 'empresa' = 'esencial') {
    const subs = new SubscriptionsService({} as any, { get: () => undefined } as any);
    // Silence unused-import warning in lint (we use PLAN_MATRIX below
    // for read-only assertions in some tests).
    void PLAN_MATRIX;
    const prisma = {
      tenant: {
        findUnique: jest.fn().mockImplementation(async () => ({
          id: 'tenant-1',
          plan,
          subscriptionStatus: 'active',
          trialEnd: null,
          addons: {},
          tenantAddOns: [],
          locations: [{ id: 'loc-1' }],
          aiConversationsUsed: 0,
          aiConversationsCap: null,
          aiFairUseAction: 'degrade',
          aiConversationsResetAt: null,
        })),
      },
    } as any;
    const svc = new FeatureFlagService(prisma, subs);
    return { svc, subs, prisma };
  }

  it('esencial tenant unlocks virtual_receptionist (base IA)', async () => {
    const { svc } = makeSvc('esencial');
    expect(await svc.isFeatureUnlocked('tenant-1', 'virtual_receptionist')).toBe(true);
  });

  it('esencial tenant does NOT unlock virtual_receptionist_advanced without add-on', async () => {
    const { svc } = makeSvc('esencial');
    expect(
      await svc.isFeatureUnlocked('tenant-1', 'virtual_receptionist_advanced'),
    ).toBe(false);
  });

  it('esencial tenant unlocks virtual_receptionist_advanced when ai_expansion add-on is active', async () => {
    const { svc, prisma } = makeSvc('esencial');
    prisma.tenant.findUnique = jest.fn().mockResolvedValue({
      id: 'tenant-1',
      plan: 'esencial',
      subscriptionStatus: 'active',
      trialEnd: null,
      addons: {},
      tenantAddOns: [{ addOn: { unlocks: ['virtual_receptionist_advanced'] } }],
      locations: [{ id: 'loc-1' }],
      aiConversationsUsed: 0,
      aiConversationsCap: null,
      aiFairUseAction: 'degrade',
      aiConversationsResetAt: null,
    });
    expect(
      await svc.isFeatureUnlocked('tenant-1', 'virtual_receptionist_advanced'),
    ).toBe(true);
  });

  it('pro tenant unlocks both virtual_receptionist + advanced at plan level', async () => {
    const { svc } = makeSvc('pro');
    expect(await svc.isFeatureUnlocked('tenant-1', 'virtual_receptionist')).toBe(true);
    expect(
      await svc.isFeatureUnlocked('tenant-1', 'virtual_receptionist_advanced'),
    ).toBe(true);
  });

  it('cancelled tenant unlocks nothing even for plan-core features', async () => {
    const { svc, prisma } = makeSvc('esencial');
    prisma.tenant.findUnique = jest.fn().mockResolvedValue({
      id: 'tenant-1',
      plan: 'esencial',
      subscriptionStatus: 'cancelled',
      trialEnd: null,
      addons: {},
      tenantAddOns: [],
      locations: [{ id: 'loc-1' }],
      aiConversationsUsed: 0,
      aiConversationsCap: null,
      aiFairUseAction: 'degrade',
      aiConversationsResetAt: null,
    });
    expect(await svc.isFeatureUnlocked('tenant-1', 'virtual_receptionist')).toBe(false);
    expect(
      await svc.isFeatureUnlocked('tenant-1', 'virtual_receptionist_advanced'),
    ).toBe(false);
  });

  it('multi_location requires Empresa plan AND >= 2 locations', async () => {
    // Empresa + 1 location: multi_location key unlocks but
    // isMultiLocationActive() returns false (UI should hide the tab).
    const { svc, prisma } = makeSvc('empresa');
    prisma.tenant.findUnique = jest.fn().mockResolvedValue({
      id: 'tenant-1',
      plan: 'empresa',
      subscriptionStatus: 'active',
      trialEnd: null,
      addons: {},
      tenantAddOns: [],
      locations: [{ id: 'loc-1' }],
      aiConversationsUsed: 0,
      aiConversationsCap: null,
      aiFairUseAction: 'degrade',
      aiConversationsResetAt: null,
    });
    expect(await svc.isMultiLocationActive('tenant-1')).toBe(false);

    // Add a second location -> now active. Use a fresh mock (not
    // a spread of mock.results) so we do not pick up a stale state.
    prisma.tenant.findUnique = jest.fn().mockResolvedValue({
      id: 'tenant-1',
      plan: 'empresa',
      subscriptionStatus: 'active',
      trialEnd: null,
      addons: {},
      tenantAddOns: [],
      locations: [{ id: 'loc-1' }, { id: 'loc-2' }],
      aiConversationsUsed: 0,
      aiConversationsCap: null,
      aiFairUseAction: 'degrade',
      aiConversationsResetAt: null,
    });
    expect(await svc.isMultiLocationActive('tenant-1')).toBe(true);
  });
});
