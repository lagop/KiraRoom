/**
 * Paying online when booking (señal / pago anticipado) on the salon's own
 * Stripe account: who has to pay and how much, the payment page, a paid
 * booking becoming real exactly once, a payment for a booking that is gone
 * being given back, and holds nobody paid being released.
 */
import { ServiceUnavailableException } from '@nestjs/common';
import { OnlineBookingPaymentService, HOLD_MINUTES, CHECKOUT_MINUTES } from './online-booking-payment.service';

const NOW = new Date('2026-11-10T10:00:00.000Z');
const APPT = '11111111-1111-4111-8111-111111111111';
const TENANT = 'salon-a';
const ACCOUNT = 'acct_salon';

const connectRow = (over: Record<string, unknown> = {}) => ({
  stripeConnectAccountId: ACCOUNT,
  stripeConnectLivemode: false,
  stripeConnectChargesEnabled: true,
  stripeConnectPayoutsEnabled: true,
  stripeConnectDetailsSubmitted: true,
  stripeConnectRequirementsDue: [],
  stripeConnectDisabledReason: null,
  stripeConnectCheckedAt: null,
  fiscalSettings: { pricesIncludeTax: true, defaultTaxRate: 21 },
  depositExemptReturning: true,
  ...over,
});
const serviceRow = (over: Record<string, unknown> = {}) => ({
  name: 'Tinte',
  price: { toString: () => '60.00' } as any,
  currency: 'EUR',
  depositRequired: true,
  depositAmount: { toString: () => '15.00' } as any,
  depositPercentage: null,
  allowPrepay: true,
  ...over,
});

