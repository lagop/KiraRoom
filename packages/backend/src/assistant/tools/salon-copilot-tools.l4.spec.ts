import { SalonCopilotToolsService } from './salon-copilot-tools';

/**
 * L-4 contract tests for the staff-side copilot tools.
 * Read-only tools, role-based redaction, deterministic Prisma mock.
 *
 * The mock attaches the related `client` and `professional` records
 * to each appointment so the production code can access
 * `a.professional?.userId` and `a.client.firstName` without further
 * Prisma round-trips.
 */

const TENANT_ID = 't-1';
const STAFF_USER_ID = 'staff-1';
const STAFF_USER = { id: STAFF_USER_ID, role: 'staff' as const };
const OWNER_USER = { id: 'owner-1', role: 'owner' as const };

const today = new Date();
today.setHours(0, 0, 0, 0);
const yesterday = new Date(today);
yesterday.setDate(today.getDate() - 1);
const lastMonth = new Date(today);
lastMonth.setMonth(today.getMonth() - 1);
lastMonth.setDate(today.getDate());

const SAMPLE_CLIENTS = [
  { id: 'c-1', firstName: 'Carmen', lastName: 'Ruiz', tenantId: TENANT_ID, status: 'active' as const },
  { id: 'c-2', firstName: 'Lucía', lastName: 'García', tenantId: TENANT_ID, status: 'active' as const },
  { id: 'c-3', firstName: 'Pablo', lastName: 'Vega', tenantId: TENANT_ID, status: 'active' as const },
  { id: 'c-mar', firstName: 'Mar', lastName: 'Marín', tenantId: TENANT_ID, status: 'active' as const },
  { id: 'c-ana', firstName: 'Ana', lastName: 'Anaya', tenantId: TENANT_ID, status: 'active' as const },
];

const SAMPLE_PROFESSIONALS = [
  { id: 'staff-1', userId: STAFF_USER_ID, firstName: 'María', lastName: 'García' },
  { id: 'staff-2', userId: 'staff-2', firstName: 'Jorge', lastName: 'Pérez' },
];

const SAMPLE_APPOINTMENTS = [
  { id: 'a-1', tenantId: TENANT_ID, professionalId: 'staff-1', clientId: 'c-1', scheduledDate: today, scheduledTime: '09:00', status: 'confirmed', services: [{ service: { name: 'Corte' } }] },
  { id: 'a-2', tenantId: TENANT_ID, professionalId: 'staff-1', clientId: 'c-2', scheduledDate: today, scheduledTime: '11:00', status: 'pending', services: [{ service: { name: 'Coloración' } }] },
  { id: 'a-3', tenantId: TENANT_ID, professionalId: 'staff-2', clientId: 'c-1', scheduledDate: today, scheduledTime: '13:00', status: 'confirmed', services: [{ service: { name: 'Masaje' } }] },
  { id: 'a-4', tenantId: TENANT_ID, professionalId: 'staff-2', clientId: 'c-1', scheduledDate: yesterday, scheduledTime: '11:00', status: 'completed', totalAmount: 50, services: [{ service: { name: 'Tratamiento Capilar' } }] },
  { id: 'a-5', tenantId: TENANT_ID, professionalId: 'staff-2', clientId: 'c-2', scheduledDate: lastMonth, scheduledTime: '17:00', status: 'completed', totalAmount: 80, services: [{ service: { name: 'Coloración' } }] },
];

const SAMPLE_CLIENT = {
  id: 'c-1',
  firstName: 'Carmen',
  lastName: 'Ruiz',
  email: 'carmen@example.com',
  phone: '+34600000001',
  dateOfBirth: new Date('1990-04-15T00:00:00Z'),
  gender: 'female',
  allergies: ['PPD', 'lanolina'],
  totalSpent: 0,
  visitCount: 0,
};

