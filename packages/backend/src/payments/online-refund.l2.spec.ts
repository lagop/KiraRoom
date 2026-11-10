import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { OnlineBookingPaymentService } from '../appointments/online-booking-payment.service';
import { OnlinePaymentAlertsService } from './services/online-payment-alerts.service';

/**
 * L2: giving back what a client paid online when she booked (señal / pago
 * anticipado), against a real database with a fake Stripe.
 *
 *   - A refund of an online payment is made on the salon's Stripe account
 *     FIRST, then recorded (the payment, its refund with Stripe's id, the
 *     appointment's amountPaid); if Stripe refuses, nothing changes.
 *   - A refund the salon made in its own Stripe Dashboard is recorded once
 *     (charge.refunded), never twice, and never for another account's charge.
 *   - Cancelling a paid booking gives its online payments back in full;
 *     one that cannot be given back is counted, not hidden.
 *
 * Skipped when no database is reachable, so \`npm test\` stays green on a
 * workstation without Postgres. CI provides one.
 */
const prisma = new PrismaClient();
const db: any = prisma;
let reachable = false;
let tenantId: string;
let clientId: string;
let serviceId: string;
let professionalId: string;
const run = randomUUID().slice(0, 8);
const ACCOUNT = 'acct_l2_salon';
// Built at runtime: a fictitious value that only looks like a Stripe key (gitleaks).
const fakeKey = ['sk', 'test', 'xxxxxxxxxxxx1234'].join('_');

let refundSeq = 0;
function fakeStripe() {
  const created: any[] = [];
  const listed: any[] = [];
  const stripe: any = {
    refunds: {
      create: jest.fn(async (params: any, options: any) => {
        created.push({ params, options });
        return { id: `re_l2_${run}_${++refundSeq}`, amount: params.amount, status: 'succeeded' };
      }),
      list: jest.fn(async () => ({ data: listed })),
    },
  };
  const platform = { client: () => stripe, mode: () => 'test' };
  return { stripe, platform, created, listed };
}

let seq = 0;
/** An appointment with a deposit paid online, and its payment. */
async function paidBooking(over: { amount?: number; account?: string | null; stripePaymentId?: string | null; type?: string } = {}) {
  const amount = over.amount ?? 1500;
  const apt = await db.appointment.create({
    data: {
      tenantId,
      clientId,
      serviceId,
      professionalId,
      scheduledDate: new Date(Date.now() + 5 * 864e5),
      scheduledTime: '10:00',
      duration: 30,
      endTime: '10:30',
      price: 60,
      totalAmount: 6000,
      amountPaid: amount,
      depositPaid: true,
      status: 'confirmed',
    },
  });
  const pi = over.stripePaymentId === undefined ? `pi_l2_${run}_${++seq}` : over.stripePaymentId;
  const payment = await db.payment.create({
    data: {
      tenantId,
      clientId,
      appointmentId: apt.id,
      amount,
      type: over.type ?? 'deposit',
      status: 'paid',
      method: 'card',
      isDeposit: true,
      stripePaymentId: pi,
      metadata: over.account === null ? {} : { online: true, stripeAccount: over.account ?? ACCOUNT },
    },
  });
  return { apt, payment, pi: pi as string };
}

const payments = (platform: unknown) => new PaymentsService(db, undefined, undefined, undefined, undefined, platform as any);
const refundsOf = (paymentId: string) => db.refund.findMany({ where: { paymentId }, orderBy: { createdAt: 'asc' } });

beforeAll(async () => {
  try {
    await prisma.$connect();
    reachable = true;
  } catch (e) {
    console.error('[l2] database unreachable, skipping:', (e as Error).message.slice(0, 160));
    return;
  }
  const tenant = await db.tenant.create({
    data: {
      name: 'L2 online refunds',
      slug: `l2-online-refunds-${run}`,
      plan: 'pro',
      subscriptionStatus: 'active',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 864e5),
      fiscalSettings: { pricesIncludeTax: true, defaultTaxRate: 21, defaultSeries: 'A' },
    },
  });
  tenantId = tenant.id;
  serviceId = (await db.service.create({ data: { tenantId, name: 'Tinte', category: 'hair', duration: 30, price: 60 } })).id;
  professionalId = (
    await db.professional.create({
      data: { tenantId, firstName: 'Pro', lastName: 'Fesional', email: `pro-${run}@example.test`, hireDate: new Date() },
    })
  ).id;
  clientId = (await db.client.create({ data: { tenantId, firstName: 'Ana', lastName: 'Prueba' } })).id;
}, 60_000);

