/**
 * Events of the salons' connected Stripe accounts: applied once, only in the
 * Stripe mode of the keys in force, and only to the salon that owns the account.
 */
import { ConnectEventsService } from './connect-events.service';

const account = (over: Record<string, unknown> = {}) => ({
  id: 'acct_1',
  charges_enabled: true,
  payouts_enabled: true,
  details_submitted: true,
  requirements: { currently_due: [], disabled_reason: null },
  ...over,
});
const event = (type: string, object: unknown, over: Record<string, unknown> = {}) =>
  ({ id: `evt_${type}_${Math.abs(JSON.stringify(object).length)}`, type, livemode: false, data: { object }, ...over }) as any;

function build(opts: { mode?: 'test' | 'live' | 'none'; tenant?: any; duplicate?: boolean; updateFails?: boolean } = {}) {
  const claimed = new Set<string>();
  const prisma = {
    stripeWebhookEvent: {
      create: jest.fn(async ({ data }: any) => {
        if (opts.duplicate || claimed.has(data.id)) throw Object.assign(new Error('dup'), { code: 'P2002' });
        claimed.add(data.id);
      }),
      delete: jest.fn(async ({ where }: any) => {
        claimed.delete(where.id);
      }),
    },
    tenant: {
      findFirst: jest.fn(async () => (opts.tenant === undefined ? { id: 't1' } : opts.tenant)),
      update: jest.fn(async () => {
        if (opts.updateFails) throw new Error('db down');
      }),
    },
  };
  const platform = { mode: () => opts.mode ?? 'test' };
  const service = new ConnectEventsService(prisma as any, platform as any);
  (service as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { service, prisma, claimed };
}

describe('ConnectEventsService', () => {
  it('account.updated saves the status Stripe reports on the salon that owns the account', async () => {
    const { service, prisma } = build();
    const out = await service.handle(event('account.updated', account({ requirements: { currently_due: ['external_account'] } })));
    expect(out).toEqual({ received: true });
    expect(prisma.tenant.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { stripeConnectAccountId: 'acct_1' } }));
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: expect.objectContaining({
        stripeConnectAccountId: 'acct_1',
        stripeConnectLivemode: false,
        stripeConnectChargesEnabled: true,
        stripeConnectRequirementsDue: ['external_account'],
      }),
    });
  });

  it('an account no salon has connected is acknowledged and changes nothing', async () => {
    const { service, prisma } = build({ tenant: null });
    expect(await service.handle(event('account.updated', account()))).toEqual({ received: true, ignored: 'unknown_account' });
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('the same event twice is applied once', async () => {
    const { service, prisma } = build();
    const e = event('account.updated', account());
    await service.handle(e);
    expect(await service.handle(e)).toEqual({ received: true, duplicate: true });
    expect(prisma.tenant.update).toHaveBeenCalledTimes(1);
  });

  it('an event of the other Stripe mode is acknowledged and not applied', async () => {
    const { service, prisma } = build({ mode: 'live' });
    expect(await service.handle(event('account.updated', account(), { livemode: false }))).toEqual({
      received: true,
      ignored: 'other_mode',
    });
    expect(prisma.tenant.update).not.toHaveBeenCalled();
    expect(prisma.stripeWebhookEvent.create).not.toHaveBeenCalled();
  });

  it('when the salon disconnects KiraRoom from its Stripe Dashboard the connection is cleared and it can connect again', async () => {
    const { service, prisma } = build();
    await service.handle(event('account.application.deauthorized', { id: 'ca_1' }, { account: 'acct_1' }));
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: expect.objectContaining({ stripeConnectAccountId: null, stripeConnectChargesEnabled: false, stripeConnectPayoutsEnabled: false }),
    });
  });

  it('a deauthorization without an account is acknowledged and ignored', async () => {
    const { service, prisma } = build();
    expect(await service.handle(event('account.application.deauthorized', { id: 'ca_1' }))).toEqual({
      received: true,
      ignored: 'unknown_account',
    });
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  describe('refunds made on the salon\'s Stripe Dashboard (charge.refunded)', () => {
    const charge = { id: 'ch_1', payment_intent: 'pi_1' };

    it('are handed to the payments with the account that made them, once', async () => {
      const t = build();
      const payments: any = { reconcileOnlineRefunds: jest.fn(async () => 1) };
      const service = new (require('./connect-events.service').ConnectEventsService)(t.prisma as any, { mode: () => 'test' } as any, payments);
      (service as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
      const e = event('charge.refunded', charge, { account: 'acct_1' });
      expect(await service.handle(e)).toEqual({ received: true });
      expect(payments.reconcileOnlineRefunds).toHaveBeenCalledWith(charge, 'acct_1');
      expect(await service.handle(e)).toEqual({ received: true, duplicate: true });
      expect(payments.reconcileOnlineRefunds).toHaveBeenCalledTimes(1);
    });

    it('are acknowledged and ignored without the payments service, and not in the other Stripe mode', async () => {
      expect(await build().service.handle(event('charge.refunded', charge))).toEqual({ received: true, ignored: 'unhandled' });
      const t = build({ mode: 'live' });
      const payments: any = { reconcileOnlineRefunds: jest.fn() };
      const service = new (require('./connect-events.service').ConnectEventsService)(t.prisma as any, { mode: () => 'live' } as any, payments);
      (service as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
      expect(await service.handle(event('charge.refunded', charge, { livemode: false }))).toEqual({ received: true, ignored: 'other_mode' });
      expect(payments.reconcileOnlineRefunds).not.toHaveBeenCalled();
    });

    it('a failure raises the error and releases the claim so Stripe retries', async () => {
      const t = build();
      const payments: any = { reconcileOnlineRefunds: jest.fn(async () => { throw new Error('db down'); }) };
      const service = new (require('./connect-events.service').ConnectEventsService)(t.prisma as any, { mode: () => 'test' } as any, payments);
      (service as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
      const e = event('charge.refunded', charge);
      await expect(service.handle(e)).rejects.toThrow('db down');
      expect(t.claimed.has(e.id)).toBe(false);
    });
  });

  describe('the payment events of online bookings', () => {
    const checkout = (type: string) => event(type, { id: 'cs_1', metadata: { kind: 'online_booking' } });

    it('go to whoever registered for them (the appointments), once each', async () => {
      const { service } = build();
      const handler = jest.fn(async () => undefined);
      service.registerPaymentHandler(handler);
      const completed = checkout('checkout.session.completed');
      expect(await service.handle(completed)).toEqual({ received: true });
      expect(await service.handle(checkout('checkout.session.expired'))).toEqual({ received: true });
      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenCalledWith(completed);
      // The same notice again is not handled again.
      expect(await service.handle(completed)).toEqual({ received: true, duplicate: true });
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('are acknowledged and ignored while nobody has registered', async () => {
      const { service } = build();
      expect(await service.handle(checkout('checkout.session.completed'))).toEqual({ received: true, ignored: 'unhandled' });
    });

    it('are not handled in the other Stripe mode', async () => {
      const { service } = build({ mode: 'live' });
      const handler = jest.fn(async () => undefined);
      service.registerPaymentHandler(handler);
      expect(await service.handle(checkout('checkout.session.completed'))).toEqual({ received: true, ignored: 'other_mode' });
      expect(handler).not.toHaveBeenCalled();
    });

    it("a failure raises the error and releases the claim so Stripe's retry is handled", async () => {
      const { service, claimed } = build();
      service.registerPaymentHandler(async () => {
        throw new Error('db down');
      });
      const e = checkout('checkout.session.completed');
      await expect(service.handle(e)).rejects.toThrow('db down');
      expect(claimed.has(e.id)).toBe(false);
    });
  });

  it('events not handled yet are acknowledged so Stripe stops retrying them', async () => {
    const { service } = build();
    expect(await service.handle(event('payout.paid', { id: 'po_1' }))).toEqual({ received: true, ignored: 'unhandled' });
  });

  it('if applying fails the claim is released so Stripe\'s retry is handled, and the error is raised', async () => {
    const { service, claimed } = build({ updateFails: true });
    const e = event('account.updated', account());
    await expect(service.handle(e)).rejects.toThrow('db down');
    expect(claimed.has(e.id)).toBe(false);
  });
});