// Hand-rolled Prisma mock.
function makePrisma(opts: {
  appointments?: any[];
  clients?: any[];
  professionals?: any[];
  products?: any[];
  waitList?: any[];
}): any {
  const appts = opts.appointments ?? [];
  const cls = opts.clients ?? [];
  const pros = opts.professionals ?? [];
  const prods = opts.products ?? [];
  const wls = opts.waitList ?? [];

  function withRelations(a: any): any {
    return {
      ...a,
      client: cls.find((c: any) => c.id === a.clientId) ?? null,
      professional: pros.find((p: any) => p.id === a.professionalId) ?? null,
    };
  }

  return {
    appointment: {
      findMany: jest.fn().mockImplementation(async ({ where }: any) => {
        const list = appts
          .filter((a: any) => {
            if (where?.tenantId && a.tenantId !== where.tenantId) return false;
            if (where?.clientId && a.clientId !== where.clientId) return false;
            if (where?.professionalId && a.professionalId !== where.professionalId) {
              return false;
            }
            if (where?.scheduledDate?.gte && a.scheduledDate < where.scheduledDate.gte) {
              return false;
            }
            if (where?.scheduledDate?.lt && a.scheduledDate >= where.scheduledDate.lt) {
              return false;
            }
            if (where?.status) {
              if (where.status.in) {
                if (!where.status.in.includes(a.status)) return false;
              } else if (a.status !== where.status) {
                return false;
              }
            }
            return true;
          })
          .map(withRelations);
        return list;
      }),
      findFirst: jest.fn().mockImplementation(async ({ where }: any) => {
        return (
          appts.find((a: any) => {
            if (where?.clientId && a.clientId !== where.clientId) return false;
            if (where?.professionalId && a.professionalId !== where.professionalId) {
              return false;
            }
            return true;
          }) ?? null
        );
      }),
      aggregate: jest.fn().mockImplementation(async ({ where }: any) => {
        const matched = appts.filter((a: any) => {
          if (where?.clientId && a.clientId !== where.clientId) return false;
          if (where?.status) {
            if (where.status.in) {
              if (!where.status.in.includes(a.status)) return false;
            } else if (a.status !== where.status) {
              return false;
            }
          }
          if (where?.scheduledDate?.gte && a.scheduledDate < where.scheduledDate.gte) {
            return false;
          }
          return true;
        });
        return {
          _sum: { totalAmount: matched.reduce((s: number, a: any) => s + (a.totalAmount ?? 0), 0) },
          _count: { _all: matched.length },
        };
      }),
    },
    client: {
      findUnique: jest.fn().mockImplementation(async ({ where }: any) => {
        return cls.find((c: any) => c.id === where?.id) ?? null;
      }),
      findMany: jest.fn().mockImplementation(async ({ where, orderBy, take }: any) => {
        let list = cls.filter((c: any) => {
          if (where?.tenantId && c.tenantId !== where.tenantId) return false;
          if (where?.status) {
            if (where.status.in) {
              if (!where.status.in.includes(c.status)) return false;
            } else if (c.status !== where.status) {
              return false;
            }
          }
          if (where?.lastVisit?.not === null && c.lastVisit == null) return false;
          return true;
        });
        if (orderBy?.totalSpent) {
          list = list.slice().sort((a: any, b: any) => Number(b.totalSpent ?? 0) - Number(a.totalSpent ?? 0));
        }
        if (orderBy?.visitCount) {
          list = list.slice().sort((a: any, b: any) => (b.visitCount ?? 0) - (a.visitCount ?? 0));
        }
        if (orderBy?.lastVisit) {
          const dir = orderBy.lastVisit === 'asc' ? 1 : -1;
          list = list.slice().sort(
            (a: any, b: any) =>
              dir *
              (new Date(a.lastVisit ?? 0).getTime() -
                new Date(b.lastVisit ?? 0).getTime()),
          );
        }
        if (typeof take === 'number') {
          list = list.slice(0, take);
        }
        return list;
      }),
    },
    professional: {
      findFirst: jest.fn().mockImplementation(async ({ where }: any) => {
        return (
          pros.find((p: any) => {
            if (where?.user?.id && p.userId !== where.user.id) return false;
            return true;
          }) ?? null
        );
      }),
    },
    product: {
      findMany: jest.fn().mockImplementation(async ({ where, orderBy, take }: any) => {
        let list = prods.filter((p: any) => {
          if (where?.tenantId && p.tenantId !== where.tenantId) return false;
          if (where?.isActive !== undefined && p.isActive !== where.isActive) return false;
          if (where?.trackInventory !== undefined && p.trackInventory !== where.trackInventory) {
            return false;
          }
          return true;
        });
        if (orderBy?.quantity) {
          const dir = orderBy.quantity === 'asc' ? 1 : -1;
          list = list.slice().sort((a: any, b: any) => dir * ((a.quantity ?? 0) - (b.quantity ?? 0)));
        }
        if (typeof take === 'number') {
          list = list.slice(0, take);
        }
        return list;
      }),
    },
    waitList: {
      findMany: jest.fn().mockImplementation(async (args: any) => {
        const w: any = args?.where;
        const ob: any = args?.orderBy;
        const take: number | undefined = args?.take;
        let list = wls.filter((x: any) => {
          if (w?.tenantId && x.tenantId !== w.tenantId) return false;
          if (w?.status && x.status !== w.status) return false;
          if (w?.OR) {
            const m = w.OR.some((c: any) => {
              if (c.earliestDate === null && x.earliestDate === null) return true;
              if (c.earliestDate === null) return false;
              if (x.earliestDate === null) return false;
              return x.earliestDate <= c.earliestDate;
            });
            if (!m) return false;
          }
          if (w?.AND) {
            const m = w.AND.every((c: any) => {
              if (c.OR) {
                return c.OR.some((cc: any) => {
                  if (cc.latestDate === null && x.latestDate === null) return true;
                  if (cc.latestDate === null) return false;
                  if (x.latestDate === null) return false;
                  return x.latestDate >= cc.latestDate;
                });
              }
              return true;
            });
            if (!m) return false;
          }
          return true;
        });
        list = list.map((x: any) => ({
          ...x,
          client: cls.find((c: any) => c.id === x.clientId) ?? null,
        }));
        if (ob?.client?.lastVisit) {
          const dir = ob.client.lastVisit === 'asc' ? 1 : -1;
          list = list.slice().sort(
            (a: any, b: any) =>
              dir *
              (new Date(a.client?.lastVisit ?? 0).getTime() -
                new Date(b.client?.lastVisit ?? 0).getTime()),
          );
        }
        if (typeof take === 'number') {
          list = list.slice(0, take);
        }
        return list;
      }),
    },
  };
}