afterAll(async () => {
  if (reachable && tenantId) {
    const where = { tenantId };
    await db.refund.deleteMany({ where: { payment: where } }).catch(() => undefined);
    await db.payment.deleteMany({ where }).catch(() => undefined);
    await db.appointment.deleteMany({ where }).catch(() => undefined);
    await db.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  }
  await prisma.$disconnect();
});

describe('refunding an online payment (L2, real database)', () => {
  it('Stripe gives the money back on the salon\'s account first, then it is recorded everywhere', async () => {
    if (!reachable) return;
    const { platform, created } = fakeStripe();
    const { apt, payment, pi } = await paidBooking();
    const out = await payments(platform).refundPayment(tenantId, payment.id, { amount: 1500, reason: 'Cita cancelada' }, 'user-1');

    expect(created).toHaveLength(1);
    expect(created[0].params).toMatchObject({ payment_intent: pi, amount: 1500, reason: 'requested_by_customer' });
    expect(created[0].options).toMatchObject({ stripeAccount: ACCOUNT, idempotencyKey: `refund-${payment.id}-0-1500` });

    const [refund] = await refundsOf(payment.id);
    expect(refund).toMatchObject({ amount: 1500, status: 'succeeded', adminId: 'user-1' });
    expect(refund.stripeRefundId).toMatch(/^re_l2_/);
    expect((await db.payment.findUnique({ where: { id: payment.id } })).status).toBe('refunded');
    expect(Number((await db.appointment.findUnique({ where: { id: apt.id } })).amountPaid)).toBe(0);
    expect((await db.appointment.findUnique({ where: { id: apt.id } })).paymentStatus).toBe('refunded');
    expect(out).toMatchObject({ refundedAmount: 1500, refundableAmount: 0 });
  });

  it('a partial refund leaves the rest refundable; the next one has its own idempotency key', async () => {
    if (!reachable) return;
    const { platform, created } = fakeStripe();
    const { payment } = await paidBooking({ amount: 2000 });
    const svc = payments(platform);
    await svc.refundPayment(tenantId, payment.id, { amount: 500, reason: 'Parte' }, null);
    await svc.refundPayment(tenantId, payment.id, { amount: 1500, reason: 'El resto' }, null);
    expect(created.map((c) => c.options.idempotencyKey)).toEqual([`refund-${payment.id}-0-500`, `refund-${payment.id}-500-1500`]);
    expect((await refundsOf(payment.id)).map((r: any) => r.amount)).toEqual([500, 1500]);
    expect((await db.payment.findUnique({ where: { id: payment.id } })).status).toBe('refunded');
  });

  it('if Stripe refuses, nothing changes here and the reason is clear, without any key', async () => {
    if (!reachable) return;
    const { platform, stripe } = fakeStripe();
    stripe.refunds.create.mockRejectedValueOnce(new Error(`Invalid API Key provided: ${fakeKey}`));
    const { apt, payment } = await paidBooking();
    const err = await payments(platform).refundPayment(tenantId, payment.id, { amount: 1500, reason: 'Cita cancelada' }, null).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(String(err.message)).toMatch(/Stripe no ha podido hacer la devolución/);
    expect(String(err.message)).not.toContain(fakeKey);
    expect(await refundsOf(payment.id)).toHaveLength(0);
    expect((await db.payment.findUnique({ where: { id: payment.id } })).status).toBe('paid');
    expect(Number((await db.appointment.findUnique({ where: { id: apt.id } })).amountPaid)).toBe(1500);
  });

  it('without Stripe keys it cannot be done now, and still changes nothing', async () => {
    if (!reachable) return;
    const { payment } = await paidBooking();
    await expect(
      payments({ client: () => null, mode: () => 'none' }).refundPayment(tenantId, payment.id, { amount: 1500, reason: 'x' }, null),
    ).rejects.toThrow(/Stripe no está disponible/);
    expect(await refundsOf(payment.id)).toHaveLength(0);
  });

  it('any other Stripe payment is still not ours to refund', async () => {
    if (!reachable) return;
    const { platform, created } = fakeStripe();
    const { payment } = await paidBooking({ account: null });
    await expect(payments(platform).refundPayment(tenantId, payment.id, { amount: 1500, reason: 'x' }, null)).rejects.toThrow(
      /devuélvelo desde tu cuenta de Stripe/,
    );
    expect(created).toHaveLength(0);
  });
});

