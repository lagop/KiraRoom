import { ServiceUnavailableException } from '@nestjs/common';
import { AppointmentsService } from './appointments.service';
import { HOLD_MINUTES } from './online-booking-payment.service';

/**
 * A booking that has to be paid online: held while she pays, nothing sent to
 * anyone until it is paid, released if the payment page cannot be made, and
 * confirmed (with its notices) when Stripe says it was paid.
 */
const PLAN = { kind: 'deposit' as const, cents: 1500, totalCents: 6000, currency: 'eur', serviceName: 'Tinte', accountId: 'acct_1', livemode: false };

function setup(opts: { plan?: typeof PLAN | null; checkoutFails?: boolean } = {}) {
  const prisma: any = {
    $transaction: async (fn: any) => fn({ $executeRaw: jest.fn() }),
    appointment: {
      update: jest.fn(async () => ({})),
      findFirst: jest.fn(async () => ({ id: 'apt-1', tenantId: 'tenant-1', source: 'online', status: 'confirmed' })),
    },
  };
  const onlinePayments: any = {
    plan: jest.fn(async () => (opts.plan === undefined ? PLAN : opts.plan)),
    createCheckout: jest.fn(async () => {
      if (opts.checkoutFails) throw new ServiceUnavailableException('No se ha podido iniciar el pago.');
      return { checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_1', sessionId: 'cs_1', holdUntil: new Date('2026-11-10T10:36:00.000Z') };
    }),
    expire: jest.fn(async () => true),
    complete: jest.fn(),
  };
  const salonAlerts = { notify: jest.fn() };
  const stub = {} as any;
  const service = new AppointmentsService(
    prisma, stub, stub, stub, stub, stub, stub,
    undefined, undefined, undefined, undefined, undefined, undefined,
    salonAlerts as any, onlinePayments,
  );
  const s = service as any;
  s.assertBookableOnline = jest.fn(async () => undefined);
  s.onlineBookingWindow = jest.fn(async () => ({ minHours: 0, maxHours: 24 * 60 }));
  s.fitsOnlineWindow = jest.fn(() => 'ok');
  s.isSlotFree = jest.fn(async () => true);
  s.insertAppointment = jest.fn(async () => ({ id: 'apt-1', clientId: 'client-1', status: 'pending', client: { email: 'a@mail.test' } }));
  s.afterAppointmentCreated = jest.fn(async () => ({ emailSent: true, smsSent: false }));
  return { service, s, prisma, onlinePayments, salonAlerts };
}

const BOOKING = {
  professionalId: '11111111-1111-4111-8111-111111111111',
  serviceId: '33333333-3333-4333-8333-333333333333',
  scheduledDate: '2026-11-10',
  scheduledTime: '10:00',
  clientInfo: { firstName: 'Ana', lastName: 'López', phone: '600 111 222' },
};

describe('a booking that does not need to be paid', () => {
  it('goes through exactly as before: no hold, its notices sent', async () => {
    const { service, s, salonAlerts } = setup({ plan: null });
    const out: any = await service.bookOnline('tenant-1', BOOKING as any);
    expect(s.insertAppointment.mock.calls[0][2]).not.toHaveProperty('hold');
    expect(s.afterAppointmentCreated).toHaveBeenCalledTimes(1);
    expect(salonAlerts.notify).toHaveBeenCalledWith('booked', 'apt-1');
    expect(out).not.toHaveProperty('payment');
    expect(out.confirmationEmailSent).toBe(true);
  });

  it('a service without online payments is the same, even if the salon never heard of them', async () => {
    const { service, s } = setup({ plan: null });
    await service.bookOnline('tenant-1', { ...BOOKING, payment: 'full' } as any);
    expect(s.insertAppointment.mock.calls[0][2]).not.toHaveProperty('hold');
  });
});

describe('a booking that has to be paid online', () => {
  it('is created held, for the amount and kind the server decided, until it is paid', async () => {
    const before = Date.now();
    const { service, s, onlinePayments } = setup();
    await service.bookOnline('tenant-1', { ...BOOKING, payment: 'full' } as any);
    const hold = s.insertAppointment.mock.calls[0][2].hold;
    expect(hold).toMatchObject({ kind: 'deposit', cents: 1500 });
    expect(hold.until.getTime()).toBeGreaterThanOrEqual(before + HOLD_MINUTES * 60_000 - 1000);
    // What she picked goes to the decision; it is not the amount.
    expect(onlinePayments.plan).toHaveBeenCalledWith('tenant-1', expect.objectContaining({ payment: 'full' }));
  });

  it('answers with the payment page, and says nothing is confirmed yet', async () => {
    const { service, prisma } = setup();
    const out: any = await service.bookOnline('tenant-1', BOOKING as any);
    expect(out.payment).toEqual({
      required: true,
      kind: 'deposit',
      amountCents: 1500,
      currency: 'eur',
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_1',
      holdUntil: '2026-11-10T10:36:00.000Z',
    });
    expect(out.confirmationEmailSent).toBe(false);
    expect(out.confirmationSmsSent).toBe(false);
    expect(prisma.appointment.update).toHaveBeenCalledWith({
      where: { id: 'apt-1' },
      data: { checkoutSessionId: 'cs_1', paymentHoldUntil: new Date('2026-11-10T10:36:00.000Z') },
    });
  });

  it('sends nothing to the client or the salon until it is paid', async () => {
    const { service, s, salonAlerts } = setup();
    await service.bookOnline('tenant-1', BOOKING as any);
    expect(s.afterAppointmentCreated).not.toHaveBeenCalled();
    expect(salonAlerts.notify).not.toHaveBeenCalled();
  });

  it('if the payment page cannot be made the held booking is released and she is told to try again', async () => {
    const del = jest.spyOn(require('./appointment-delete'), 'deleteAppointmentRow').mockResolvedValue(undefined);
    const { service, s, salonAlerts } = setup({ checkoutFails: true });
    await expect(service.bookOnline('tenant-1', BOOKING as any)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(del).toHaveBeenCalledWith(expect.anything(), 'apt-1');
    expect(s.afterAppointmentCreated).not.toHaveBeenCalled();
    expect(salonAlerts.notify).not.toHaveBeenCalled();
    del.mockRestore();
  });
});

describe('Stripe tells us about the payment', () => {
  const event = (type: string) => ({ id: 'evt_1', type, account: 'acct_1', data: { object: { id: 'cs_1' } } }) as any;

  it('paid: the booking sends what a booking sends, to her and to the salon', async () => {
    const { service, s, onlinePayments, salonAlerts } = setup();
    onlinePayments.complete.mockResolvedValue({ result: 'paid', appointmentId: 'apt-1', tenantId: 'tenant-1' });
    await service.handleOnlinePaymentEvent(event('checkout.session.completed'));
    expect(onlinePayments.complete).toHaveBeenCalledWith({ id: 'cs_1' }, 'acct_1');
    expect(s.afterAppointmentCreated).toHaveBeenCalledTimes(1);
    expect(s.afterAppointmentCreated.mock.calls[0][2]).toEqual({ publicBooking: true });
    expect(salonAlerts.notify).toHaveBeenCalledWith('booked', 'apt-1');
  });

  it('a notice that changes nothing (already paid, refunded, ignored) sends nothing', async () => {
    const { service, s, onlinePayments, salonAlerts } = setup();
    for (const result of [
      { result: 'already_paid', appointmentId: 'apt-1' },
      { result: 'refunded_no_booking' },
      { result: 'ignored' },
    ]) {
      onlinePayments.complete.mockResolvedValue(result);
      await service.handleOnlinePaymentEvent(event('checkout.session.completed'));
    }
    expect(s.afterAppointmentCreated).not.toHaveBeenCalled();
    expect(salonAlerts.notify).not.toHaveBeenCalled();
  });

  it('expired: the held booking is released, nothing is sent', async () => {
    const { service, s, onlinePayments } = setup();
    await service.handleOnlinePaymentEvent(event('checkout.session.expired'));
    expect(onlinePayments.expire).toHaveBeenCalledWith({ id: 'cs_1' });
    expect(onlinePayments.complete).not.toHaveBeenCalled();
    expect(s.afterAppointmentCreated).not.toHaveBeenCalled();
  });

  it('a failure sending the notices never undoes the payment', async () => {
    const { service, s, onlinePayments } = setup();
    onlinePayments.complete.mockResolvedValue({ result: 'paid', appointmentId: 'apt-1', tenantId: 'tenant-1' });
    s.afterAppointmentCreated.mockRejectedValue(new Error('mail down'));
    await expect(service.handleOnlinePaymentEvent(event('checkout.session.completed'))).resolves.toBeUndefined();
  });

  it('without the payments service the events are simply ignored', async () => {
    const stub = {} as any;
    const bare = new AppointmentsService({} as any, stub, stub, stub, stub, stub, stub);
    await expect(bare.handleOnlinePaymentEvent(event('checkout.session.completed'))).resolves.toBeUndefined();
  });
});
