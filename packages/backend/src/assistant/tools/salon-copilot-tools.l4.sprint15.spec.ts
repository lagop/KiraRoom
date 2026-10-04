import { SalonCopilotToolsService } from './salon-copilot-tools';

/**
 * L-4 contract tests for sprint 15 write tools:
 *   - mark_no_show
 *   - create_coupon
 *   - close_waitlist_slot
 * Permissions / role gating are covered in the tools' own paths
 * (each returns `{ error: 'forbidden' }`).
 */

const TENANT_ID = 't-1';

function makePrisma(opts: {
  appointments?: any[];
  promotions?: any[];
  waitList?: any[];
}): any {
  const appts = opts.appointments ?? [];
  const proms = opts.promotions ?? [];
  const wls = opts.waitList ?? [];

  return {
    appointment: {
      findUnique: jest.fn().mockImplementation(async ({ where }: any) => appts.find((a: any) => a.id === where?.id) ?? null),
      update: jest.fn().mockImplementation(async ({ where, data }: any) => {
        const idx = appts.findIndex((a: any) => a.id === where.id);
        if (idx < 0) throw new Error('not_found');
        appts[idx] = { ...appts[idx], ...data };
        return appts[idx];
      }),
    },
    promotion: {
      create: jest.fn().mockImplementation(async ({ data }: any) => {
        const row = { id: `promo-${proms.length + 1}`, ...data };
        proms.push(row);
        return row;
      }),
      findFirst: jest.fn().mockImplementation(async ({ where }: any) => {
        return proms.find((p: any) => p.tenantId === where.tenantId && p.code === where.code) ?? null;
      }),
    },
    waitList: {
      findMany: jest.fn().mockImplementation(async ({ where, take }: any) => {
        const matched = wls.filter((w: any) => {
          if (w.tenantId !== where.tenantId) return false;
          if (w.serviceId !== where.serviceId) return false;
          if (w.status !== where.status) return false;
          return true;
        });
        return typeof take === 'number' ? matched.slice(0, take) : matched;
      }),
      updateMany: jest.fn().mockImplementation(async ({ where, data }: any) => {
        const ids = where?.id?.in ?? [];
        let n = 0;
        for (const w of wls) {
          if (ids.includes(w.id)) {
            Object.assign(w, data);
            n += 1;
          }
        }
        return { count: n };
      }),
    },
  };
}

const STAFF_USER_ID = 'staff-1';
const ctxFor = (role: string) => ({
  prisma: undefined as any, // each test injects its own
  tenantId: TENANT_ID,
  userId: STAFF_USER_ID,
  role: role as any,
});