function build(opts: { tenant?: any; service?: any; mode?: 'test' | 'live' | 'none'; client?: any; phoneId?: string | null; visits?: number } = {}) {
  const calls: Record<string, any[]> = { appointmentUpdate: [], paymentCreate: [], deleted: [], refunds: [], sessions: [], expired: [] };
  let appointment: any = null;
  const prisma: any = {
    service: { findFirst: jest.fn(async () => (opts.service === undefined ? serviceRow() : opts.service)) },
    tenant: { findUnique: jest.fn(async () => (opts.tenant === undefined ? connectRow() : opts.tenant)) },
    client: { findFirst: jest.fn(async () => (opts.client === undefined ? null : opts.client)) },
    appointment: {
      count: jest.fn(async () => opts.visits ?? 0),
      findFirst: jest.fn(async () => appointment),
      findMany: jest.fn(async () => []),
      updateMany: jest.fn(async (args: any) => (calls.appointmentUpdate.push(args), { count: appointment?.paymentHoldUntil ? 1 : 0 })),
    },
    payment: { count: jest.fn(async () => 0), create: jest.fn(async (args: any) => calls.paymentCreate.push(args)) },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  const stripe = {
    checkout: {
      sessions: {
        create: jest.fn(async (params: any, options: any) => (calls.sessions.push({ params, options }), { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' })),
        retrieve: jest.fn(),
        expire: jest.fn(async (id: string) => calls.expired.push(id)),
      },
    },
    refunds: { create: jest.fn(async (params: any, options: any) => calls.refunds.push({ params, options })) },
  };
  const platform = { client: () => (opts.mode === 'none' ? null : stripe), mode: () => opts.mode ?? 'test' };
  const service = new OnlineBookingPaymentService(prisma, platform as any);
  (service as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return {
    service,
    prisma,
    stripe,
    calls,
    setAppointment: (a: any) => (appointment = a),
  };
}

const heldAppointment = (over: Record<string, unknown> = {}) => ({
  id: APPT,
  tenantId: TENANT,
  clientId: 'c1',
  status: 'pending',
  statusAfterPayment: 'confirmed',
  paymentHoldUntil: new Date(NOW.getTime() + 20 * 60_000),
  checkoutSessionId: 'cs_1',
  onlinePaymentKind: 'deposit',
  totalAmount: 6000,
  amountPaid: 0,
  depositPaid: false,
  currency: 'EUR',
  service: { name: 'Tinte' },
  ...over,
});
const paidSession = (over: Record<string, unknown> = {}) =>
  ({
    id: 'cs_1',
    payment_status: 'paid',
    amount_total: 1500,
    payment_intent: 'pi_1',
    metadata: { kind: 'online_booking', appointmentId: APPT, tenantId: TENANT, payKind: 'deposit' },
    ...over,
  }) as any;

describe('plan: who has to pay, and how much', () => {
  const dto = { serviceId: 's1', clientInfo: { email: 'lucia@mail.test', phone: '+34600111222' } };

  it('a salon that takes payments, a service with a señal: she pays it', async () => {
    const plan = await build().service.plan(TENANT, dto);
    expect(plan).toMatchObject({ kind: 'deposit', cents: 1500, totalCents: 6000, currency: 'eur', accountId: ACCOUNT, serviceName: 'Tinte' });
  });

  it('she may pay all when the service allows it and she asks', async () => {
    expect(await build().service.plan(TENANT, { ...dto, payment: 'full' })).toMatchObject({ kind: 'full', cents: 6000 });
  });

  it('the price is the one the client sees, tax included', async () => {
    const t = build({ tenant: connectRow({ fiscalSettings: { pricesIncludeTax: false, defaultTaxRate: 21 } }) });
    expect(await t.service.plan(TENANT, { ...dto, payment: 'full' })).toMatchObject({ kind: 'full', cents: 7260 });
  });

  it('nothing to pay when the salon cannot take payments, whatever the service says', async () => {
    expect(await build({ tenant: connectRow({ stripeConnectChargesEnabled: false }) }).service.plan(TENANT, dto)).toBeNull();
    expect(await build({ tenant: connectRow({ stripeConnectAccountId: null }) }).service.plan(TENANT, dto)).toBeNull();
    expect(await build({ mode: 'live' }).service.plan(TENANT, dto)).toBeNull(); // account of the test mode
    expect(await build({ mode: 'none' }).service.plan(TENANT, dto)).toBeNull();
  });

  it('nothing to pay for a service that asks for nothing, or does not exist', async () => {
    const free = build({ service: serviceRow({ depositRequired: false, allowPrepay: false }) });
    expect(await free.service.plan(TENANT, { ...dto, payment: 'full' })).toBeNull();
    expect(await build({ service: null }).service.plan(TENANT, dto)).toBeNull();
  });

  it('a returning client (email AND phone of the same client, a completed visit) is exempt from the señal', async () => {
    const t = build({ client: { id: 'c1' }, visits: 3 });
    t.prisma.client.findFirst.mockResolvedValue({ id: 'c1' });
    jest.spyOn(require('../clients/client-contact'), 'findClientIdByPhone').mockResolvedValue('c1');
    expect(await t.service.plan(TENANT, dto)).toBeNull();
    // ...and may still prepay.
    expect(await t.service.plan(TENANT, { ...dto, payment: 'full' })).toMatchObject({ kind: 'full' });
  });

  it('email of one client with the phone of another is not enough to skip the señal', async () => {
    const t = build({ client: { id: 'c1' }, visits: 3 });
    jest.spyOn(require('../clients/client-contact'), 'findClientIdByPhone').mockResolvedValue('c2');
    expect(await t.service.plan(TENANT, dto)).toMatchObject({ kind: 'deposit' });
  });

  it('a client without a completed visit, or with only one of email and phone, still pays the señal', async () => {
    jest.spyOn(require('../clients/client-contact'), 'findClientIdByPhone').mockResolvedValue('c1');
    expect(await build({ client: { id: 'c1' }, visits: 0 }).service.plan(TENANT, dto)).toMatchObject({ kind: 'deposit' });
    expect(await build({ client: { id: 'c1' }, visits: 3 }).service.plan(TENANT, { serviceId: 's1', clientInfo: { email: 'lucia@mail.test' } })).toMatchObject({ kind: 'deposit' });
  });

  it('the salon can switch the exemption off', async () => {
    jest.spyOn(require('../clients/client-contact'), 'findClientIdByPhone').mockResolvedValue('c1');
    const t = build({ tenant: connectRow({ depositExemptReturning: false }), client: { id: 'c1' }, visits: 3 });
    expect(await t.service.plan(TENANT, dto)).toMatchObject({ kind: 'deposit' });
  });
});

describe('createCheckout: the payment page on the salon\'s account', () => {
  const plan = { kind: 'deposit' as const, cents: 1500, totalCents: 6000, currency: 'eur', serviceName: 'Tinte', accountId: ACCOUNT, livemode: false };
  const appt = { id: APPT, tenantId: TENANT, client: { email: 'lucia@mail.test' } };

  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret-for-links';
  });

  it('charges on the salon\'s account, the amount decided by the server, and carries the booking in its metadata', async () => {
    const t = build();
    const out = await t.service.createCheckout(appt, plan, NOW);
    const { params, options } = t.calls.sessions[0];
    expect(options.stripeAccount).toBe(ACCOUNT);
    expect(options.idempotencyKey).toBe(`booking-checkout-${APPT}`);
    expect(params).toMatchObject({
      mode: 'payment',
      customer_email: 'lucia@mail.test',
      client_reference_id: APPT,
      metadata: { kind: 'online_booking', appointmentId: APPT, tenantId: TENANT, payKind: 'deposit' },
    });
    expect(params.line_items[0].price_data).toMatchObject({ currency: 'eur', unit_amount: 1500 });
    expect(params.line_items[0].price_data.product_data.name).toMatch(/Señal/);
    expect(params).not.toHaveProperty('application_fee_amount');
    expect(params.payment_intent_data).not.toHaveProperty('application_fee_amount');
    expect(out.checkoutUrl).toBe('https://checkout.stripe.com/c/pay/cs_1');
  });

  it('comes back to her appointment page, and the page outlives the hold', async () => {
    const t = build();
    const out = await t.service.createCheckout(appt, plan, NOW);
    const { params } = t.calls.sessions[0];
    expect(params.success_url).toMatch(/\/public\/cita\/.+\?pago=ok$/);
    expect(params.cancel_url).toMatch(/\/public\/cita\/.+\?pago=cancelado$/);
    expect(params.expires_at).toBe(Math.floor(NOW.getTime() / 1000) + CHECKOUT_MINUTES * 60);
    expect(out.holdUntil.getTime()).toBe(NOW.getTime() + HOLD_MINUTES * 60_000);
    expect(HOLD_MINUTES).toBeGreaterThan(CHECKOUT_MINUTES);
    expect(CHECKOUT_MINUTES).toBeGreaterThanOrEqual(30);
  });

  it('prepaying is named as such, and no email is not sent', async () => {
    const t = build();
    await t.service.createCheckout({ ...appt, client: { email: null } }, { ...plan, kind: 'full', cents: 6000 }, NOW);
    const { params } = t.calls.sessions[0];
    expect(params.line_items[0].price_data.product_data.name).toMatch(/Pago anticipado/);
    expect(params).not.toHaveProperty('customer_email');
  });

  it('Stripe failing is a clear 503 and never shows a key', async () => {
    const t = build();
    t.stripe.checkout.sessions.create.mockRejectedValueOnce(new Error('Invalid API Key provided: sk_test_abcdefghij1234'));
    const err = await t.service.createCheckout(appt, plan, NOW).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(String(err.message)).not.toMatch(/sk_test_/);
  });
});

describe('complete: Stripe says it was paid', () => {
  it('the held booking becomes real once, with the payment recorded', async () => {
    const t = build();
    t.setAppointment(heldAppointment());
    const out = await t.service.complete(paidSession(), ACCOUNT);
    expect(out).toEqual({ result: 'paid', appointmentId: APPT, tenantId: TENANT });
    expect(t.calls.appointmentUpdate[0].data).toMatchObject({
      paymentHoldUntil: null,
      status: 'confirmed',
      statusAfterPayment: null,
      amountPaid: 1500,
      depositPaid: true,
      depositPaymentIntentId: 'pi_1',
    });
    expect(t.calls.paymentCreate[0].data).toMatchObject({
      tenantId: TENANT,
      appointmentId: APPT,
      clientId: 'c1',
      stripePaymentId: 'pi_1',
      amount: 1500,
      type: 'deposit',
      status: 'paid',
      method: 'card',
      isDeposit: true,
      depositAmount: 1500,
      remainingAmount: 4500,
    });
  });

  it('a booking the salon approves itself stays pending after payment', async () => {
    const t = build();
    t.setAppointment(heldAppointment({ statusAfterPayment: 'pending' }));
    await t.service.complete(paidSession(), ACCOUNT);
    expect(t.calls.appointmentUpdate[0].data.status).toBe('pending');
  });

  it('paying everything marks it paid, not as a deposit', async () => {
    const t = build();
    t.setAppointment(heldAppointment({ onlinePaymentKind: 'full' }));
    await t.service.complete(paidSession({ amount_total: 6000 }), ACCOUNT);
    expect(t.calls.appointmentUpdate[0].data).toMatchObject({ paymentStatus: 'paid', amountPaid: 6000 });
    expect(t.calls.appointmentUpdate[0].data).not.toHaveProperty('depositPaid');
    expect(t.calls.paymentCreate[0].data).toMatchObject({ type: 'appointment', isDeposit: false, amount: 6000 });
  });

  it('the same notice twice changes nothing the second time', async () => {
    const t = build();
    t.setAppointment(heldAppointment({ paymentHoldUntil: null, depositPaid: true }));
    expect(await t.service.complete(paidSession(), ACCOUNT)).toEqual({ result: 'already_paid', appointmentId: APPT });
    expect(t.calls.paymentCreate).toHaveLength(0);
  });

  it('two deliveries racing: only the one that finds the hold records the payment', async () => {
    const t = build();
    t.setAppointment(heldAppointment());
    t.prisma.appointment.updateMany.mockResolvedValueOnce({ count: 0 });
    await t.service.complete(paidSession(), ACCOUNT);
    expect(t.calls.paymentCreate).toHaveLength(0);
  });

  it('a payment for a booking that no longer exists is refunded in full, on the salon\'s account', async () => {
    const t = build();
    t.setAppointment(null);
    expect(await t.service.complete(paidSession(), ACCOUNT)).toEqual({ result: 'refunded_no_booking' });
    expect(t.calls.refunds[0]).toMatchObject({ params: { payment_intent: 'pi_1' }, options: { stripeAccount: ACCOUNT } });
  });

  it('not paid yet, not a booking checkout, another account, or another session: ignored', async () => {
    const t = build();
    t.setAppointment(heldAppointment());
    expect((await t.service.complete(paidSession({ payment_status: 'unpaid' }), ACCOUNT)).result).toBe('ignored');
    expect((await t.service.complete(paidSession({ metadata: { kind: 'something_else' } }), ACCOUNT)).result).toBe('ignored');
    expect((await t.service.complete(paidSession(), 'acct_someone_else')).result).toBe('ignored');
    expect((await t.service.complete(paidSession({ id: 'cs_other' }), ACCOUNT)).result).toBe('ignored');
    expect(t.calls.paymentCreate).toHaveLength(0);
    expect(t.calls.refunds).toHaveLength(0);
  });
});

describe('releasing holds', () => {
  it('an expired checkout releases its held booking, and a booking with money on it stays', async () => {
    const t = build();
    t.setAppointment({ id: APPT, checkoutSessionId: 'cs_1' });
    const del = jest.spyOn(require('./appointment-delete'), 'deleteAppointmentRow').mockResolvedValue(undefined);
    expect(await t.service.expire(paidSession({ payment_status: 'unpaid' }))).toBe(true);
    expect(del).toHaveBeenCalledWith(t.prisma, APPT);

    del.mockClear();
    t.prisma.payment.count.mockResolvedValueOnce(1);
    expect(await t.service.expire(paidSession({ payment_status: 'unpaid' }))).toBe(false);
    expect(del).not.toHaveBeenCalled();
  });

  it('another session of the same booking never releases it', async () => {
    const t = build();
    t.setAppointment({ id: APPT, checkoutSessionId: 'cs_1' });
    const del = jest.spyOn(require('./appointment-delete'), 'deleteAppointmentRow').mockResolvedValue(undefined);
    expect(await t.service.expire(paidSession({ id: 'cs_other' }))).toBe(false);
    expect(del).not.toHaveBeenCalled();
  });

  it('the sweep asks Stripe first: paid after all means confirmed, open means closed and released', async () => {
    const t = build();
    t.prisma.appointment.findMany.mockResolvedValue([
      { id: 'a-paid', tenantId: TENANT, checkoutSessionId: 'cs_paid' },
      { id: 'a-open', tenantId: TENANT, checkoutSessionId: 'cs_open' },
    ]);
    t.prisma.tenant.findUnique.mockResolvedValue({ stripeConnectAccountId: ACCOUNT });
    t.stripe.checkout.sessions.retrieve
      .mockResolvedValueOnce({ id: 'cs_paid', payment_status: 'paid', status: 'complete', metadata: { kind: 'online_booking', appointmentId: 'a-paid', tenantId: TENANT }, amount_total: 1500, payment_intent: 'pi_9' })
      .mockResolvedValueOnce({ id: 'cs_open', payment_status: 'unpaid', status: 'open', metadata: {} });
    const completeSpy = jest.spyOn(t.service, 'complete').mockResolvedValue({ result: 'paid', appointmentId: 'a-paid', tenantId: TENANT });
    t.prisma.appointment.findFirst.mockResolvedValue({ id: 'a-open', checkoutSessionId: 'cs_open' });
    const del = jest.spyOn(require('./appointment-delete'), 'deleteAppointmentRow').mockResolvedValue(undefined);

    const out = await t.service.sweep(NOW);
    expect(out).toEqual({ released: 1, completed: 1 });
    expect(completeSpy).toHaveBeenCalledTimes(1);
    expect(t.calls.expired).toEqual(['cs_open']);
    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith(t.prisma, 'a-open');
  });

  it('only holds that ran out, unpaid, with a checkout, are looked at', async () => {
    const t = build();
    await t.service.sweep(NOW);
    expect(t.prisma.appointment.findMany.mock.calls[0][0].where).toEqual({
      paymentHoldUntil: { lt: NOW },
      depositPaid: false,
      checkoutSessionId: { not: null },
    });
  });

  it('one hold failing does not stop the rest', async () => {
    const t = build();
    t.prisma.appointment.findMany.mockResolvedValue([
      { id: 'a1', tenantId: TENANT, checkoutSessionId: 'cs_1' },
      { id: 'a2', tenantId: TENANT, checkoutSessionId: 'cs_2' },
    ]);
    t.prisma.tenant.findUnique.mockResolvedValue({ stripeConnectAccountId: ACCOUNT });
    t.stripe.checkout.sessions.retrieve.mockRejectedValueOnce(new Error('Stripe down')).mockResolvedValueOnce({ id: 'cs_2', payment_status: 'unpaid', status: 'expired', metadata: {} });
    t.prisma.appointment.findFirst.mockResolvedValue({ id: 'a2', checkoutSessionId: 'cs_2' });
    jest.spyOn(require('./appointment-delete'), 'deleteAppointmentRow').mockResolvedValue(undefined);
    expect(await t.service.sweep(NOW)).toEqual({ released: 1, completed: 0 });
  });
});
