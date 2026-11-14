import { SalonCopilotToolsService } from './salon-copilot-tools';

/**
 * L-4 contract tests for sprint 14: write tools. The service-level
 * approval flow is exercised separately in
 * `assistant.service.l4.spec.ts` (see Sprint14 approval flow). Here we
 * test the tool implementations themselves.
 */

const TENANT_ID = 't-1';

function makePrisma(opts: {
  appointments?: any[];
  clients?: any[];
  professionals?: any[];
  products?: any[];
  whatsAppConnection?: any;
  tenant?: any;
}): any {
  const appts = opts.appointments ?? [];
  const cls = opts.clients ?? [];
  const pros = opts.professionals ?? [];
  const conn = opts.whatsAppConnection ?? null;

  return {
    tenant: { findUnique: jest.fn(async () => opts.tenant ?? null) },
    appointment: {
      findFirst: jest.fn().mockImplementation(async ({ where }: any) => {
        return appts.find((a: any) => {
          if (where?.clientId && a.clientId !== where.clientId) return false;
          if (where?.professionalId && where.professionalId.in && !where.professionalId.in.includes(a.professionalId)) return false;
          if (where?.professionalId && !where.professionalId.in && a.professionalId !== where.professionalId) return false;
          return true;
        }) ?? null;
      }),
      findUnique: jest.fn().mockImplementation(async ({ where }: any) => appts.find((a: any) => a.id === where?.id) ?? null),
      update: jest.fn().mockImplementation(async ({ where, data }: any) => {
        const idx = appts.findIndex((a: any) => a.id === where.id);
        if (idx < 0) throw new Error('not_found');
        const next = { ...appts[idx], ...data };
        appts[idx] = next;
        return next;
      }),
    },
    client: {
      findFirst: jest.fn().mockImplementation(async ({ where }: any) => {
        // `appointments.some` is the staff reach rule (an appointment with her that is not cancelled).
        const reach = where?.appointments?.some;
        return cls.find((c: any) => {
          if (c.id !== where?.id) return false;
          if (where?.tenantId && c.tenantId !== where.tenantId) return false;
          if (reach) {
            return appts.some((a: any) => a.clientId === c.id && a.professionalId === reach.professionalId && a.status !== 'cancelled');
          }
          return true;
        }) ?? null;
      }),
      findUnique: jest.fn().mockImplementation(async ({ where }: any) => cls.find((c: any) => c.id === where?.id) ?? null),
    },
    professional: {
      findFirst: jest.fn().mockImplementation(async ({ where }: any) =>
        pros.find((p: any) => p.userId === where?.user?.id) ?? null,
      ),
    },
    product: {
      findMany: jest.fn(),
    },
    whatsAppConnection: {
      findUnique: jest.fn().mockImplementation(async ({ where }: any) =>
        conn && conn.tenantId === where.tenantId ? conn : null,
      ),
    },
  };
}