describe('SalonCopilotToolsService (L-4) — sprint 15 write tools', () => {
  describe('mark_no_show', () => {
    it('staff role is forbidden', async () => {
      const prisma = makePrisma({});
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute('mark_no_show', { appointmentId: 'a-1' }, {
        ...ctxFor('staff'), prisma,
      });
      expect((res as any).error).toBe('forbidden');
    });

    it('manager marks a confirmed appointment as no_show with no fee', async () => {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const appts = [{
        id: 'a-1', tenantId: TENANT_ID, status: 'confirmed', client: { firstName: 'Carmen' },
      }];
      const prisma = makePrisma({ appointments: appts });
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute('mark_no_show', { appointmentId: 'a-1' }, {
        ...ctxFor('manager'), prisma,
      });
      expect(res).toMatchObject({
        ok: true,
        appointmentId: 'a-1',
        status: 'no_show',
        feeApplied: false,
        feeAmount: 0,
        clientFirstName: 'Carmen',
      });
      expect(appts[0].status).toBe('no_show');
    });

    it('rejects when fee is requested but no amount is provided', async () => {
      const appts = [{ id: 'a-1', tenantId: TENANT_ID, status: 'confirmed', client: { firstName: 'C' } }];
      const prisma = makePrisma({ appointments: appts });
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute('mark_no_show', { appointmentId: 'a-1', applyFee: true }, {
        ...ctxFor('manager'), prisma,
      });
      expect((res as any).error).toBe('invalid_feeAmount');
    });

    it('refuses to mutate an already-cancelled appointment', async () => {
      const appts = [{ id: 'a-1', tenantId: TENANT_ID, status: 'cancelled', client: { firstName: 'C' } }];
      const prisma = makePrisma({ appointments: appts });
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute('mark_no_show', { appointmentId: 'a-1' }, {
        ...ctxFor('manager'), prisma,
      });
      expect((res as any).error).toBe('invalid_status');
    });
  });

  describe('create_coupon', () => {
    it('receptionist is forbidden (only owner can mint coupons)', async () => {
      const prisma = makePrisma({ promotions: [] });
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute('create_coupon', { discountPercent: 10 }, {
        ...ctxFor('receptionist'), prisma,
      });
      expect((res as any).error).toBe('forbidden');
    });

    it('staff is forbidden', async () => {
      const prisma = makePrisma({});
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute('create_coupon', { discountPercent: 10 }, {
        ...ctxFor('staff'), prisma,
      });
      expect((res as any).error).toBe('forbidden');
    });

    it('owner creates a 25% single-use coupon', async () => {
      const prisma = makePrisma({ promotions: [] });
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute(
        'create_coupon',
        { discountPercent: 25, expiresInDays: 14 },
        { ...ctxFor('owner'), prisma },
      );
      expect(res).toMatchObject({
        ok: true,
        discountPercent: 25,
        clientId: null,
      });
      expect(typeof (res as any).code).toBe('string');
      expect((res as any).code).toMatch(/^[A-Z2-9]{6}$/);
      expect((res as any).expiresAt).toBeTruthy();
    });

    it('rejects invalid discount percent', async () => {
      const prisma = makePrisma({});
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute('create_coupon', { discountPercent: 0 }, {
        ...ctxFor('owner'), prisma,
      });
      expect((res as any).error).toBe('invalid_discountPercent');
    });
  });

  describe('close_waitlist_slot', () => {
    it('staff is forbidden', async () => {
      const prisma = makePrisma({});
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute(
        'close_waitlist_slot',
        { serviceId: 's-1', windowStart: '2026-09-04', windowEnd: '2026-09-05' },
        { ...ctxFor('staff'), prisma },
      );
      expect((res as any).error).toBe('forbidden');
    });

    /*
     * The tool used to flip the entries to 'notified' and send nothing.
     * It now sends through WaitListService.notify (the panel's "Avisar"),
     * which marks an entry notified only when a channel delivered; the
     * tool itself never writes the status.
     */
    const waitingThree = () => [
      { id: 'w-1', tenantId: TENANT_ID, serviceId: 's-1', status: 'waiting', client: { id: 'c-1', firstName: 'Carmen', phone: '+34000000001' } },
      { id: 'w-2', tenantId: TENANT_ID, serviceId: 's-1', status: 'waiting', client: { id: 'c-2', firstName: 'Lucía', phone: null } },
      { id: 'w-3', tenantId: TENANT_ID, serviceId: 's-1', status: 'waiting', client: { id: 'c-3', firstName: 'Pablo', phone: '+34000000003' } },
    ];
    const sent = (summary: string) => ({
      notified: true,
      channels: [{ channel: 'email', status: 'sent' }],
      bookingUrl: 'http://localhost:3000/sites/salon',
      summary,
    });
    const notSent = (summary: string) => ({
      notified: false,
      channels: [{ channel: 'email', status: 'skipped', reason: 'no hay proveedor de email configurado' }],
      bookingUrl: 'http://localhost:3000/sites/salon',
      summary,
    });

    it('sends the notice to the top-N through WaitListService and reports per client', async () => {
      const wls = waitingThree();
      const prisma = makePrisma({ waitList: wls });
      const waitList = {
        notify: jest
          .fn()
          .mockResolvedValueOnce(sent('Avisado por email'))
          .mockResolvedValueOnce(notSent('No se ha podido avisar: email, no hay proveedor de email configurado')),
      };
      const svc = new SalonCopilotToolsService(prisma, waitList as any);
      const res: any = await svc.execute(
        'close_waitlist_slot',
        { serviceId: 's-1', windowStart: '2026-09-04', windowEnd: '2026-09-04', time: '10:30', topN: 2 },
        { ...ctxFor('receptionist'), prisma },
      );

      expect(waitList.notify).toHaveBeenCalledTimes(2);
      expect(waitList.notify).toHaveBeenCalledWith(
        TENANT_ID,
        'w-1',
        { date: '2026-09-04', time: '10:30', professionalId: undefined },
        STAFF_USER_ID,
      );
      expect(res).toMatchObject({ ok: true, notified: 1, notNotified: 1 });
      expect(res.clients.map((c: any) => [c.firstName, c.notified])).toEqual([
        ['Carmen', true],
        ['Lucía', false],
      ]);
      expect(res.message).toContain('Avisados 1 de 2');
      expect(res.message).toContain('Lucía: No se ha podido avisar');
      // The tool no longer writes the status itself.
      expect(prisma.waitList.updateMany).not.toHaveBeenCalled();
      expect(wls.every((w) => w.status === 'waiting')).toBe(true);
    });

    it('answers with an error when nobody could be notified, and why', async () => {
      const prisma = makePrisma({ waitList: waitingThree() });
      const waitList = {
        notify: jest.fn().mockResolvedValue(notSent('No se ha podido avisar: email, no hay proveedor de email configurado')),
      };
      const svc = new SalonCopilotToolsService(prisma, waitList as any);
      const res: any = await svc.execute(
        'close_waitlist_slot',
        { serviceId: 's-1', windowStart: '2026-09-04', windowEnd: '2026-09-06' },
        { ...ctxFor('manager'), prisma },
      );
      expect(res.error).toBe('not_delivered');
      expect(res.notified).toBe(0);
      expect(res.message).toContain('No se ha podido avisar a ninguno de los 3 clientes');
      // A range: no date in the notice.
      expect(waitList.notify.mock.calls[0][2]).toEqual({ date: undefined, time: undefined, professionalId: undefined });
    });

    it('reports a client the notice could not reach because notify threw', async () => {
      const prisma = makePrisma({ waitList: waitingThree().slice(0, 1) });
      const waitList = {
        notify: jest.fn().mockRejectedValue(new Error('La lista de espera no está incluida en tu plan.')),
      };
      const svc = new SalonCopilotToolsService(prisma, waitList as any);
      const res: any = await svc.execute(
        'close_waitlist_slot',
        { serviceId: 's-1', windowStart: '2026-09-04', windowEnd: '2026-09-04' },
        { ...ctxFor('owner'), prisma },
      );
      expect(res.error).toBe('not_delivered');
      expect(res.clients[0]).toMatchObject({ firstName: 'Carmen', notified: false });
      expect(res.clients[0].summary).toContain('no está incluida en tu plan');
    });

    it('says so when nobody is waiting', async () => {
      const prisma = makePrisma({ waitList: [] });
      const waitList = { notify: jest.fn() };
      const svc = new SalonCopilotToolsService(prisma, waitList as any);
      const res: any = await svc.execute(
        'close_waitlist_slot',
        { serviceId: 's-1', windowStart: '2026-09-04', windowEnd: '2026-09-04' },
        { ...ctxFor('receptionist'), prisma },
      );
      expect(res).toMatchObject({ ok: true, notified: 0 });
      expect(res.message).toContain('No se ha avisado a nadie');
      expect(waitList.notify).not.toHaveBeenCalled();
    });

    it('rejects an invalid time', async () => {
      const prisma = makePrisma({});
      const svc = new SalonCopilotToolsService(prisma, { notify: jest.fn() } as any);
      const res = await svc.execute(
        'close_waitlist_slot',
        { serviceId: 's-1', windowStart: '2026-09-04', windowEnd: '2026-09-04', time: '25:00' },
        { ...ctxFor('receptionist'), prisma },
      );
      expect((res as any).error).toBe('invalid_time');
    });

    it('rejects invalid date formats', async () => {
      const prisma = makePrisma({});
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute(
        'close_waitlist_slot',
        { serviceId: 's-1', windowStart: '04/09/2026', windowEnd: '2026-09-05' },
        { ...ctxFor('receptionist'), prisma },
      );
      expect((res as any).error).toBe('invalid_windowStart');
    });
  });
});
