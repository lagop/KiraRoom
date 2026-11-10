import { AppointmentsService } from './appointments.service';
import { appointmentCancelToken } from './public-cancel-link';

/**
 * The page Stripe sends the client back to (/public/cita/:token) for a booking
 * that has to be paid: held, paid, or let go. Letting go is not a
 * cancellation: the booking was never announced, so nobody is told.
 */
const APT = '11111111-1111-4111-8111-111111111111';
const SECRET = 'link-test-secret';
const NOW = new Date('2026-12-01T10:00:00.000Z');

const base = (over: Record<string, unknown> = {}) => ({
  id: APT,
  tenantId: 't1',
  status: 'pending',
  source: 'online',
  scheduledDate: new Date('2026-12-10T00:00:00.000Z'),
  scheduledTime: '10:00',
  service: { name: 'Tinte' },
  professional: { firstName: 'Ana' },
  tenant: { name: 'Salón Luna', phone: '910 000 111', timezone: 'Europe/Madrid', minCancelHours: 24, deletedAt: null },
  totalAmount: 6000,
  depositAmount: 1500,
  depositPaid: false,
  paymentHoldUntil: new Date('2026-12-01T10:30:00.000Z'),
  checkoutSessionId: 'cs_1',
  onlinePaymentKind: 'deposit',
  ...over,
});

function harness(row: any, payments: Record<string, jest.Mock> = {}) {
  const prisma: any = { appointment: { findUnique: jest.fn(async () => row) } };
  const onlinePayments: any = {
    releaseByClient: jest.fn(async () => true),
    reopenCheckoutUrl: jest.fn(async () => 'https://checkout.stripe.com/c/pay/cs_1'),
    ...payments,
  };
  const salonAlerts = { notify: jest.fn() };
  const stub = {} as any;
  const svc = new AppointmentsService(
    prisma, stub, stub, stub, stub, stub, stub,
    undefined, undefined, undefined, undefined, undefined, undefined,
    salonAlerts as any, onlinePayments,
  );
  const change = jest.spyOn(svc, 'changeStatus').mockResolvedValue({} as any);
  return { svc, change, onlinePayments, salonAlerts, token: appointmentCancelToken(APT, SECRET) };
}

beforeAll(() => {
  process.env.JWT_SECRET = SECRET;
});

describe('the booking page of a booking held for its payment', () => {
  it('says it is awaiting payment, how much, and until when; she may pay or let go', async () => {
    const { svc, token } = harness(base());
    const info = await svc.describeCancelLink(token, NOW);
    expect(info).toMatchObject({
      state: 'awaiting_payment',
      canCancel: true,
      payment: { state: 'awaiting', kind: 'deposit', amountCents: 1500, holdUntil: '2026-12-01T10:30:00.000Z' },
    });
  });

  it('paying everything shows the whole price', async () => {
    const { svc, token } = harness(base({ onlinePaymentKind: 'full' }));
    expect((await svc.describeCancelLink(token, NOW))!.payment).toMatchObject({ kind: 'full', amountCents: 6000 });
  });

  it('once paid the payment is shown; in time she may cancel it (the payment goes back), too late she is sent to the salon', async () => {
    const paid = base({ status: 'confirmed', paymentHoldUntil: null, depositPaid: true });
    const { svc, change, token } = harness(paid);
    expect(await svc.describeCancelLink(token, NOW)).toMatchObject({
      state: 'cancellable',
      canCancel: true,
      payment: { state: 'paid', kind: 'deposit', amountCents: 1500, holdUntil: null },
    });
    // Pressing the button cancels it through the usual path, which gives the payment back.
    await svc.cancelFromLink(token, NOW);
    expect(change).toHaveBeenCalledWith(
      expect.objectContaining({ via: 'client_cancel_link' }),
      APT,
      'cancelled',
      expect.anything(),
    );

    // Inside the salon's notice window nothing changes: the salon decides about the money.
    const late = harness(base({ status: 'confirmed', paymentHoldUntil: null, depositPaid: true }));
    const inside = new Date('2026-12-10T00:00:00.000Z');
    expect(await late.svc.describeCancelLink(late.token, inside)).toMatchObject({ state: 'too_late', canCancel: false, payment: { state: 'paid' } });
    await late.svc.cancelFromLink(late.token, inside);
    expect(late.change).not.toHaveBeenCalled();
  });

  it('a booking without online payment shows none', async () => {
    const { svc, token } = harness(base({ paymentHoldUntil: null, checkoutSessionId: null, onlinePaymentKind: null, status: 'confirmed' }));
    expect((await svc.describeCancelLink(token, NOW))!.payment).toEqual({ state: 'none', kind: null, amountCents: null, holdUntil: null });
  });

  it('describing changes nothing', async () => {
    const { svc, change, onlinePayments, token } = harness(base());
    await svc.describeCancelLink(token, NOW);
    expect(change).not.toHaveBeenCalled();
    expect(onlinePayments.releaseByClient).not.toHaveBeenCalled();
  });
});

describe('letting go of a held booking', () => {
  it('closes the payment page and frees the slot, without a cancellation or any notice', async () => {
    const { svc, change, onlinePayments, salonAlerts, token } = harness(base());
    const out = await svc.cancelFromLink(token, NOW);
    expect(onlinePayments.releaseByClient).toHaveBeenCalledTimes(1);
    expect(change).not.toHaveBeenCalled();
    expect(salonAlerts.notify).not.toHaveBeenCalled();
    expect(out).toMatchObject({ state: 'cancelled', canCancel: false, payment: { state: 'none', holdUntil: null } });
  });

  it('if she paid while deciding, the booking stands and the page says how it is', async () => {
    const row: any = base();
    const { svc, change, token } = harness(row, {
      releaseByClient: jest.fn(async () => {
        Object.assign(row, { paymentHoldUntil: null, depositPaid: true, status: 'confirmed' });
        return false;
      }),
    });
    const out = await svc.cancelFromLink(token, NOW);
    expect(change).not.toHaveBeenCalled();
    expect(out).toMatchObject({ payment: { state: 'paid' } });
  });
});

describe('paying again from the link', () => {
  it('gives the same payment page back while it is open', async () => {
    const { svc, token } = harness(base());
    expect(await svc.payAgainFromLink(token)).toEqual({ checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_1' });
  });

  it('nothing once the time ran out, or when it was paid, or for a bad token', async () => {
    expect(await harness(base(), { reopenCheckoutUrl: jest.fn(async () => null) }).svc.payAgainFromLink(appointmentCancelToken(APT, SECRET))).toBeNull();
    const paid = harness(base({ paymentHoldUntil: null, depositPaid: true }));
    expect(await paid.svc.payAgainFromLink(paid.token)).toBeNull();
    expect(await harness(base()).svc.payAgainFromLink('nope.nope')).toBeNull();
  });
});
