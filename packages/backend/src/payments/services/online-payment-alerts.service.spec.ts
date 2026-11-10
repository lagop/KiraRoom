/**
 * What a salon is told about an online payment that needs a person: every
 * owner and admin, in the panel and by email, and never a failure that
 * undoes the payment event.
 */
import { OnlinePaymentAlertsService, eurosText } from './online-payment-alerts.service';

const notice = { title: 'No se pudo devolver un pago online', message: 'Devuélvelo <a mano>', link: '/dashboard/payments', key: 'k1' };

function build(over: { managers?: any[]; notifyFails?: boolean; emailFails?: boolean; noEmail?: boolean } = {}) {
  const managers = over.managers ?? [
    { id: 'u1', email: 'owner@salon.test', firstName: 'Ana' },
    { id: 'u2', email: null, firstName: null },
  ];
  const prisma: any = { user: { findMany: jest.fn(async () => managers) } };
  const notifications: any = {
    create: jest.fn(async () => {
      if (over.notifyFails) throw new Error('ws down');
    }),
  };
  const email: any = {
    sendEmail: jest.fn(async () => (over.emailFails ? { success: false, error: 'resend down' } : { success: true })),
  };
  const service = new OnlinePaymentAlertsService(prisma, notifications, over.noEmail ? undefined : email);
  (service as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { service, prisma, notifications, email };
}

describe('OnlinePaymentAlertsService', () => {
  it('tells every owner and admin of the salon in the panel, and emails those with an address', async () => {
    const { service, prisma, notifications, email } = build();
    await service.tellManagers('t1', notice);
    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tenantId: 't1', role: { in: ['owner', 'admin'] }, isActive: true }) }));
    expect(notifications.create).toHaveBeenCalledTimes(2);
    expect(notifications.create).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', userId: 'u1', title: notice.title, data: { event: 'online_payment', link: '/dashboard/payments' } }));
    expect(email.sendEmail).toHaveBeenCalledTimes(1);
    const sent = email.sendEmail.mock.calls[0][0];
    expect(sent.to).toBe('owner@salon.test');
    expect(sent.idempotencyKey).toBe('k1-u1');
    // Text from data is escaped in the HTML.
    expect(sent.html).toContain('Devuélvelo &lt;a mano&gt;');
    expect(sent.html).toContain('/dashboard/payments');
  });

  it('never fails: a notification or an email that breaks costs nobody else theirs', async () => {
    const a = build({ notifyFails: true });
    await expect(a.service.tellManagers('t1', notice)).resolves.toBeUndefined();
    expect(a.email.sendEmail).toHaveBeenCalledTimes(1);
    const b = build({ emailFails: true });
    await expect(b.service.tellManagers('t1', notice)).resolves.toBeUndefined();
    const c = build();
    c.prisma.user.findMany.mockRejectedValue(new Error('db down'));
    await expect(c.service.tellManagers('t1', notice)).resolves.toBeUndefined();
  });

  it('works without the email service (panel only)', async () => {
    const { service, notifications } = build({ noEmail: true });
    await service.tellManagers('t1', notice);
    expect(notifications.create).toHaveBeenCalledTimes(2);
  });

  it('amounts read in euros', () => {
    expect(eurosText(1500)).toBe('15,00 €');
    expect(eurosText(5)).toBe('0,05 €');
  });
});
