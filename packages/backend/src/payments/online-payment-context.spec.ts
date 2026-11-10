import { DEPOSIT_SERVICE_SELECT, onlinePaymentContextFor, withOnlinePayment } from './online-payment-context';

/**
 * What the public pages (services list, salon page, widget) say about paying
 * online: the offer in place of the raw settings, only for a salon whose
 * connected Stripe account can charge in the mode of the keys in force.
 */
const row = (over: Record<string, unknown> = {}) => ({
  stripeConnectAccountId: 'acct_1',
  stripeConnectLivemode: false,
  stripeConnectChargesEnabled: true,
  stripeConnectPayoutsEnabled: true,
  stripeConnectDetailsSubmitted: true,
  stripeConnectRequirementsDue: [],
  stripeConnectDisabledReason: null,
  stripeConnectCheckedAt: null,
  ...over,
});
const prismaOf = (r: unknown) => ({ tenant: { findUnique: jest.fn(async () => r) } }) as any;
const platform = (mode: 'test' | 'live' | 'none' = 'test') => ({ client: () => (mode === 'none' ? null : {}), mode: () => mode });

describe('onlinePaymentContextFor', () => {
  it('can charge: a connected account that charges, in the mode of the keys', async () => {
    expect(await onlinePaymentContextFor(prismaOf(row()), platform('test'), 't1')).toEqual({ canCharge: true });
  });

  it('cannot: no keys, no platform, other mode, not connected, not charging, no salon', async () => {
    expect(await onlinePaymentContextFor(prismaOf(row()), platform('none'), 't1')).toEqual({ canCharge: false });
    expect(await onlinePaymentContextFor(prismaOf(row()), undefined, 't1')).toEqual({ canCharge: false });
    expect(await onlinePaymentContextFor(prismaOf(row()), platform('live'), 't1')).toEqual({ canCharge: false });
    expect(await onlinePaymentContextFor(prismaOf(row({ stripeConnectAccountId: null })), platform(), 't1')).toEqual({ canCharge: false });
    expect(await onlinePaymentContextFor(prismaOf(row({ stripeConnectChargesEnabled: false })), platform(), 't1')).toEqual({ canCharge: false });
    expect(await onlinePaymentContextFor(prismaOf(null), platform(), 't1')).toEqual({ canCharge: false });
  });

  it('does not even read the salon without keys', async () => {
    const prisma = prismaOf(row());
    await onlinePaymentContextFor(prisma, platform('none'), 't1');
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
  });
});

describe('withOnlinePayment', () => {
  const svc = { id: 's1', name: 'Tinte', price: 60, depositRequired: true, depositAmount: '15.00', depositPercentage: null, allowPrepay: true };

  it('replaces the raw settings by the offer, in cents', () => {
    const out: any = withOnlinePayment(svc, { canCharge: true });
    expect(out.onlinePayment).toMatchObject({ mode: 'deposit_or_full', depositCents: 1500, totalCents: 6000 });
    for (const raw of Object.keys(DEPOSIT_SERVICE_SELECT)) expect(out).not.toHaveProperty(raw);
    expect(out).toMatchObject({ id: 's1', name: 'Tinte', price: 60 });
  });

  it('offers nothing when the salon cannot charge', () => {
    expect((withOnlinePayment(svc, { canCharge: false }) as any).onlinePayment).toMatchObject({ mode: 'none', depositCents: null });
  });

  it('reads Decimal-like values', () => {
    const decimal = { toString: () => '12.50' };
    const out: any = withOnlinePayment({ ...svc, depositAmount: decimal }, { canCharge: true });
    expect(out.onlinePayment.depositCents).toBe(1250);
  });
});
