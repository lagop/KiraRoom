import { WebhooksController } from './webhooks.controller';
import { BillingScheduler } from './billing.scheduler';
import { SubscriptionsService } from './services/subscriptions.service';
import { billingCustomerDetails, syncBillingCustomer } from './billing-customer';
import { trialDaysOf } from './trial-expiry.scheduler';
import { EmailService } from '../notifications/services/email.service';

/**
 * Audit 7 part B (trial and first payment): B2, B3, B4, B1, B10/N16, B11, B15.
 */

const quiet = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function webhooks(prisma: any, extra: Record<string, any> = {}) {
  const c = Object.create(WebhooksController.prototype) as any;
  c.logger = quiet;
  c.configService = { get: () => undefined };
  c.platformStripe = { client: () => null, current: () => ({ webhookSecret: '' }) };
  c.prisma = prisma;
  c.email = { sendPaymentFailed: jest.fn().mockResolvedValue({ success: true }) };
  c.readOnlyNotices = { notify: jest.fn().mockResolvedValue(undefined) };
  c.messageBundles = { creditTopUp: jest.fn().mockResolvedValue({ newBalance: 1 }) };
  c.addonsService = { syncFromSubscription: jest.fn() };
  Object.assign(c, extra);
  return c;
}

function failedInvoice() {
  return { id: 'in_1', customer: 'cus_1', amount_due: 4900, currency: 'eur', next_payment_attempt: null } as any;
}

