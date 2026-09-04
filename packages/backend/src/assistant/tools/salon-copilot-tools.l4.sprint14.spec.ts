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
}): any {
  const appts = opts.appointments ?? [];
  const cls = opts.clients ?? [];
  const pros = opts.professionals ?? [];
  const conn = opts.whatsAppConnection ?? null;

  return {
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
        return cls.find((c: any) => {
          if (c.id !== where?.id) return false;
          if (where?.tenantId && c.tenantId !== where.tenantId) return false;
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
        channel: 'whatsapp',
        occasion: 'confirmation',
        tone: 'warm',
        requiresApproval: true,
        next: 'send_message',
      });
      expect(typeof (res as any).draft).toBe('string');
      expect((res as any).draft).toContain('Carmen');
      // Network must not be touched for a draft.
      expect((prisma.whatsAppConnection.findUnique as jest.Mock).mock.calls.length).toBe(0);
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
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute(
        'reschedule_appointment',
        { appointmentId: 'a-1', newDate: today.toISOString().slice(0, 10), newTime: '11:30' },
        { prisma, tenantId: TENANT_ID, userId: 'u-1', role: 'manager' },
      );
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
      const svc = new SalonCopilotToolsService(prisma);
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