describe('SalonCopilotToolsService (L-4) — sprint 14 write tools', () => {
  describe('draft_follow_up_message', () => {
    it('returns a draft, never sends, and does not require a phone', async () => {
      const prisma = makePrisma({
        clients: [{ id: 'c-1', tenantId: TENANT_ID, firstName: 'Carmen', phone: null }],
      });
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute('draft_follow_up_message', { clientId: 'c-1' }, {
        prisma,
        tenantId: TENANT_ID,
        userId: 'u-1',
        role: 'manager',
      });
      expect(res).toMatchObject({
        clientId: 'c-1',
        channel: 'WhatsApp',
        occasion: 'confirmación de cita',
        tone: 'cercano',
        sent: false,
      });
      // M8: no approval, and the model is told to show it and that she sends it herself.
      expect(res).not.toHaveProperty('requiresApproval');
      expect(res).not.toHaveProperty('next');
      expect((res as any).instructions).toMatch(/copy it and send it herself/);
      expect((res as any).instructions).toMatch(/send_message/);
      expect(typeof (res as any).draft).toBe('string');
      expect((res as any).draft).toContain('Carmen');
      // Network must not be touched for a draft.
      expect((prisma.whatsAppConnection.findUnique as jest.Mock).mock.calls.length).toBe(0);
    });

    it('M8: names the next appointment and the salon, in Spanish, addressing her as «tú» in both tones', async () => {
      const prisma = makePrisma({
        clients: [{ id: 'c-1', tenantId: TENANT_ID, firstName: 'Carmen' }],
        appointments: [{ id: 'a-1', clientId: 'c-1', professionalId: 'p-1', status: 'confirmed', scheduledDate: new Date('2099-11-20T00:00:00.000Z'), scheduledTime: '16:00' }],
        tenant: { name: 'Salón Rosa', timezone: 'Europe/Madrid' },
      });
      const svc = new SalonCopilotToolsService(prisma);
      const ctx = { prisma, tenantId: TENANT_ID, userId: 'u-1', role: 'owner' as const };
      for (const tone of ['warm', 'formal']) {
        const res: any = await svc.execute('draft_follow_up_message', { clientId: 'c-1', occasion: 'reminder', tone }, ctx);
        expect(res.occasion).toBe('recordatorio de cita');
        expect(res.draft).toContain('Te recordamos tu cita en Salón Rosa del');
        expect(res.draft).toContain('a las 16:00');
        expect(res.draft).toContain('Salón Rosa');
        expect(res.draft).not.toMatch(/Estimad|Atentamente|usted|\bsu cita\b/i);
        expect(res.draft).not.toMatch(/confirmation|reminder|reactivation/);
      }
    });

    it('M8: an email draft carries a Spanish subject', async () => {
      const prisma = makePrisma({ clients: [{ id: 'c-1', tenantId: TENANT_ID, firstName: 'Carmen' }], tenant: { name: 'Salón Rosa' } });
      const svc = new SalonCopilotToolsService(prisma);
      const res: any = await svc.execute('draft_follow_up_message', { clientId: 'c-1', channel: 'email', occasion: 'reactivation' }, {
        prisma, tenantId: TENANT_ID, userId: 'u-1', role: 'manager',
      });
      expect(res.channel).toBe('email');
      expect(res.occasion).toBe('volver a verla');
      expect(res.subject).toBe('Te echamos de menos en Salón Rosa');
      expect(res.draft).toContain('Hace tiempo que no te vemos por Salón Rosa');
    });

    it('M8: a professional only drafts for a client she has attended', async () => {
      const prisma = makePrisma({
        clients: [
          { id: 'c-own', tenantId: TENANT_ID, firstName: 'Carmen' },
          { id: 'c-other', tenantId: TENANT_ID, firstName: 'Lola' },
        ],
        appointments: [
          { id: 'a-1', clientId: 'c-own', professionalId: 'p-maria', status: 'completed' },
          { id: 'a-2', clientId: 'c-other', professionalId: 'p-jorge', status: 'completed' },
        ],
        professionals: [{ id: 'p-maria', userId: 'u-maria' }],
      });
      const svc = new SalonCopilotToolsService(prisma);
      const ctx = { prisma, tenantId: TENANT_ID, userId: 'u-maria', role: 'staff' as const };
      expect((await svc.execute('draft_follow_up_message', { clientId: 'c-own' }, ctx) as any).draft).toContain('Carmen');
      expect(await svc.execute('draft_follow_up_message', { clientId: 'c-other' }, ctx)).toEqual({ error: 'client_not_found' });
    });

    it('M8: is not a write tool, so it has no approval card text of its own', async () => {
      const { COPILOT_WRITE_TOOLS } = await import('./salon-copilot-tools');
      expect(COPILOT_WRITE_TOOLS).not.toContain('draft_follow_up_message' as any);
      expect(COPILOT_WRITE_TOOLS).toContain('send_message');
    });

    it('returns client_not_found for unknown client', async () => {
      const prisma = makePrisma({ clients: [] });
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute('draft_follow_up_message', { clientId: 'nope' }, {
        prisma,
        tenantId: TENANT_ID,
        userId: 'u-1',
        role: 'manager',
      });
      expect(res).toEqual({ error: 'client_not_found' });
    });
  });

  describe('send_message', () => {
    it('refuses if WhatsApp is not connected', async () => {
      const prisma = makePrisma({
        clients: [{ id: 'c-1', tenantId: TENANT_ID, firstName: 'Carmen', phone: '+34000000000' }],
        whatsAppConnection: null,
      });
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute(
        'send_message',
        { clientId: 'c-1', templateName: 'appt_reminder' },
        { prisma, tenantId: TENANT_ID, userId: 'u-1', role: 'manager' },
      );
      expect((res as any).error).toBe('whatsapp_not_connected');
    });

    it('forbids staff writing to a non-own client', async () => {
      const prisma = makePrisma({
        clients: [{ id: 'c-1', tenantId: TENANT_ID, firstName: 'Carmen', phone: '+34000000000' }],
        appointments: [{ id: 'a-1', professionalId: 'other-prof', clientId: 'c-1' }],
        professionals: [{ id: 'staff-prof', userId: 'staff-u', firstName: 'M' }],
        whatsAppConnection: {
          tenantId: TENANT_ID,
          isActive: true,
          accessTokenEnc: 'plain:t0k3n',
          phoneNumberId: '999',
        },
      });
      // Patch decryptAes for the test by exposing the connection's
      // accessTokenEnc verbatim and skipping the network call.
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute(
        'send_message',
        { clientId: 'c-1', templateName: 'appt_reminder' },
        { prisma, tenantId: TENANT_ID, userId: 'staff-u', role: 'staff' },
      );
      expect((res as any).error).toBe('forbidden');
    });

    it('refuses if client has no phone', async () => {
      const prisma = makePrisma({
        clients: [{ id: 'c-1', tenantId: TENANT_ID, firstName: 'Carmen', phone: null }],
        whatsAppConnection: {
          tenantId: TENANT_ID,
          isActive: true,
          accessTokenEnc: 'plain:t0k3n',
          phoneNumberId: '999',
        },
      });
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute(
        'send_message',
        { clientId: 'c-1', templateName: 'appt_reminder' },
        { prisma, tenantId: TENANT_ID, userId: 'u-1', role: 'manager' },
      );
      expect((res as any).error).toBe('client_has_no_phone');
    });
  });

  describe('reschedule_appointment', () => {
    /**
     * The move itself is AppointmentsService.rescheduleVisit (the panel's
     * path, with its checks): here a stand-in that writes the row the way it
     * would. Its refusals are in appointments/copilot-reschedule.spec.ts.
     */
    const appointmentsFor = (appts: any[]) => ({
      rescheduleVisit: jest.fn(async (_user: any, id: string, day: string, time: string) => {
        const a = appts.find((x) => x.id === id);
        a.scheduledDate = new Date(`${day}T00:00:00.000Z`);
        a.scheduledTime = time;
        return { appointmentId: id };
      }),
    });

    it('moves a confirmed appointment to a new date/time', async () => {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const appts = [
        {
          id: 'a-1',
          tenantId: TENANT_ID,
          professionalId: 'p-1',
          clientId: 'c-1',
          scheduledDate: today,
          scheduledTime: '10:00',
          status: 'confirmed',
          client: { firstName: 'Carmen' },
        },
      ];
      const prisma = makePrisma({ appointments: appts, clients: [{ id: 'c-1' }] });
      const appointments = appointmentsFor(appts);
      const svc = new SalonCopilotToolsService(prisma, undefined, appointments as any);
      const res = await svc.execute(
        'reschedule_appointment',
        { appointmentId: 'a-1', newDate: today.toISOString().slice(0, 10), newTime: '11:30' },
        { prisma, tenantId: TENANT_ID, userId: 'u-1', role: 'manager' },
      );
      expect(appointments.rescheduleVisit).toHaveBeenCalledWith(
        { id: 'u-1', tenantId: TENANT_ID, role: 'manager' },
        'a-1',
        today.toISOString().slice(0, 10),
        '11:30',
      );
      // Never written by the tool itself, past the panel's checks.
      expect(prisma.appointment.update).not.toHaveBeenCalled();
      expect(res).toMatchObject({
        ok: true,
        appointmentId: 'a-1',
        to: { time: '11:30' },
        clientFirstName: 'Carmen',
      });
      expect(appts[0].scheduledTime).toBe('11:30');
    });

    it('rejects an invalid time format', async () => {
      const prisma = makePrisma({});
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute(
        'reschedule_appointment',
        { appointmentId: 'a-1', newDate: '2026-09-03', newTime: 'eleven' },
        { prisma, tenantId: TENANT_ID, userId: 'u-1', role: 'manager' },
      );
      expect(res).toEqual({ error: 'invalid_newTime' });
    });

    it('refuses when the appointment belongs to another tenant', async () => {
      const prisma = makePrisma({
        appointments: [{
          id: 'a-1', tenantId: 'other-tenant', professionalId: 'p-1', clientId: 'c-1',
          scheduledDate: new Date(), scheduledTime: '10:00', status: 'confirmed', client: { firstName: 'C' },
        }],
      });
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute(
        'reschedule_appointment',
        { appointmentId: 'a-1', newDate: '2026-09-03', newTime: '11:30' },
        { prisma, tenantId: TENANT_ID, userId: 'u-1', role: 'manager' },
      );
      expect((res as any).error).toBe('forbidden');
    });

    it('staff can only reschedule their own appointments', async () => {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const appts = [{
        id: 'a-1', tenantId: TENANT_ID, professionalId: 'staff-prof', clientId: 'c-1',
        scheduledDate: today, scheduledTime: '10:00', status: 'confirmed', client: { firstName: 'C' },
      }];
      const prisma = makePrisma({
        appointments: appts,
        professionals: [{ id: 'staff-prof', userId: 'staff-u', firstName: 'M' }],
      });
      const svc = new SalonCopilotToolsService(prisma, undefined, appointmentsFor(appts) as any);
      const res = await svc.execute(
        'reschedule_appointment',
        { appointmentId: 'a-1', newDate: today.toISOString().slice(0, 10), newTime: '11:30' },
        { prisma, tenantId: TENANT_ID, userId: 'staff-u', role: 'staff' },
      );
      expect((res as any).ok).toBe(true);
    });

    it('staff cannot reschedule another stylist\'s appointment', async () => {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const appts = [{
        id: 'a-1', tenantId: TENANT_ID, professionalId: 'other-prof', clientId: 'c-1',
        scheduledDate: today, scheduledTime: '10:00', status: 'confirmed', client: { firstName: 'C' },
      }];
      const prisma = makePrisma({
        appointments: appts,
        professionals: [{ id: 'staff-prof', userId: 'staff-u', firstName: 'M' }],
      });
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute(
        'reschedule_appointment',
        { appointmentId: 'a-1', newDate: today.toISOString().slice(0, 10), newTime: '11:30' },
        { prisma, tenantId: TENANT_ID, userId: 'staff-u', role: 'staff' },
      );
      expect((res as any).error).toBe('forbidden');
    });
  });
});