describe('SalonCopilotToolsService (L-4)', () => {
  describe('get_my_agenda', () => {
    it("returns today's appointments + gaps for the calling stylist", async () => {
      const prisma = makePrisma({
        appointments: SAMPLE_APPOINTMENTS,
        professionals: SAMPLE_PROFESSIONALS,
        clients: SAMPLE_CLIENTS,
      });
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute('get_my_agenda', {}, {
        prisma,
        tenantId: TENANT_ID,
        userId: STAFF_USER_ID,
        role: 'staff',
      });
      // staff-1 has 2 today (a-1 09:00 confirmed, a-2 11:00 pending)
      expect(res.appointments).toHaveLength(2);
      expect(res.confirmed).toBe(1);
      expect(res.pending).toBe(1);
      // Gap between a-1 (ends 9:30) and a-2 (starts 11:00) = 1.5h = 90 min
      const gaps = res.gaps as Array<{ minutes: number }>;
      expect(gaps).toHaveLength(1);
      expect(gaps[0].minutes).toBe(90);
    });

    it('staff cannot see another professional\'s agenda', async () => {
      const prisma = makePrisma({
        appointments: SAMPLE_APPOINTMENTS,
        professionals: SAMPLE_PROFESSIONALS,
        clients: SAMPLE_CLIENTS,
      });
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute(
        'get_my_agenda',
        { professionalId: 'staff-2' },
        { prisma, tenantId: TENANT_ID, userId: STAFF_USER_ID, role: 'staff' },
      );
      expect(res).toEqual({
        error: 'forbidden',
        message: 'No puedes ver la agenda de otro profesional.',
      });
    });

    it('manager can read any professional\'s agenda by id', async () => {
      const prisma = makePrisma({
        appointments: SAMPLE_APPOINTMENTS,
        professionals: SAMPLE_PROFESSIONALS,
        clients: SAMPLE_CLIENTS,
      });
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute(
        'get_my_agenda',
        { professionalId: 'staff-2' },
        { prisma, tenantId: TENANT_ID, userId: 'mgr-1', role: 'manager' },
      );
      // staff-2 has 1 today (a-3 13:00)
      expect(res.appointments).toHaveLength(1);
      expect(res.appointments[0].client.firstName).toBe('Carmen');
    });

    it('returns empty agenda when nothing scheduled', async () => {
      const prisma = makePrisma({
        appointments: [],
        professionals: SAMPLE_PROFESSIONALS,
        clients: SAMPLE_CLIENTS,
      });
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute('get_my_agenda', {}, {
        prisma,
        tenantId: TENANT_ID,
        userId: STAFF_USER_ID,
        role: 'staff',
      });
      expect(res.totalAppointments).toBe(0);
      expect(res.gaps).toEqual([]);
    });
  });

  describe('get_salon_agenda', () => {
    it('refuses if the caller is not owner/admin/manager', async () => {
      const prisma = makePrisma({
        appointments: SAMPLE_APPOINTMENTS,
        professionals: SAMPLE_PROFESSIONALS,
        clients: SAMPLE_CLIENTS,
      });
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute(
        'get_salon_agenda',
        { professionalId: 'staff-1' },
        { prisma, tenantId: TENANT_ID, userId: STAFF_USER_ID, role: 'staff' },
      );
      expect(res).toEqual({
        error: 'forbidden',
        message: 'Esta vista solo está disponible para owner / admin / manager.',
      });
    });

    it('returns 400 if no professionalId', async () => {
      const prisma = makePrisma({
        appointments: SAMPLE_APPOINTMENTS,
        professionals: SAMPLE_PROFESSIONALS,
        clients: SAMPLE_CLIENTS,
      });
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute(
        'get_salon_agenda',
        {},
        { prisma, tenantId: TENANT_ID, userId: OWNER_USER.id, role: 'owner' },
      );
      expect(res).toEqual({ error: 'missing_professionalId' });
    });

    it('returns the agenda for the requested professional', async () => {
      const prisma = makePrisma({
        appointments: SAMPLE_APPOINTMENTS,
        professionals: SAMPLE_PROFESSIONALS,
        clients: SAMPLE_CLIENTS,
      });
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute(
        'get_salon_agenda',
        { professionalId: 'staff-2' },
        { prisma, tenantId: TENANT_ID, userId: OWNER_USER.id, role: 'owner' },
      );
      expect(res.appointments).toHaveLength(1);
      expect(res.appointments[0].client.firstName).toBe('Carmen');
    });
  });

  describe('get_client_360', () => {
    it('returns full client history to owner/manager', async () => {
      const prisma = makePrisma({
        appointments: SAMPLE_APPOINTMENTS,
        clients: [SAMPLE_CLIENT],
      });
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute('get_client_360', { clientId: 'c-1' }, {
        prisma,
        tenantId: TENANT_ID,
        userId: OWNER_USER.id,
        role: 'owner',
      });
      expect(res.id).toBe('c-1');
      expect(res.name).toBe('Carmen Ruiz');
      // c-1 has 3 visits: a-1 (today, confirmed), a-3 (today, confirmed),
      // a-4 (yesterday, completed). a-2 is c-2 and a-5 is c-2 — excluded.
      expect(res.visits).toHaveLength(3);
      // Stats only count completed: only a-4. So 1.
      expect((res.stats as any).totalVisitsLast365d).toBe(1);
      expect(res.visits[0]).toHaveProperty('totalAmount');
    });

    it('staff sees only their own visits', async () => {
      const prisma = makePrisma({
        appointments: SAMPLE_APPOINTMENTS,
        clients: [SAMPLE_CLIENT],
        professionals: SAMPLE_PROFESSIONALS,
      });
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute('get_client_360', { clientId: 'c-1' }, {
        prisma,
        tenantId: TENANT_ID,
        userId: STAFF_USER_ID,
        role: 'staff',
      });
      // staff-1 owns only a-1 (a-3, a-4 are staff-2). 1 visit.
      expect(res.visits).toHaveLength(1);
      expect(res.visits[0].id).toBe('a-1');
    });

    it('staff does NOT see totalAmount on visits', async () => {
      const prisma = makePrisma({
        appointments: SAMPLE_APPOINTMENTS,
        clients: [SAMPLE_CLIENT],
        professionals: SAMPLE_PROFESSIONALS,
      });
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute('get_client_360', { clientId: 'c-1' }, {
        prisma,
        tenantId: TENANT_ID,
        userId: STAFF_USER_ID,
        role: 'staff',
      });
      expect(res.visits[0]).not.toHaveProperty('totalAmount');
      expect(res.stats).toEqual({});
    });

    it('returns 404 if the client does not exist', async () => {
      const prisma = makePrisma({
        appointments: SAMPLE_APPOINTMENTS,
        clients: [SAMPLE_CLIENT],
      });
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute('get_client_360', { clientId: 'c-404' }, {
        prisma,
        tenantId: TENANT_ID,
        userId: OWNER_USER.id,
        role: 'owner',
      });
      expect(res).toEqual({ error: 'client_not_found' });
    });
  });

  describe('executor dispatch', () => {
    it('returns an error envelope for unknown tools', async () => {
      const svc = new SalonCopilotToolsService({} as any);
      const res = await svc.execute('not_a_tool', {}, {
        prisma: {} as any,
        tenantId: TENANT_ID,
        userId: STAFF_USER_ID,
        role: 'staff',
      });
      expect(res).toEqual({ error: 'unknown_tool:not_a_tool' });
    });
  });

  describe('find_filling_opportunities', () => {
    const THREE_MONTHS_AGO = new Date(today);
    THREE_MONTHS_AGO.setMonth(today.getMonth() - 3);
    THREE_MONTHS_AGO.setDate(today.getDate());
    const YESTERDAY = new Date(today);
    YESTERDAY.setDate(today.getDate() - 1);
    const WL_ENTRIES = [
      { id: 'w-1', tenantId: TENANT_ID, clientId: 'c-mar', status: 'waiting', earliestDate: null, latestDate: null, client: { id: 'c-mar', firstName: 'Mar', lastVisit: THREE_MONTHS_AGO, totalSpent: 200 } },
      { id: 'w-2', tenantId: TENANT_ID, clientId: 'c-ana', status: 'waiting', earliestDate: null, latestDate: null, client: { id: 'c-ana', firstName: 'Ana', lastVisit: YESTERDAY, totalSpent: 50 } },
    ];

    it('returns gaps ≥ 30 min between staff-1\'s today appointments', async () => {
      const prisma = makePrisma({
        appointments: SAMPLE_APPOINTMENTS,
        waitList: WL_ENTRIES,
        clients: SAMPLE_CLIENTS,
      });
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute('find_filling_opportunities', {}, {
        prisma,
        tenantId: TENANT_ID,
        userId: STAFF_USER_ID,
        role: 'staff',
      });
      // staff-1 has 2 today → 1 gap of 90 min between a-1 (ends 9:30) and
      // a-2 (starts 11:00).
      expect(res.gaps).toHaveLength(1);
    });

    it('attaches wait-list candidates for owner/manager, oldest first', async () => {
      const prisma = makePrisma({
        appointments: SAMPLE_APPOINTMENTS,
        waitList: WL_ENTRIES,
        clients: SAMPLE_CLIENTS,
      });
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute('find_filling_opportunities', {}, {
        prisma,
        tenantId: TENANT_ID,
        userId: OWNER_USER.id,
        role: 'owner',
      });
      const firstGap = (res.gaps as Array<{ suggestions: Array<{ firstName: string }> }>)[0];
      expect(firstGap.suggestions).toHaveLength(2);
      expect(firstGap.suggestions[0].firstName).toBe('Mar');
      expect(firstGap.suggestions[1].firstName).toBe('Ana');
    });

    it('omits client names for receptionist and staff (privacy)', async () => {
      const prisma = makePrisma({
        appointments: SAMPLE_APPOINTMENTS,
        waitList: WL_ENTRIES,
        clients: SAMPLE_CLIENTS,
      });
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute('find_filling_opportunities', {}, {
        prisma,
        tenantId: TENANT_ID,
        userId: 'r-1',
        role: 'receptionist',
      });
      for (const g of res.gaps as Array<{ suggestions: unknown[] }>) {
        expect(g.suggestions).toEqual([]);
      }
    });

    it('filters agenda by professional for staff role', async () => {
      const prisma = makePrisma({
        appointments: SAMPLE_APPOINTMENTS,
        clients: SAMPLE_CLIENTS,
      });
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute('find_filling_opportunities', {}, {
        prisma,
        tenantId: TENANT_ID,
        userId: STAFF_USER_ID,
        role: 'staff',
      });
      // staff-1 sees 2 today → 1 gap. staff-2's appointments
      // (a-3 today, a-4 yesterday, a-5 last month) are filtered
      // out by the where.professionalId clause.
      expect(res.gaps).toHaveLength(1);
    });
  });

  describe('get_low_stock', () => {
    const PRODUCTS = [
      { id: 'p-1', tenantId: TENANT_ID, name: 'Tinte 7.3', sku: 'T73', quantity: 0, lowStockAlert: 5, price: 12, category: 'color', isActive: true, trackInventory: true },
      { id: 'p-2', tenantId: TENANT_ID, name: 'Shampoo A', sku: 'SA', quantity: 3, lowStockAlert: 5, price: 9, category: 'wash', isActive: true, trackInventory: true },
      { id: 'p-3', tenantId: TENANT_ID, name: 'Mascarilla B', sku: 'MB', quantity: 10, lowStockAlert: 5, price: 15, category: 'treat', isActive: true, trackInventory: true },
      { id: 'p-4', tenantId: TENANT_ID, name: 'Aceite sin track', quantity: 0, lowStockAlert: 5, price: 7, category: 'misc', isActive: true, trackInventory: false },
      { id: 'p-5', tenantId: TENANT_ID, name: 'Producto desactivado', quantity: 0, lowStockAlert: 5, price: 5, category: 'misc', isActive: false, trackInventory: true },
    ];

    it('returns only products with quantity ≤ alert, tracked and active', async () => {
      const prisma = makePrisma({ products: PRODUCTS });
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute('get_low_stock', {}, {
        prisma,
        tenantId: TENANT_ID,
        userId: OWNER_USER.id,
        role: 'owner',
      });
      expect(res.totalLowStock).toBe(2);
      const ids = (res.items as Array<{ id: string }>).map((i) => i.id).sort();
      expect(ids).toEqual(['p-1', 'p-2']);
      const tinte = (res.items as Array<{ id: string; deficit: number }>).find(
        (i) => i.id === 'p-1',
      );
      expect(tinte?.deficit).toBe(5);
    });

    it('forbids staff and client roles', async () => {
      const prisma = makePrisma({ products: PRODUCTS });
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute('get_low_stock', {}, {
        prisma,
        tenantId: TENANT_ID,
        userId: 's-1',
        role: 'staff',
      });
      expect(res).toEqual({
        error: 'forbidden',
        message: expect.stringContaining('owner / admin / manager / recepcionista'),
      });
    });
  });

  describe('get_no_show_history', () => {
    const NS_APPOINTMENTS = [
      { id: 'n-1', tenantId: TENANT_ID, professionalId: 'staff-1', clientId: 'c-1', scheduledDate: new Date(today.getTime() - 5 * 86400000), scheduledTime: '10:00', status: 'no_show', services: [{ service: { name: 'X' } }] },
      { id: 'n-2', tenantId: TENANT_ID, professionalId: 'staff-1', clientId: 'c-1', scheduledDate: new Date(today.getTime() - 12 * 86400000), scheduledTime: '10:00', status: 'no_show', services: [{ service: { name: 'X' } }] },
      { id: 'n-3', tenantId: TENANT_ID, professionalId: 'staff-1', clientId: 'c-1', scheduledDate: new Date(today.getTime() - 28 * 86400000), scheduledTime: '10:00', status: 'no_show', services: [{ service: { name: 'X' } }] },
      { id: 'n-4', tenantId: TENANT_ID, professionalId: 'staff-1', clientId: 'c-2', scheduledDate: new Date(today.getTime() - 3 * 86400000), scheduledTime: '11:00', status: 'no_show', services: [{ service: { name: 'Y' } }] },
    ];
    const NS_CLIENTS = [
      { id: 'c-1', firstName: 'Carmen', tenantId: TENANT_ID, totalSpent: 200, lastVisit: null, status: 'active' as const },
      { id: 'c-2', firstName: 'Lucía', tenantId: TENANT_ID, totalSpent: 50, lastVisit: null, status: 'active' as const },
    ];

    it('returns only clients with ≥ N no-shows, ordered by frequency desc', async () => {
      const prisma = makePrisma({
        appointments: NS_APPOINTMENTS,
        clients: NS_CLIENTS,
      });
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute('get_no_show_history', {}, {
        prisma,
        tenantId: TENANT_ID,
        userId: OWNER_USER.id,
        role: 'owner',
      });
      expect(res.windowDays).toBe(90);
      expect(res.minNoShows).toBe(2);
      expect(res.flagged).toHaveLength(1);
      const entry = (res.flagged as Array<{ firstName: string; noShows: number; totalSpent?: number }>)[0];
      expect(entry.firstName).toBe('Carmen');
      expect(entry.noShows).toBe(3);
      expect(entry.totalSpent).toBe(200);
    });

    it('redacts totalSpent for receptionist and manager', async () => {
      const prisma = makePrisma({
        appointments: NS_APPOINTMENTS,
        clients: NS_CLIENTS,
      });
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute('get_no_show_history', {}, {
        prisma,
        tenantId: TENANT_ID,
        userId: 'r-1',
        role: 'receptionist',
      });
      const entry = (res.flagged as Array<{ totalSpent?: number }>)[0];
      expect(entry).not.toHaveProperty('totalAmount');
    });

    it('forbids staff role', async () => {
      const prisma = makePrisma({
        appointments: NS_APPOINTMENTS,
        clients: NS_CLIENTS,
      });
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute('get_no_show_history', {}, {
        prisma,
        tenantId: TENANT_ID,
        userId: 's-1',
        role: 'staff',
      });
      expect(res).toEqual({ error: 'forbidden', message: expect.any(String) });
    });
  });

  describe('get_top_clients', () => {
    const TC_CLIENTS = [
      { id: 'c-1', firstName: 'A', tenantId: TENANT_ID, totalSpent: 100, visitCount: 5, lastVisit: new Date(today.getTime() - 30 * 86400000), status: 'active' as const },
      { id: 'c-2', firstName: 'B', tenantId: TENANT_ID, totalSpent: 300, visitCount: 2, lastVisit: new Date(today.getTime() - 60 * 86400000), status: 'active' as const },
      { id: 'c-3', firstName: 'C', tenantId: TENANT_ID, totalSpent: 200, visitCount: 8, lastVisit: new Date(today.getTime() - 10 * 86400000), status: 'active' as const },
    ];

    it('ranks by spend desc for owner/manager/saas_owner', async () => {
      const prisma = makePrisma({ clients: TC_CLIENTS });
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute('get_top_clients', { metric: 'spend' }, {
        prisma,
        tenantId: TENANT_ID,
        userId: OWNER_USER.id,
        role: 'owner',
      });
      expect(res.metric).toBe('spend');
      const names = (res.top as Array<{ name: string }>).map((c) => c.name);
      expect(names).toEqual(['B', 'C', 'A']);
      expect((res.top as Array<{ totalSpent: number }>)[0].totalSpent).toBe(300);
    });

    it('redacts totalSpent for receptionist', async () => {
      const prisma = makePrisma({ clients: TC_CLIENTS });
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute('get_top_clients', { metric: 'spend' }, {
        prisma,
        tenantId: TENANT_ID,
        userId: 'r-1',
        role: 'receptionist',
      });
      expect(res.top[0]).not.toHaveProperty('totalSpend');
    });

    it('ranks by visitCount when metric=visits', async () => {
      const prisma = makePrisma({ clients: TC_CLIENTS });
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute('get_top_clients', { metric: 'visits' }, {
        prisma,
        tenantId: TENANT_ID,
        userId: OWNER_USER.id,
        role: 'owner',
      });
      const names = (res.top as Array<{ name: string }>).map((c) => c.name);
      expect(names).toEqual(['C', 'A', 'B']);
    });

    it('ranks by oldest lastVisit when metric=recency', async () => {
      const prisma = makePrisma({ clients: TC_CLIENTS });
      const svc = new SalonCopilotToolsService(prisma);
      const res = await svc.execute('get_top_clients', { metric: 'recency' }, {
        prisma,
        tenantId: TENANT_ID,
        userId: OWNER_USER.id,
        role: 'owner',
      });
      const names = (res.top as Array<{ name: string }>).map((c) => c.name);
      expect(names).toEqual(['B', 'A', 'C']);
    });
  });
});