function tenantPrisma(tenant: any) {
  return {
    tenant: {
      findFirst: jest.fn().mockResolvedValue(tenant),
      findUnique: jest.fn().mockResolvedValue(tenant),
      update: jest.fn().mockImplementation(async ({ data }) => Object.assign(tenant, data)),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    user: { findFirst: jest.fn().mockResolvedValue({ email: 'owner@example.test', firstName: 'A' }) },
    stripeWebhookEvent: {
      create: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
  } as any;
}

describe('B3: invoice.payment_failed never reopens grace from suspended or cancelled', () => {
  it.each(['suspended', 'cancelled'])('%s: status untouched, the owner is emailed', async (status) => {
    const tenant = { id: 't1', name: 'Salón', subscriptionStatus: status, paymentFailedAt: new Date('2026-10-01') };
    const prisma = tenantPrisma(tenant);
    const c = webhooks(prisma);
    await c['handleInvoicePaymentFailed'](failedInvoice());
    expect(prisma.tenant.update).not.toHaveBeenCalled();
    expect(tenant.subscriptionStatus).toBe(status);
    expect(c.email.sendPaymentFailed).toHaveBeenCalledTimes(1);
  });

  it.each(['active', 'trialing'])('%s: opens a 7-day grace window', async (status) => {
    const tenant: any = { id: 't1', name: 'Salón', subscriptionStatus: status, paymentFailedAt: null };
    const prisma = tenantPrisma(tenant);
    const c = webhooks(prisma);
    const before = Date.now();
    await c['handleInvoicePaymentFailed'](failedInvoice());
    expect(tenant.subscriptionStatus).toBe('past_due');
    const graceMs = tenant.gracePeriodEndsAt.getTime() - before;
    expect(graceMs).toBeGreaterThanOrEqual(7 * 24 * 3600 * 1000 - 1000);
    expect(graceMs).toBeLessThanOrEqual(7 * 24 * 3600 * 1000 + 1000);
  });

  it('past_due: the open window is kept (a retry does not push the suspension forward)', async () => {
    const tenant: any = { id: 't1', name: 'Salón', subscriptionStatus: 'past_due', paymentFailedAt: new Date('2026-11-01') };
    const prisma = tenantPrisma(tenant);
    const c = webhooks(prisma);
    await c['handleInvoicePaymentFailed'](failedInvoice());
    expect(prisma.tenant.update).not.toHaveBeenCalled();
    expect(c.email.sendPaymentFailed).toHaveBeenCalledTimes(1);
  });
});

describe('B4: database errors in the webhook handlers fail the event so Stripe retries', () => {
  const dbDown = () => Promise.reject(new Error('connection lost'));

  it('invoice.payment_failed: a DB error propagates', async () => {
    const prisma = tenantPrisma({});
    prisma.tenant.findFirst = jest.fn(dbDown);
    const c = webhooks(prisma);
    await expect(c['handleInvoicePaymentFailed'](failedInvoice())).rejects.toThrow('connection lost');
  });

  it('invoice.payment_failed: an email failure is swallowed, the state is applied', async () => {
    const tenant: any = { id: 't1', name: 'Salón', subscriptionStatus: 'active', paymentFailedAt: null };
    const prisma = tenantPrisma(tenant);
    const c = webhooks(prisma);
    c.email.sendPaymentFailed = jest.fn().mockRejectedValue(new Error('resend down'));
    await expect(c['handleInvoicePaymentFailed'](failedInvoice())).resolves.toBeUndefined();
    expect(tenant.subscriptionStatus).toBe('past_due');
  });

  it('invoice.paid: a DB error propagates', async () => {
    const prisma = tenantPrisma({ id: 't1', name: 'S', subscriptionStatus: 'suspended' });
    prisma.tenant.update = jest.fn(dbDown);
    const c = webhooks(prisma);
    await expect(c['handleInvoicePaid']({ id: 'in_2', customer: 'cus_1' } as any)).rejects.toThrow('connection lost');
  });

  it('invoice.paid: the recovery is applied before the wallet credit, which also propagates', async () => {
    const tenant: any = { id: 't1', name: 'S', subscriptionStatus: 'past_due' };
    const prisma = tenantPrisma(tenant);
    const c = webhooks(prisma);
    c.messageBundles.creditTopUp = jest.fn(dbDown);
    const invoice = {
      id: 'in_3',
      customer: 'cus_1',
      lines: { data: [{ quantity: 2, metadata: { kind: 'addon', addOnKey: 'message_bundles' } }] },
    } as any;
    await expect(c['handleInvoicePaid'](invoice)).rejects.toThrow('connection lost');
    expect(tenant.subscriptionStatus).toBe('active');
  });

  it('subscription updated (cancelled): a DB error propagates', async () => {
    const prisma = tenantPrisma({});
    prisma.tenant.findUnique = jest.fn(dbDown);
    const c = webhooks(prisma);
    const sub = { id: 'sub_1', status: 'canceled', metadata: { tenantId: 't1' }, items: { data: [] } } as any;
    await expect(c['handlePlanSubscription'](sub, 'deleted')).rejects.toThrow('connection lost');
  });

  it('processStripeEvent releases the event when the handler fails, and Stripe gets an error', async () => {
    const prisma = tenantPrisma({});
    prisma.tenant.findFirst = jest.fn(dbDown);
    const c = webhooks(prisma);
    const event = { id: 'evt_1', type: 'invoice.payment_failed', data: { object: failedInvoice() } } as any;
    await expect(c['processStripeEvent'](event)).rejects.toThrow('connection lost');
    expect(prisma.stripeWebhookEvent.delete).toHaveBeenCalledWith({ where: { id: 'evt_1' } });
  });
});

describe('B11: a trial whose subscription was cancelled at its end becomes cancelled, not active', () => {
  function scheduler(rows: any[]) {
    const prisma = {
      tenant: {
        findMany: jest.fn().mockResolvedValue(rows),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    } as any;
    const notices = { notify: jest.fn().mockResolvedValue(undefined) } as any;
    const events = { record: jest.fn() } as any;
    const s = new BillingScheduler(prisma, events, notices);
    (s as any).logger = quiet;
    return { s, prisma, notices };
  }

  it('subscriptionCancelAt in the past: cancelled with read-only and the cancelled email', async () => {
    const past = new Date(Date.now() - 3600_000);
    const { s, prisma, notices } = scheduler([
      { id: 't1', name: 'S', plan: 'pro', trialEnd: past, stripeSubscriptionId: 'sub_1', subscriptionCancelAt: past },
    ]);
    await s.expireTrials();
    const data = prisma.tenant.updateMany.mock.calls[0][0].data;
    expect(data.subscriptionStatus).toBe('cancelled');
    expect(data.readOnlyUntil).toBeInstanceOf(Date);
    expect(data.subscriptionCancelAt).toBeNull();
    expect(notices.notify).toHaveBeenCalledWith('t1', 'cancelled', expect.any(Date));
  });

  it('cancellation still ahead (or none): active, no email', async () => {
    const past = new Date(Date.now() - 3600_000);
    const future = new Date(Date.now() + 86400_000);
    const { s, prisma, notices } = scheduler([
      { id: 't1', name: 'S', plan: 'pro', trialEnd: past, stripeSubscriptionId: 'sub_1', subscriptionCancelAt: future },
      { id: 't2', name: 'S2', plan: 'pro', trialEnd: past, stripeSubscriptionId: 'sub_2', subscriptionCancelAt: null },
    ]);
    await s.expireTrials();
    for (const call of prisma.tenant.updateMany.mock.calls) {
      expect(call[0].data).toEqual({ subscriptionStatus: 'active' });
    }
    expect(notices.notify).not.toHaveBeenCalled();
  });

  it('B9: trial expiry runs every hour', () => {
    const meta = Reflect.getMetadataKeys(BillingScheduler.prototype.expireTrials);
    const cron = meta
      .map((k) => Reflect.getMetadata(k, BillingScheduler.prototype.expireTrials))
      .find((v) => v && typeof v === 'object' && 'cronTime' in v);
    expect(cron?.cronTime).toBe('0 0-23/1 * * *');
  });
});

function subscriptions(prisma: any, stripe: any = null, taxEnabled = false) {
  const platformStripe = { client: () => stripe, current: () => ({ taxEnabled }) } as any;
  const config = { get: (_k: string, d?: string) => d } as any;
  return new SubscriptionsService(prisma, config, platformStripe);
}

describe('B2: the plan context for the whole team', () => {
  it('has the plan, trial and add-ons, and no Stripe ids', async () => {
    const trialEnd = new Date(Date.now() + 5 * 86400_000);
    const prisma = {
      tenant: {
        findUnique: jest.fn().mockResolvedValue({
          plan: 'esencial',
          subscriptionStatus: 'trialing',
          trialEnd,
          readOnlyUntil: null,
          cancelledAt: null,
          subscriptionCancelAt: null,
          stripeSubscriptionId: 'sub_secret',
          addons: { web_domain: { enabled: true }, other: { token: 'x' } },
          tenantAddOns: [{ addOn: { key: 'multichannel', unlocks: ['multichannel'] } }],
        }),
      },
    } as any;
    const ctx = await subscriptions(prisma).getSubscriptionContext('t1');
    expect(ctx).toMatchObject({
      plan: 'esencial',
      effectivePlan: 'pro',
      status: 'trialing',
      inTrial: true,
      trialEnd,
      subscribed: true,
      addOns: ['multichannel'],
    });
    expect(ctx.addOnFeatures.sort()).toEqual(['multichannel', 'web_domain']);
    expect(JSON.stringify(ctx)).not.toMatch(/sub_secret|cus_|token/);
  });

  it('a trialing salon past its trial end is not in trial', async () => {
    const prisma = {
      tenant: {
        findUnique: jest.fn().mockResolvedValue({
          plan: 'esencial', subscriptionStatus: 'trialing', trialEnd: new Date(Date.now() - 1000),
          readOnlyUntil: null, cancelledAt: null, subscriptionCancelAt: null, stripeSubscriptionId: null,
          addons: {}, tenantAddOns: [],
        }),
      },
    } as any;
    const ctx = await subscriptions(prisma).getSubscriptionContext('t1');
    expect(ctx.inTrial).toBe(false);
    expect(ctx.effectivePlan).toBe('esencial');
  });

  it('is open to the whole team; billing stays the owner\'s', () => {
    const { PaymentsController } = require('./payments.controller');
    const roles = (name: string) => Reflect.getMetadata('roles', PaymentsController.prototype[name]);
    expect(roles('getSubscriptionContext')).toEqual(expect.arrayContaining(['owner', 'admin', 'staff']));
    expect(roles('getSubscription')).toEqual(['owner']);
    expect(roles('getCheckoutSession')).toEqual(['owner']);
  });
});

describe('B15: the checkout session on return', () => {
  const session = (over: any = {}) => ({
    id: 'cs_test_abc',
    mode: 'subscription',
    status: 'complete',
    payment_status: 'no_payment_required',
    metadata: { tenantId: 't1', plan: 'pro' },
    client_reference_id: 't1',
    subscription: { id: 'sub_1', status: 'trialing', trial_end: 1_800_000_000 },
    ...over,
  });
  function svc(s: any, stored: string | null = null) {
    const stripe = { checkout: { sessions: { retrieve: jest.fn().mockResolvedValue(s) } } };
    const prisma = { tenant: { findUnique: jest.fn().mockResolvedValue({ stripeSubscriptionId: stored }) } } as any;
    return { service: subscriptions(prisma, stripe), stripe };
  }

  it('in trial: complete, nothing charged, the first charge on the trial end', async () => {
    const { service, stripe } = svc(session());
    const r = await service.getCheckoutSessionStatus('t1', 'cs_test_abc');
    expect(stripe.checkout.sessions.retrieve).toHaveBeenCalledWith('cs_test_abc', { expand: ['subscription'] });
    expect(r).toMatchObject({ status: 'complete', paymentStatus: 'no_payment_required', plan: 'pro', applied: false });
    expect(r.firstChargeAt?.toISOString()).toBe(new Date(1_800_000_000 * 1000).toISOString());
  });

  it('applied once the webhook stored the subscription', async () => {
    const { service } = svc(session({ payment_status: 'paid', subscription: { id: 'sub_1', status: 'active' } }), 'sub_1');
    const r = await service.getCheckoutSessionStatus('t1', 'cs_test_abc');
    expect(r).toMatchObject({ paymentStatus: 'paid', firstChargeAt: null, applied: true });
  });

  it("another salon's session is not found", async () => {
    const { service } = svc(session({ metadata: { tenantId: 't2' }, client_reference_id: 't2' }));
    await expect(service.getCheckoutSessionStatus('t1', 'cs_test_abc')).rejects.toThrow('No encontramos');
  });

  it('a malformed id is refused before Stripe is called', async () => {
    const { service, stripe } = svc(session());
    await expect(service.getCheckoutSessionStatus('t1', '../x')).rejects.toThrow('no válida');
    expect(stripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
  });

  it('the checkout returns with the session id and asks for the NIF', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'cs_test_new', url: 'https://checkout.example/x' });
    const stripe = {
      customers: { create: jest.fn().mockResolvedValue({ id: 'cus_new' }), listTaxIds: jest.fn().mockResolvedValue({ data: [] }), createTaxId: jest.fn() },
      checkout: { sessions: { create } },
    };
    const tenant = {
      id: 't1', name: 'Pelu Ana', email: 'a@example.test', legalName: 'Ana García SL', taxId: 'B12345674', taxIdType: 'cif',
      street: 'Calle Mayor 1', city: 'Madrid', state: 'Madrid', postalCode: '28001', country: 'ES',
      plan: 'esencial', subscriptionStatus: 'trialing', trialEnd: new Date(Date.now() + 10 * 86400_000),
      stripeCustomerId: null, stripeSubscriptionId: null,
    };
    const prisma = {
      tenant: { findUnique: jest.fn().mockResolvedValue(tenant), update: jest.fn() },
      professional: { count: jest.fn().mockResolvedValue(1) },
      location: { count: jest.fn().mockResolvedValue(1) },
    } as any;
    const service = subscriptions(prisma, stripe);
    jest.spyOn(service as any, 'assertWithinPlanLimits').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'billedLocations').mockResolvedValue(1);
    await service.createCheckoutSession('t1', 'pro');

    expect(stripe.customers.create).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Ana García SL',
      address: expect.objectContaining({ line1: 'Calle Mayor 1', postal_code: '28001', country: 'ES' }),
    }));
    expect(stripe.customers.createTaxId).toHaveBeenCalledWith('cus_new', { type: 'es_cif', value: 'B12345674' });
    const args = create.mock.calls[0][0];
    expect(args.success_url).toContain('session_id={CHECKOUT_SESSION_ID}');
    expect(args.tax_id_collection).toEqual({ enabled: true, required: 'if_supported' });
    expect(args.customer_update).toEqual({ name: 'auto' });
    // Tax off: no automatic tax, and no tax_behavior either way (pending decision).
    expect(args.automatic_tax).toBeUndefined();
    expect(JSON.stringify(args)).not.toContain('tax_behavior');
  });
});

