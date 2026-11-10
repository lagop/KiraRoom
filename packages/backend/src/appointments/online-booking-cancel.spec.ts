import { AppointmentsService } from './appointments.service';

/**
 * Cancelling a booking that was paid online gives the payment back in full,
 * unless the salon says it keeps it; other changes of status never do, and a
 * refund that fails never fails the cancellation.
 */
function setup(refund: jest.Mock) {
  const onlinePayments: any = { refundForCancellation: refund };
  const stub = {} as any;
  const svc = new AppointmentsService(
    {} as any, stub, stub, stub, stub, stub, stub,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, onlinePayments,
  );
  const s = svc as any;
  s.findOne = jest.fn(async () => ({ id: 'apt-1', tenantId: 't1', status: 'confirmed' }));
  s.prepareStatusChange = jest.fn(async () => ({ status: 'cancelled' }));
  s.afterStatusChange = jest.fn(async () => undefined);
  s.enrichAppointment = (a: any) => ({ ...a });
  s.prisma = { appointment: { update: jest.fn(async ({ data }: any) => ({ id: 'apt-1', tenantId: 't1', ...data })) } };
  return svc;
}
const user = { id: 'u1', role: 'owner', tenantId: 't1' };

describe('cancelling an appointment paid online', () => {
  it('gives the money back, with the reason, and says how much', async () => {
    const refund = jest.fn(async () => ({ refundedCents: 1500, failed: 0 }));
    const out: any = await setup(refund).changeStatus(user, 'apt-1', 'cancelled' as any, { reason: 'Enferma' });
    expect(refund).toHaveBeenCalledWith({ id: 'apt-1', tenantId: 't1' }, 'Cita cancelada: Enferma', 'u1');
    expect(out.onlineRefund).toEqual({ refundedCents: 1500, failed: 0 });
  });

  it('without a reason it says only that the booking was cancelled', async () => {
    const refund = jest.fn(async () => null);
    const out: any = await setup(refund).changeStatus(user, 'apt-1', 'cancelled' as any, {});
    expect(refund).toHaveBeenCalledWith({ id: 'apt-1', tenantId: 't1' }, 'Cita cancelada', 'u1');
    expect(out).not.toHaveProperty('onlineRefund');
  });

  it('the salon can keep what she paid (a late cancellation it charges for)', async () => {
    const refund = jest.fn();
    await setup(refund).changeStatus(user, 'apt-1', 'cancelled' as any, { keepOnlinePayment: true });
    expect(refund).not.toHaveBeenCalled();
  });

  it('completing, a no-show or any other change never gives anything back', async () => {
    const refund = jest.fn();
    const svc = setup(refund);
    for (const to of ['completed', 'no_show', 'confirmed', 'in_progress']) {
      await svc.changeStatus(user, 'apt-1', to as any, {});
    }
    expect(refund).not.toHaveBeenCalled();
  });

  it('a refund that fails does not undo the cancellation', async () => {
    const refund = jest.fn(async () => {
      throw new Error('Stripe down');
    });
    const out: any = await setup(refund).changeStatus(user, 'apt-1', 'cancelled' as any, {});
    expect(out).toMatchObject({ id: 'apt-1', status: 'cancelled' });
    expect(out).not.toHaveProperty('onlineRefund');
  });

  it('a system cancellation (the link, the expiry job) has no user and still refunds', async () => {
    const refund = jest.fn(async () => ({ refundedCents: 800, failed: 0 }));
    await setup(refund).changeStatus({ role: 'system', tenantId: 't1', via: 'client_cancel_link' }, 'apt-1', 'cancelled' as any, {});
    expect(refund).toHaveBeenCalledWith({ id: 'apt-1', tenantId: 't1' }, 'Cita cancelada', null);
  });

  it('without the payments service nothing is attempted', async () => {
    const stub = {} as any;
    const svc: any = new AppointmentsService({} as any, stub, stub, stub, stub, stub, stub);
    svc.findOne = jest.fn(async () => ({ id: 'apt-1', tenantId: 't1', status: 'confirmed' }));
    svc.prepareStatusChange = jest.fn(async () => ({ status: 'cancelled' }));
    svc.afterStatusChange = jest.fn(async () => undefined);
    svc.enrichAppointment = (a: any) => a;
    svc.prisma = { appointment: { update: jest.fn(async () => ({ id: 'apt-1', tenantId: 't1' })) } };
    await expect(svc.changeStatus(user, 'apt-1', 'cancelled', {})).resolves.toMatchObject({ id: 'apt-1' });
  });
});

describe('a booking still held for its online payment', () => {
  function held(over: Record<string, unknown> = {}) {
    const stub = {} as any;
    const consent = { hasValidConsent: async () => true } as any;
    const svc: any = new AppointmentsService({} as any, stub, stub, stub, stub, stub, consent);
    svc.findOne = jest.fn(async () => ({
      id: 'apt-1', tenantId: 't1', status: 'pending',
      paymentHoldUntil: new Date(Date.now() + 20 * 60_000), depositPaid: false, ...over,
    }));
    svc.afterStatusChange = jest.fn(async () => undefined);
    svc.enrichAppointment = (a: any) => a;
    svc.prisma = { appointment: { update: jest.fn(async ({ data }: any) => ({ id: 'apt-1', tenantId: 't1', ...data })) } };
    return svc;
  }

  it('cannot be confirmed, started, completed or marked a no-show by the team: it confirms itself when she pays', async () => {
    const svc = held();
    for (const to of ['confirmed', 'in_progress', 'completed', 'no_show']) {
      await expect(svc.changeStatus(user, 'apt-1', to as any, {})).rejects.toMatchObject({
        response: { code: 'AWAITING_ONLINE_PAYMENT' },
      });
    }
    expect(svc.prisma.appointment.update).not.toHaveBeenCalled();
  });

  it('can be let go: cancelling it is allowed', async () => {
    await expect(held().changeStatus(user, 'apt-1', 'cancelled' as any, {})).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('once paid (hold released) or never held, it changes status as any booking', async () => {
    await expect(held({ paymentHoldUntil: null, depositPaid: true, status: 'confirmed' }).changeStatus(user, 'apt-1', 'in_progress' as any, {})).resolves.toBeDefined();
    await expect(held({ paymentHoldUntil: null }).changeStatus(user, 'apt-1', 'confirmed' as any, {})).resolves.toBeDefined();
  });
});
