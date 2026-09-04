import { AssistantSoftLaunchGuard } from './assistant-soft-launch.guard';

/**
 * P2A-staff-copilot-sprint16 — soft-launch guard contract.
 * Verifies the env-driven whitelist behaviour: GA mode passes
 * everyone; soft-launch mode restricts to listed tenants.
 *
 * The guard reads `COPILOT_SOFT_LAUNCH_TENANT_IDS` from the
 * AssistantTierService — we mock that here.
 */

function makeExecutionContext(tenantId: string | undefined): any {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        user: tenantId ? { tenantId, id: 'u-1', role: 'owner' } : undefined,
      }),
    }),
  };
}

function makeTiers(softLaunchCsv: string): any {
  return {
    isSoftLaunchAllowed: (tenantId: string) => {
      const list = softLaunchCsv.split(',').map((s) => s.trim()).filter(Boolean);
      if (list.length === 0) return true;
      return list.includes(tenantId);
    },
  };
}

describe('AssistantSoftLaunchGuard (L-4)', () => {
  it('passes through in GA mode (empty whitelist)', () => {
    const guard = new AssistantSoftLaunchGuard(makeTiers('') as any);
    expect(guard.canActivate(makeExecutionContext('any-tenant'))).toBe(true);
  });

  it('passes through when no tenantId in request (let other guards handle)', () => {
    const guard = new AssistantSoftLaunchGuard(makeTiers('tenant-a') as any);
    expect(guard.canActivate(makeExecutionContext(undefined))).toBe(true);
  });

  it('passes when the tenant is whitelisted', () => {
    const guard = new AssistantSoftLaunchGuard(makeTiers('tenant-a,tenant-b') as any);
    expect(guard.canActivate(makeExecutionContext('tenant-a'))).toBe(true);
    expect(guard.canActivate(makeExecutionContext('tenant-b'))).toBe(true);
  });

  it('throws 403 COPILOT_NOT_IN_SOFT_LAUNCH when not whitelisted', () => {
    const guard = new AssistantSoftLaunchGuard(makeTiers('tenant-a,tenant-b') as any);
    try {
      guard.canActivate(makeExecutionContext('tenant-c'));
      fail('expected guard to throw');
    } catch (err: any) {
      expect(err.response?.code).toBe('COPILOT_NOT_IN_SOFT_LAUNCH');
    }
  });
});