describe('B1: the Stripe customer carries the fiscal identity', () => {
  it('razón social, address and NIF from Ajustes > Fiscal', () => {
    expect(billingCustomerDetails({
      name: 'Pelu Ana', legalName: ' Ana García SL ', taxId: 'b12345674', taxIdType: 'cif',
      street: 'Calle Mayor 1', city: 'Madrid', postalCode: '28001', country: 'es',
    })).toEqual({
      name: 'Ana García SL',
      address: { line1: 'Calle Mayor 1', city: 'Madrid', postal_code: '28001', country: 'ES' },
      taxId: { type: 'es_cif', value: 'B12345674' },
    });
  });

  it('without them: the trade name only; a passport is not a tax id', () => {
    expect(billingCustomerDetails({ name: 'Pelu Ana', taxId: 'X1', taxIdType: 'passport' })).toEqual({ name: 'Pelu Ana' });
  });

  it('a changed NIF replaces the old one; a Stripe refusal does not throw', async () => {
    const stripe = {
      customers: {
        update: jest.fn().mockResolvedValue({}),
        listTaxIds: jest.fn().mockResolvedValue({ data: [{ id: 'txi_old', type: 'es_cif', value: 'B00000000' }] }),
        createTaxId: jest.fn().mockResolvedValue({}),
        deleteTaxId: jest.fn().mockResolvedValue({}),
      },
    } as any;
    await syncBillingCustomer(stripe, 'cus_1', { name: 'S', legalName: 'S SL', taxId: 'B12345674', taxIdType: 'cif' }, quiet);
    expect(stripe.customers.update).toHaveBeenCalledWith('cus_1', { name: 'S SL' });
    expect(stripe.customers.createTaxId).toHaveBeenCalledWith('cus_1', { type: 'es_cif', value: 'B12345674' });
    expect(stripe.customers.deleteTaxId).toHaveBeenCalledWith('cus_1', 'txi_old');

    stripe.customers.createTaxId = jest.fn().mockRejectedValue(new Error('invalid tax id'));
    await expect(
      syncBillingCustomer(stripe, 'cus_1', { name: 'S', taxId: 'B99999999', taxIdType: 'cif' }, quiet),
    ).resolves.toBeUndefined();
  });
});

