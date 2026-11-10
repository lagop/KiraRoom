import { BadRequestException } from '@nestjs/common';
import { ServicesService } from './services.service';

/**
 * Online payment settings of a service (señal obligatoria, pagar todo por
 * adelantado): refused when they make no sense, and shown to a client as what
 * she may pay now, never as the salon's raw settings, and only when the salon
 * can take payments.
 */

const STORED = {
  id: 's1',
  tenantId: 'salon-a',
  name: 'Tinte',
  price: '60.00',
  isActive: true,
  isOnlineBookable: true,
  depositRequired: true,
  depositAmount: null,
  depositPercentage: '25',
  allowPrepay: true,
};

function build(opts: { connect?: Record<string, unknown> | null; mode?: 'test' | 'live'; keys?: boolean; stored?: any } = {}) {
  const stored = opts.stored ?? STORED;
  const created: any[] = [];
  const updated: any[] = [];
  const connect =
    opts.connect === undefined
      ? {
          stripeConnectAccountId: 'acct_1',
          stripeConnectLivemode: false,
          stripeConnectChargesEnabled: true,
          stripeConnectPayoutsEnabled: true,
          stripeConnectDetailsSubmitted: true,
          stripeConnectRequirementsDue: [],
          stripeConnectDisabledReason: null,
          stripeConnectCheckedAt: null,
        }
      : opts.connect;
  const prisma: any = {
    tenant: {
      // The same call serves the price settings and the Stripe account.
      findUnique: jest.fn(async () => ({ fiscalSettings: { pricesIncludeTax: true, defaultTaxRate: 21 }, ...(connect ?? {}) })),
    },
    service: {
      findMany: jest.fn(async () => [stored]),
      findFirst: jest.fn(async () => stored),
      create: jest.fn(async (args: any) => (created.push(args), { id: 'new' })),
      update: jest.fn(async (args: any) => (updated.push(args), { id: args.where.id })),
    },
  };
  const platform =
    opts.keys === false ? { client: () => null, mode: () => 'none' } : { client: () => ({}), mode: () => opts.mode ?? 'test' };
  const service = new ServicesService(prisma, platform as any);
  return { service, prisma, created, updated };
}

const base = { name: 'Corte', category: 'hair', duration: 30, price: 60 } as any;

describe('saving the online payment settings of a service', () => {
  it('a señal needs an amount, one of fixed or percentage, never above the price', async () => {
    const { service, created } = build();
    await expect(service.create('salon-a', { ...base, depositRequired: true })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create('salon-a', { ...base, depositRequired: true, depositAmount: 10, depositPercentage: 20 })).rejects.toThrow(/no las dos/);
    await expect(service.create('salon-a', { ...base, depositRequired: true, depositAmount: 90 })).rejects.toThrow(/mayor que el precio/);
    expect(created).toHaveLength(0);
  });

  it('a valid señal and the prepayment option are stored', async () => {
    const { service, created } = build();
    await service.create('salon-a', { ...base, depositRequired: true, depositPercentage: 30, allowPrepay: true });
    expect(created[0].data).toMatchObject({ depositRequired: true, depositPercentage: 30, allowPrepay: true });
    await service.create('salon-a', base);
    expect(created[1].data).toMatchObject({ depositRequired: false, allowPrepay: false });
  });

  it('an edit is judged over what is stored: a new price below the stored señal is refused', async () => {
    const { service, updated } = build({ stored: { ...STORED, depositPercentage: null, depositAmount: '40.00' } });
    await expect(service.update('salon-a', 's1', { price: 30 } as any)).rejects.toThrow(/mayor que el precio/);
    expect(updated).toHaveLength(0);
    await service.update('salon-a', 's1', { price: 70 } as any);
    expect(updated).toHaveLength(1);
  });

  it('switching the señal off, or swapping percentage for a fixed amount, is accepted', async () => {
    const { service, updated } = build();
    await service.update('salon-a', 's1', { depositRequired: false } as any);
    await service.update('salon-a', 's1', { depositAmount: 12, depositPercentage: null } as any);
    expect(updated).toHaveLength(2);
    expect(updated[1].data).toMatchObject({ depositAmount: 12, depositPercentage: null });
  });
});

describe('what a client sees', () => {
  it('the offer for a salon that can take payments, and not the raw settings', async () => {
    const { service } = build();
    const [s] = (await service.findAll('salon-a', { staff: false })) as any[];
    expect(s.onlinePayment).toMatchObject({ mode: 'deposit_or_full', depositCents: 1500, totalCents: 6000, depositRequired: true, canPayFull: true });
    for (const raw of ['depositRequired', 'depositAmount', 'depositPercentage', 'allowPrepay']) expect(s).not.toHaveProperty(raw);
  });

  it('the same for a single service', async () => {
    const { service } = build();
    const s: any = await service.findPublicOne('salon-a', 's1');
    expect(s.onlinePayment.mode).toBe('deposit_or_full');
  });

  it('nothing to pay online when the salon has not connected Stripe, or it cannot charge yet', async () => {
    for (const connect of [
      null,
      { stripeConnectAccountId: null, stripeConnectLivemode: null, stripeConnectChargesEnabled: false, stripeConnectPayoutsEnabled: false, stripeConnectDetailsSubmitted: false, stripeConnectRequirementsDue: [], stripeConnectDisabledReason: null, stripeConnectCheckedAt: null },
      { stripeConnectAccountId: 'acct_1', stripeConnectLivemode: false, stripeConnectChargesEnabled: false, stripeConnectPayoutsEnabled: false, stripeConnectDetailsSubmitted: false, stripeConnectRequirementsDue: ['x'], stripeConnectDisabledReason: null, stripeConnectCheckedAt: null },
    ]) {
      const [s] = (await build({ connect }).service.findAll('salon-a', { staff: false })) as any[];
      expect(s.onlinePayment).toMatchObject({ mode: 'none', depositCents: null });
    }
  });

  it('an account of the other Stripe mode, or no Stripe keys at all, offers nothing', async () => {
    const [other] = (await build({ mode: 'live' }).service.findAll('salon-a', { staff: false })) as any[];
    expect(other.onlinePayment.mode).toBe('none');
    const [noKeys] = (await build({ keys: false }).service.findAll('salon-a', { staff: false })) as any[];
    expect(noKeys.onlinePayment.mode).toBe('none');
  });

  it('the salon\'s own staff still get the settings as stored', async () => {
    const [s] = (await build().service.findAll('salon-a', { staff: true })) as any[];
    expect(s).toMatchObject({ depositRequired: true, depositPercentage: '25', allowPrepay: true });
  });
});
