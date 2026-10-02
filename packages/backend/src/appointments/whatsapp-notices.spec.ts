import { AppointmentsService } from './appointments.service';

/**
 * Confirmations, cancellations and changes of an appointment go out on
 * WhatsApp with the salon's approved template first: as free text they are
 * refused outside WhatsApp's 24-hour window. When the salon has no WhatsApp
 * connected, or the template is not approved yet, the previous sender is
 * used, as before.
 */
function service(result: any) {
  const s = Object.create(AppointmentsService.prototype) as any;
  s.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  s.whatsappTemplates = { sendAppointmentNotice: jest.fn(async () => result) };
  return s;
}

const appointment = {
  id: 'a1',
  tenantId: 't1',
  client: { firstName: 'Ana', phone: '600111222' },
  tenant: { name: 'Salón Lucía', country: 'ES' },
  service: { name: 'Corte' },
  scheduledDate: new Date('2026-10-09T00:00:00.000Z'),
  scheduledTime: '17:00',
};

describe('AppointmentsService WhatsApp notices via the salon', () => {
  it.each(['confirmed', 'cancelled', 'rescheduled'])('sends the %s template with the appointment data', async (kind) => {
    const s = service({ sent: true, messageId: 'wamid' });
    expect(await s.sendWhatsAppViaSalon(kind, appointment)).toBe(true);
    expect(s.whatsappTemplates.sendAppointmentNotice).toHaveBeenCalledWith('t1', kind, {
      phone: '600111222',
      clientName: 'Ana',
      salonName: 'Salón Lucía',
      serviceName: 'Corte',
      date: appointment.scheduledDate,
      time: '17:00',
      country: 'ES',
    });
  });

  it('returns false so the caller falls back when the template is not usable', async () => {
    expect(await service({ sent: false, reason: 'template_pending' }).sendWhatsAppViaSalon('confirmed', appointment)).toBe(false);
    expect(await service({ sent: false, reason: 'not_connected' }).sendWhatsAppViaSalon('cancelled', appointment)).toBe(false);
  });

  it('returns false, without throwing, when the send fails', async () => {
    const s = service(null);
    s.whatsappTemplates.sendAppointmentNotice.mockRejectedValue(new Error('network'));
    expect(await s.sendWhatsAppViaSalon('rescheduled', appointment)).toBe(false);
  });

  it('returns false when the template service is not available', async () => {
    const s = service(null);
    s.whatsappTemplates = undefined;
    expect(await s.sendWhatsAppViaSalon('confirmed', appointment)).toBe(false);
  });
});