describe('a refund made on the salon\'s Stripe Dashboard (L2, real database)', () => {
  const charge = (pi: string) => ({ id: `ch_${pi}`, payment_intent: pi }) as any;

  it('is recorded once, through the usual refund, and never twice', async () => {
    if (!reachable) return;
    const { platform, listed, created } = fakeStripe();
    const { apt, payment, pi } = await paidBooking();
    listed.push({ id: `re_ext_${run}_1`, amount: 1500, status: 'succeeded' });
    const svc = payments(platform);

    expect(await svc.reconcileOnlineRefunds(charge(pi), ACCOUNT)).toBe(1);
    expect(created).toHaveLength(0); // the money was already back: not refunded again
    const [refund] = await refundsOf(payment.id);
    expect(refund).toMatchObject({ amount: 1500, stripeRefundId: `re_ext_${run}_1`, reason: 'Devolución hecha desde Stripe' });
    expect((await db.payment.findUnique({ where: { id: payment.id } })).status).toBe('refunded');
    expect(Number((await db.appointment.findUnique({ where: { id: apt.id } })).amountPaid)).toBe(0);

    // The same notice again, or Stripe retrying it.
    expect(await svc.reconcileOnlineRefunds(charge(pi), ACCOUNT)).toBe(0);
    expect(await refundsOf(payment.id)).toHaveLength(1);
  });

  it('the refund our own cancellation made is not recorded a second time when its notice arrives', async () => {
    if (!reachable) return;
    const { platform, listed } = fakeStripe();
    const { payment, pi } = await paidBooking();
    const svc = payments(platform);
    await svc.refundPayment(tenantId, payment.id, { amount: 1500, reason: 'Cita cancelada' }, null);
    const [ours] = await refundsOf(payment.id);
    listed.push({ id: ours.stripeRefundId, amount: 1500, status: 'succeeded' });
    expect(await svc.reconcileOnlineRefunds(charge(pi), ACCOUNT)).toBe(0);
    expect(await refundsOf(payment.id)).toHaveLength(1);
  });

  it('a partial refund on Stripe is a partial refund here', async () => {
    if (!reachable) return;
    const { platform, listed } = fakeStripe();
    const { payment, pi } = await paidBooking({ amount: 2000 });
    listed.push({ id: `re_ext_${run}_2`, amount: 700, status: 'succeeded' });
    await payments(platform).reconcileOnlineRefunds(charge(pi), ACCOUNT);
    expect((await refundsOf(payment.id)).map((r: any) => r.amount)).toEqual([700]);
    expect((await db.payment.findUnique({ where: { id: payment.id } })).status).toBe('paid');
  });

  it('ignores a charge of another account, one that is not an online booking\'s, an unknown one, and refunds not done yet', async () => {
    if (!reachable) return;
    const { platform, listed } = fakeStripe();
    const mine = await paidBooking();
    const other = await paidBooking({ account: null });
    listed.push({ id: `re_ext_${run}_3`, amount: 1500, status: 'succeeded' });
    const svc = payments(platform);
    expect(await svc.reconcileOnlineRefunds(charge(mine.pi), 'acct_someone_else')).toBe(0);
    expect(await svc.reconcileOnlineRefunds(charge(other.pi), ACCOUNT)).toBe(0);
    expect(await svc.reconcileOnlineRefunds(charge('pi_unknown'), ACCOUNT)).toBe(0);
    listed.length = 0;
    listed.push({ id: `re_ext_${run}_4`, amount: 1500, status: 'pending' });
    expect(await svc.reconcileOnlineRefunds(charge(mine.pi), ACCOUNT)).toBe(0);
    expect(await refundsOf(mine.payment.id)).toHaveLength(0);
    expect(await refundsOf(other.payment.id)).toHaveLength(0);
  });
});

