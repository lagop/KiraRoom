import { ConflictException } from '@nestjs/common';
import { SubscriptionsService } from './services/subscriptions.service';
import { professionalLimitPlan } from '../professionals/professional-limit';
import { AdminProfessionalsController } from '../admin/professionals/professionals.controller';
import { ALLOW_WHEN_READ_ONLY } from '../common/decorators/allow-when-read-only.decorator';
import { normalizePhone, normalizeTaxId, sharedIdentityWarnings } from '../saas/shared-identity';

/** Audit 7 phase 2, billing: D6 (no VAT), D8 (professional limit), D9 (shared phone / NIF). */

function subscriptions(prisma: any, stripe: any) {
  const platformStripe = { client: () => stripe, current: () => ({ taxEnabled: false }) } as any;
  const config = { get: (_k: string, d?: string) => d } as any;
  return new SubscriptionsService(prisma, config, platformStripe);
}

describe('D8: the professional limit of the plan being paid for', () => {
  function checkoutFor(status: string, activeProfessionals: number) {
    const tenant = {
      id: 't1', name: 'S', email: 'a@example.test', plan: 'pro', subscriptionStatus: status,
      trialEnd: new Date(Date.now() - 86400_000), stripeCustomerId: 'cus_1', stripeSubscriptionId: null,
    };
    const stripe = {
      customers: { update: jest.fn(), listTaxIds: jest.fn().mockResolvedValue({ data: [] }) },
      checkout: { sessions: { create: jest.fn().mockResolvedValue({ id: 'cs_test_1', url: 'https://x' }), list: jest.fn().mockResolvedValue({ data: [] }) } },
    };
    const prisma = {
      tenant: { findUnique: jest.fn().mockResolvedValue(tenant), update: jest.fn() },
      professional: { count: jest.fn().mockResolvedValue(activeProfessionals) },
      location: { count: jest.fn().mockResolvedValue(1) },
    } as any;
    const service = subscriptions(prisma, stripe);
    jest.spyOn(service as any, 'activeLocationCount').mockResolvedValue(1);
    return { service, stripe };
  }

  it.each(['cancelled', 'suspended'])('%s: subscribing to Esencial with 7 professionals is refused, saying how many to deactivate', async (status) => {
    const { service, stripe } = checkoutFor(status, 7);
    const err = await service.createCheckoutSession('t1', 'esencial').catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(JSON.stringify(err.getResponse())).toContain('desactiva 3');
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('cancelled: reactivating goes through the same check', async () => {
    const { service } = checkoutFor('cancelled', 7);
    const err = await service.reactivateSubscription('t1').catch((e) => e);
    // Pro allows 10: 7 fit, so the reactivation checkout opens.
    expect(err?.checkoutUrl ?? err).toBe('https://x');
    // 12 do not.
    const over = checkoutFor('cancelled', 12);
    const refused = await over.service.reactivateSubscription('t1').catch((e) => e);
    expect(refused).toBeInstanceOf(ConflictException);
    expect(JSON.stringify(refused.getResponse())).toContain('desactiva 2');
  });

  it('within the limit: the checkout opens', async () => {
    const { service, stripe } = checkoutFor('cancelled', 4);
    await service.createCheckoutSession('t1', 'esencial');
    expect(stripe.checkout.sessions.create).toHaveBeenCalled();
  });

  it('in the trial the limit is Pro until a subscription exists, then the plan paid for', () => {
    const trialEnd = new Date(Date.now() + 5 * 86400_000);
    expect(professionalLimitPlan({ plan: 'esencial', subscriptionStatus: 'trialing', trialEnd })).toBe('pro');
    expect(professionalLimitPlan({ plan: 'esencial', subscriptionStatus: 'trialing', trialEnd, stripeSubscriptionId: 'sub_1' })).toBe('esencial');
    expect(professionalLimitPlan({ plan: 'esencial', subscriptionStatus: 'cancelled', trialEnd: null })).toBe('esencial');
  });

  it('deactivating a professional is allowed while read-only, and only that route', () => {
    const allowed = (name: string) =>
      Reflect.getMetadata(ALLOW_WHEN_READ_ONLY, (AdminProfessionalsController.prototype as any)[name]);
    expect(allowed('deactivate')).toBe(true);
    expect(allowed('update')).toBeUndefined();
  });

  it('the deactivate route only sets isActive to false', async () => {
    const c = Object.create(AdminProfessionalsController.prototype) as any;
    c.adminProfessionalsService = { update: jest.fn().mockResolvedValue({ id: 'p1', isActive: false }) };
    await c.deactivate({ tenantId: 't1' }, 'p1');
    expect(c.adminProfessionalsService.update).toHaveBeenCalledWith('t1', 'p1', { isActive: false });
  });
});

describe('D9: salons sharing a phone or a NIF', () => {
  const rows = [
    { id: 'a', name: 'Pelu Ana', slug: 'ana', phones: ['+34 600 11 22 33', null], taxId: 'B12345674' },
    { id: 'b', name: 'Pelu Ana 2', slug: 'ana2', phones: [null, '600112233'], taxId: null },
    { id: 'c', name: 'Otro', slug: 'otro', phones: ['911 22 33 44'], taxId: 'b-1234567.4' },
    { id: 'd', name: 'Solo', slug: 'solo', phones: ['622 00 00 00'], taxId: 'X9999999Z' },
  ];

  it('normalises phones and NIFs', () => {
    expect(normalizePhone('+34 600 11 22 33')).toBe('600112233');
    expect(normalizePhone('0034600112233')).toBe('600112233');
    expect(normalizePhone('123')).toBeNull();
    expect(normalizeTaxId('b-1234567.4')).toBe('B12345674');
  });

  it('warns about the shared phone (salon or owner) and NIF, with the other salons', () => {
    const w = sharedIdentityWarnings(rows, ['a', 'b', 'c', 'd']);
    expect(w.get('a')).toEqual([
      { kind: 'phone', value: '+34 600 11 22 33', others: [{ id: 'b', name: 'Pelu Ana 2', slug: 'ana2' }] },
      { kind: 'taxId', value: 'B12345674', others: [{ id: 'c', name: 'Otro', slug: 'otro' }] },
    ]);
    expect(w.get('b')?.map((x) => x.kind)).toEqual(['phone']);
    expect(w.get('c')?.map((x) => x.kind)).toEqual(['taxId']);
    expect(w.has('d')).toBe(false);
  });
});

describe('D6: KiraRoom charges no VAT on its plans', () => {
  it('the checkout sets no automatic tax and no tax_behavior', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'cs_test_1', url: 'https://x' });
    const tenant = { id: 't1', name: 'S', email: 'a@example.test', plan: 'esencial', subscriptionStatus: 'trialing',
      trialEnd: new Date(Date.now() + 5 * 86400_000), stripeCustomerId: 'cus_1', stripeSubscriptionId: null };
    const prisma = {
      tenant: { findUnique: jest.fn().mockResolvedValue(tenant), update: jest.fn() },
      professional: { count: jest.fn().mockResolvedValue(1) },
    } as any;
    const stripe = {
      customers: { update: jest.fn(), listTaxIds: jest.fn().mockResolvedValue({ data: [] }) },
      checkout: { sessions: { create, list: jest.fn().mockResolvedValue({ data: [] }) } },
    };
    const service = subscriptions(prisma, stripe);
    jest.spyOn(service as any, 'activeLocationCount').mockResolvedValue(1);
    await service.createCheckoutSession('t1', 'pro');
    const args = create.mock.calls[0][0];
    expect(args.automatic_tax).toBeUndefined();
    expect(JSON.stringify(args)).not.toContain('tax_behavior');
  });

  it('the multi-location limit message has no "+ IVA"', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../multi-location/multi-location.service.ts'), 'utf8');
    expect(src).not.toContain('+ IVA');
  });
});