describe('B10 / N16: the trial-ending email', () => {
  it('the trial length comes from the salon, not a fixed 14', () => {
    const created = new Date('2026-10-01T10:00:00Z');
    expect(trialDaysOf(created, new Date('2026-10-31T10:00:00Z'))).toBe(30);
    expect(trialDaysOf(created, new Date('2026-10-15T10:00:00Z'))).toBe(14);
    expect(trialDaysOf(null, new Date())).toBeUndefined();
  });

  it('the date is the salon day (Madrid), not the server UTC day', async () => {
    const svc = Object.create(EmailService.prototype) as any;
    svc.shouldSkipBouncedUser = jest.fn().mockResolvedValue(false);
    svc.escapeHtml = (s: string) => s;
    svc.sendEmail = jest.fn().mockResolvedValue({ success: true });
    // 23:30 UTC on 31 October is 00:30 CET on 1 November in Madrid.
    await svc.sendTrialExpiry({
      to: 'o@example.test', tenantName: 'S', daysLeft: 1,
      trialEnd: new Date('2026-10-31T23:30:00Z'), upgradeUrl: 'https://x', trialDays: 30,
      timeZone: 'Europe/Madrid',
    });
    const { html, text } = svc.sendEmail.mock.calls[0][0];
    expect(text).toContain('1 de noviembre de 2026');
    expect(html).toContain('<strong>30 días</strong>');
    expect(html).not.toContain('14 días');
  });
});