describe('cancelling a booking that was paid online (L2, real database)', () => {
  const alerts = { tellManagers: jest.fn(async () => undefined) };
  beforeEach(() => alerts.tellManagers.mockClear());
  const service = (platform: unknown) => {
    const pay = payments(platform);
    const moduleRef: any = { get: (token: unknown) => (token === OnlinePaymentAlertsService ? alerts : pay) };
    return new OnlineBookingPaymentService(db, platform as any, undefined, moduleRef);
  };

  it('gives every online payment back in full, and says how much', async () => {
    if (!reachable) return;
    const { platform, created } = fakeStripe();
    const { apt, payment } = await paidBooking({ amount: 1500 });
    const out = await service(platform).refundForCancellation({ id: apt.id, tenantId }, 'Cita cancelada: enferma', 'user-9');
    expect(out).toEqual({ refundedCents: 1500, failed: 0 });
    expect(created).toHaveLength(1);
    expect((await db.payment.findUnique({ where: { id: payment.id } })).status).toBe('refunded');
    expect((await refundsOf(payment.id))[0]).toMatchObject({ reason: 'Cita cancelada: enferma', adminId: 'user-9' });
  });

  it('a second cancellation of the same booking gives nothing back twice', async () => {
    if (!reachable) return;
    const { platform, created } = fakeStripe();
    const { apt } = await paidBooking();
    const svc = service(platform);
    await svc.refundForCancellation({ id: apt.id, tenantId }, 'x');
    const again = await svc.refundForCancellation({ id: apt.id, tenantId }, 'x');
    expect(again).toBeNull();
    expect(created).toHaveLength(1);
  });

  it('a booking with no online payment has nothing to give back', async () => {
    if (!reachable) return;
    const { platform, created } = fakeStripe();
    const { apt } = await paidBooking({ account: null });
    expect(await service(platform).refundForCancellation({ id: apt.id, tenantId }, 'x')).toBeNull();
    expect(created).toHaveLength(0);
  });

  it('a payment that cannot be given back is counted, not hidden, and the others still go', async () => {
    if (!reachable) return;
    const { platform, stripe } = fakeStripe();
    const { apt, payment } = await paidBooking({ amount: 1500 });
    // A second online payment on the same booking (a señal, then the rest).
    const second = await db.payment.create({
      data: {
        tenantId, clientId, appointmentId: apt.id, amount: 800, type: 'appointment', status: 'paid', method: 'card',
        stripePaymentId: `pi_l2_${run}_extra`, metadata: { online: true, stripeAccount: ACCOUNT },
      },
    });
    stripe.refunds.create.mockRejectedValueOnce(new Error('Stripe down'));
    const out = await service(platform).refundForCancellation({ id: apt.id, tenantId }, 'x');
    expect(out).toEqual({ refundedCents: 800, failed: 1 });
    // The one that failed stays paid, so the salon can give it back from Pagos.
    const statuses = await Promise.all([payment.id, second.id].map(async (id) => (await db.payment.findUnique({ where: { id } })).status));
    expect(statuses.sort()).toEqual(['paid', 'refunded']);
    // The salon is told, so the client is not left without her money.
    expect(alerts.tellManagers).toHaveBeenCalledWith(tenantId, expect.objectContaining({ title: 'No se pudo devolver un pago online', key: `refund-failed-${apt.id}` }));
  });

  it('without the payments service there is nothing to do, and no error', async () => {
    if (!reachable) return;
    const { apt } = await paidBooking();
    const bare = new OnlineBookingPaymentService(db, undefined, undefined, undefined);
    expect(await bare.refundForCancellation({ id: apt.id, tenantId }, 'x')).toBeNull();
  });
});
