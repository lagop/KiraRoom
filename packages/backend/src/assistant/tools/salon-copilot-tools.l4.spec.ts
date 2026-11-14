import { SalonCopilotToolsService } from './salon-copilot-tools';
import { salonToday } from '../../analytics/analytics-metrics';
import { safeTimeZone } from '../../gift-cards/gift-card-expiry';
import { salonNowMinutes } from '../briefing-gaps';

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

// Dates as stored: the UTC midnight of the salon's day (the default zone,
// no tenant row in this mock).
const TZ = safeTimeZone(undefined);
const TODAY = salonToday(TZ);
const today = new Date(`${TODAY}T00:00:00.000Z`);

/** The instant the salon's clock reads `hhmm` on `day` (default: today). */
function atSalonTime(hhmm: string, day = TODAY): Date {
  const [h, m] = hhmm.split(':').map(Number);
  const offset = salonNowMinutes(TZ, new Date(`${day}T12:00:00.000Z`)) - 720;
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + (h * 60 + m - offset) * 60_000);
}

/** The service with its clock pinned (gaps before "now" are gone): 06:00 by default. */
function newSvc(prisma: any, now: Date = atSalonTime('06:00')): SalonCopilotToolsService {
  const svc = new SalonCopilotToolsService(prisma);
  svc.now = () => now;
  return svc;
}
const yesterday = new Date(today);
yesterday.setUTCDate(today.getUTCDate() - 1);
const lastMonth = new Date(today);
lastMonth.setUTCDate(today.getUTCDate() - 30);

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
  tenant?: any;
  timeOff?: any[];
  services?: any[];
  locations?: any[];
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
    tenant: { findUnique: jest.fn(async () => opts.tenant ?? null) },
    appointment: {
      findMany: jest.fn().mockImplementation(async ({ where }: any) => {
        const list = appts
          .filter((a: any) => {
            if (where?.tenantId && a.tenantId !== where.tenantId) return false;
            if (where?.clientId && a.clientId !== where.clientId) return false;
            if (where?.professionalId?.in) {
              if (!where.professionalId.in.includes(a.professionalId)) return false;
            } else if (where?.professionalId && a.professionalId !== where.professionalId) {
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
      count: jest.fn().mockImplementation(async ({ where }: any) =>
        appts.filter((a: any) =>
          (!where?.clientId || a.clientId === where.clientId) &&
          (!where?.tenantId || a.tenantId === where.tenantId) &&
          (!where?.status || a.status === where.status) &&
          (!where?.scheduledDate?.gte || a.scheduledDate >= where.scheduledDate.gte),
        ).length,
      ),
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
      // By id within the salon; `appointments.some` is the staff reach rule
      // (an appointment with that professional that is not cancelled).
      findFirst: jest.fn().mockImplementation(async ({ where }: any) => {
        const reach = where?.appointments?.some;
        return (
          cls.find((c: any) => {
            if (where?.id && c.id !== where.id) return false;
            if (where?.tenantId && c.tenantId && c.tenantId !== where.tenantId) return false;
            if (reach) {
              return appts.some(
                (a: any) =>
                  a.clientId === c.id &&
                  a.professionalId === reach.professionalId &&
                  a.status !== 'cancelled',
              );
            }
            return true;
          }) ?? null
        );
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
      findMany: jest.fn().mockImplementation(async ({ where }: any) =>
        pros.filter((p: any) => {
          if (where?.isActive === true && p.isActive === false) return false;
          if (where?.id?.in && !where.id.in.includes(p.id)) return false;
          const loc = where?.locations?.some?.locationId;
          if (loc && !(p.locationIds ?? []).includes(loc)) return false;
          return true;
        }),
      ),
    },
    timeOff: { findMany: jest.fn(async () => opts.timeOff ?? []) },
    service: {
      findMany: jest.fn(async ({ where }: any) =>
        (opts.services ?? []).filter((x: any) => !where?.id?.in || where.id.in.includes(x.id)),
      ),
    },
    location: { findMany: jest.fn(async () => opts.locations ?? []) },
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
        const w: any = args?.where ?? {};
        const take: number | undefined = args?.take;
        const [early, late] = (w.AND ?? []).map((c: any) => c.OR?.[1]);
        let list = wls
          .filter((x: any) => {
            if (w.tenantId && x.tenantId !== w.tenantId) return false;
            if (w.status?.in && !w.status.in.includes(x.status)) return false;
            const client = cls.find((c: any) => c.id === x.clientId) ?? x.client;
            if (w.client?.status && client?.status !== w.client.status) return false;
            if (early?.earliestDate?.lte && x.earliestDate && x.earliestDate > early.earliestDate.lte) return false;
            if (late?.latestDate?.gte && x.latestDate && x.latestDate < late.latestDate.gte) return false;
            return true;
          })
          .map((x: any) => ({ ...x, client: cls.find((c: any) => c.id === x.clientId) ?? x.client ?? null }));
        list = list.slice().sort((p: any, q: any) => new Date(p.createdAt ?? 0).getTime() - new Date(q.createdAt ?? 0).getTime());
        if (typeof take === 'number') list = list.slice(0, take);
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
      const svc = newSvc(prisma);
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
      const svc = newSvc(prisma);
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
      const svc = newSvc(prisma);
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
      const svc = newSvc(prisma);
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
      const svc = newSvc(prisma);
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
      const svc = newSvc(prisma);
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
      const svc = newSvc(prisma);
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
      const svc = newSvc(prisma);
      const res = await svc.execute('get_client_360', { clientId: 'c-1' }, {
        prisma,
        tenantId: TENANT_ID,
        userId: OWNER_USER.id,
        role: 'owner',
      });
      expect(res.id).toBe('c-1');
      expect(res.name).toBe('Carmen Ruiz');
      // A4 / D1: no contact details, birth date or gender reach the AI; allergies do.
      for (const k of ['email', 'phone', 'birthDate', 'dateOfBirth', 'gender']) expect(res).not.toHaveProperty(k);
      expect(res).toMatchObject({ hasEmail: true, hasPhone: true, allergies: ['PPD', 'lanolina'] });
      // c-1 has 3 visits: a-1 (today, confirmed), a-3 (today, confirmed),
      // a-4 (yesterday, completed). a-2 is c-2 and a-5 is c-2 — excluded.
      expect(res.visits).toHaveLength(3);
      // Stats only count completed: only a-4. So 1.
      expect((res.stats as any).completedVisitsLast365d).toBe(1);
      expect((res.stats as any).totalSpentEur).toBe(0);
      expect(res.visits[0]).toHaveProperty('totalEur');
      expect(res.visits[0]).not.toHaveProperty('totalAmount');
    });

    it('A2: gives euros (catalogue cents, tax added when prices exclude it), and the service as booked', async () => {
      const prisma = makePrisma({
        appointments: [
          {
            id: 'v-1', tenantId: TENANT_ID, professionalId: 'staff-2', clientId: 'c-1', scheduledDate: yesterday,
            scheduledTime: '10:00', status: 'completed', totalAmount: 4000,
            services: [{ serviceName: 'Corte (precio antiguo)', service: { id: 's-1', name: 'Corte renombrado' } }],
          },
        ],
        clients: [{ ...SAMPLE_CLIENT, tenantId: TENANT_ID, totalSpent: 120.5 }],
        tenant: { fiscalSettings: { pricesIncludeTax: false, defaultTaxRate: 21 } },
      });
      const svc = newSvc(prisma);
      const res: any = await svc.execute('get_client_360', { clientId: 'c-1' }, {
        prisma, tenantId: TENANT_ID, userId: OWNER_USER.id, role: 'owner',
      });
      // 40,00 base + 21 % = 48,40 EUR, not "4000".
      expect(res.visits[0].totalEur).toBe(48.4);
      expect(res.visits[0].services).toEqual([{ id: 's-1', name: 'Corte (precio antiguo)' }]);
      expect(res.stats.totalSpentEur).toBe(120.5);
    });

    it('B2: a client of another salon is not found, even for the platform owner', async () => {
      const prisma = makePrisma({ clients: [{ ...SAMPLE_CLIENT, tenantId: 'other-salon' }] });
      const svc = newSvc(prisma);
      const res = await svc.execute('get_client_360', { clientId: 'c-1' }, {
        prisma, tenantId: TENANT_ID, userId: 'saas-1', role: 'saas_owner',
      });
      expect(res).toEqual({ error: 'client_not_found' });
    });

    it('B3: a cancelled booking does not open the file to the professional', async () => {
      const prisma = makePrisma({
        appointments: [{ id: 'x-1', tenantId: TENANT_ID, professionalId: 'staff-1', clientId: 'c-1', scheduledDate: today, scheduledTime: '09:00', status: 'cancelled', services: [] }],
        clients: [{ ...SAMPLE_CLIENT, tenantId: TENANT_ID }],
        professionals: SAMPLE_PROFESSIONALS,
      });
      const svc = newSvc(prisma);
      const res = await svc.execute('get_client_360', { clientId: 'c-1' }, {
        prisma, tenantId: TENANT_ID, userId: STAFF_USER_ID, role: 'staff',
      });
      expect(res).toMatchObject({ error: 'forbidden' });
    });

    it('staff sees only their own visits', async () => {
      const prisma = makePrisma({
        appointments: SAMPLE_APPOINTMENTS,
        clients: [SAMPLE_CLIENT],
        professionals: SAMPLE_PROFESSIONALS,
      });
      const svc = newSvc(prisma);
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
      const svc = newSvc(prisma);
      const res = await svc.execute('get_client_360', { clientId: 'c-1' }, {
        prisma,
        tenantId: TENANT_ID,
        userId: STAFF_USER_ID,
        role: 'staff',
      });
      expect(res.visits[0]).not.toHaveProperty('totalAmount');
      expect(res.visits[0]).not.toHaveProperty('totalEur');
      expect(res.stats).toEqual({});
    });

    it('returns 404 if the client does not exist', async () => {
      const prisma = makePrisma({
        appointments: SAMPLE_APPOINTMENTS,
        clients: [SAMPLE_CLIENT],
      });
      const svc = newSvc(prisma);
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
      { id: 'w-1', tenantId: TENANT_ID, clientId: 'c-mar', serviceId: 's-corte', professionalId: null, status: 'waiting', earliestDate: null, latestDate: null, createdAt: THREE_MONTHS_AGO },
      { id: 'w-2', tenantId: TENANT_ID, clientId: 'c-ana', serviceId: 's-corte', professionalId: null, status: 'waiting', earliestDate: null, latestDate: null, createdAt: YESTERDAY },
    ];
    const SERVICES = [{ id: 's-corte', name: 'Corte', duration: 30, professionals: [] }];

    it('returns gaps ≥ 30 min between staff-1\'s today appointments', async () => {
      const prisma = makePrisma({
        appointments: SAMPLE_APPOINTMENTS,
        waitList: WL_ENTRIES,
        clients: SAMPLE_CLIENTS,
        professionals: SAMPLE_PROFESSIONALS,
      });
      const svc = newSvc(prisma);
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

    it('attaches wait-list candidates for owner/manager, longest waiting first', async () => {
      const prisma = makePrisma({
        appointments: SAMPLE_APPOINTMENTS,
        waitList: WL_ENTRIES,
        clients: SAMPLE_CLIENTS,
        professionals: SAMPLE_PROFESSIONALS,
        services: SERVICES,
      });
      const svc = newSvc(prisma);
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
        professionals: SAMPLE_PROFESSIONALS,
        services: SERVICES,
      });
      const svc = newSvc(prisma);
      const res = await svc.execute('find_filling_opportunities', {}, {
        prisma,
        tenantId: TENANT_ID,
        userId: 'r-1',
        role: 'receptionist',
      });
      expect((res.gaps as unknown[]).length).toBeGreaterThan(0);
      for (const g of res.gaps as Array<{ suggestions: unknown[] }>) {
        expect(g.suggestions).toEqual([]);
      }
    });

    it('filters agenda by professional for staff role', async () => {
      const prisma = makePrisma({
        appointments: SAMPLE_APPOINTMENTS,
        clients: SAMPLE_CLIENTS,
        professionals: SAMPLE_PROFESSIONALS,
      });
      const svc = newSvc(prisma);
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
      const svc = newSvc(prisma);
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
      const svc = newSvc(prisma);
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
      const svc = newSvc(prisma);
      const res = await svc.execute('get_no_show_history', {}, {
        prisma,
        tenantId: TENANT_ID,
        userId: OWNER_USER.id,
        role: 'owner',
      });
      expect(res.windowDays).toBe(90);
      expect(res.minNoShows).toBe(2);
      expect(res.flagged).toHaveLength(1);
      const entry = (res.flagged as Array<{ firstName: string; noShows: number; totalSpentEur?: number }>)[0];
      expect(entry.firstName).toBe('Carmen');
      expect(entry.noShows).toBe(3);
      expect(entry.totalSpentEur).toBe(200);
    });

    it('redacts totalSpent for receptionist and manager', async () => {
      const prisma = makePrisma({
        appointments: NS_APPOINTMENTS,
        clients: NS_CLIENTS,
      });
      const svc = newSvc(prisma);
      const res = await svc.execute('get_no_show_history', {}, {
        prisma,
        tenantId: TENANT_ID,
        userId: 'r-1',
        role: 'receptionist',
      });
      const entry = (res.flagged as Array<{ totalSpent?: number }>)[0];
      expect(entry).not.toHaveProperty('totalSpentEur');
    });

    it('forbids staff role', async () => {
      const prisma = makePrisma({
        appointments: NS_APPOINTMENTS,
        clients: NS_CLIENTS,
      });
      const svc = newSvc(prisma);
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
      const svc = newSvc(prisma);
      const res = await svc.execute('get_top_clients', { metric: 'spend' }, {
        prisma,
        tenantId: TENANT_ID,
        userId: OWNER_USER.id,
        role: 'owner',
      });
      expect(res.metric).toBe('spend');
      const names = (res.top as Array<{ name: string }>).map((c) => c.name);
      expect(names).toEqual(['B', 'C', 'A']);
      expect((res.top as Array<{ totalSpentEur: number }>)[0].totalSpentEur).toBe(300);
    });

    it('redacts totalSpent for receptionist', async () => {
      const prisma = makePrisma({ clients: TC_CLIENTS });
      const svc = newSvc(prisma);
      const res = await svc.execute('get_top_clients', { metric: 'spend' }, {
        prisma,
        tenantId: TENANT_ID,
        userId: 'r-1',
        role: 'receptionist',
      });
      expect(res.top[0]).not.toHaveProperty('totalSpentEur');
    });

    it('ranks by visitCount when metric=visits', async () => {
      const prisma = makePrisma({ clients: TC_CLIENTS });
      const svc = newSvc(prisma);
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
      const svc = newSvc(prisma);
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

/**
 * A staff user's id is not their professional's id. The fixtures above use
 * the same string for both ('staff-1'), which hid three comparisons of
 * professionalId with the User id: a professional was refused their own
 * agenda by id, their own clients, and their own gaps.
 */
describe('SalonCopilotToolsService: staff user id vs professional id', () => {
  const MARIA = { id: 'pro-maria', userId: 'user-maria', firstName: 'María', lastName: 'García' };
  const JORGE = { id: 'pro-jorge', userId: 'user-jorge', firstName: 'Jorge', lastName: 'Pérez' };
  const APPTS = [
    { id: 'm-1', tenantId: TENANT_ID, professionalId: 'pro-maria', clientId: 'c-1', scheduledDate: today, scheduledTime: '09:00', status: 'confirmed', services: [{ service: { name: 'Corte' } }] },
    { id: 'm-2', tenantId: TENANT_ID, professionalId: 'pro-maria', clientId: 'c-2', scheduledDate: today, scheduledTime: '11:00', status: 'pending', services: [{ service: { name: 'Color' } }] },
    { id: 'j-1', tenantId: TENANT_ID, professionalId: 'pro-jorge', clientId: 'c-3', scheduledDate: today, scheduledTime: '13:00', status: 'confirmed', services: [{ service: { name: 'Masaje' } }] },
  ];
  const ctxFor = (prisma: any, userId: string) => ({ prisma, tenantId: TENANT_ID, userId, role: 'staff' as const });
  const setup = (professionals = [MARIA, JORGE]) => {
    const prisma = makePrisma({ appointments: APPTS, clients: [...SAMPLE_CLIENTS, SAMPLE_CLIENT], professionals });
    return { prisma, svc: newSvc(prisma) };
  };

  it('a professional can ask for their own agenda by their professional id', async () => {
    const { prisma, svc } = setup();
    const res = await svc.execute('get_my_agenda', { professionalId: 'pro-maria' }, ctxFor(prisma, 'user-maria'));
    expect(res.error).toBeUndefined();
    expect(res.appointments).toHaveLength(2);
  });

  it('but not a colleague\'s', async () => {
    const { prisma, svc } = setup();
    const res = await svc.execute('get_my_agenda', { professionalId: 'pro-jorge' }, ctxFor(prisma, 'user-maria'));
    expect(res.error).toBe('forbidden');
  });

  it('sees their own clients, not a colleague\'s', async () => {
    const { prisma, svc } = setup();
    const own = await svc.execute('get_client_360', { clientId: 'c-1' }, ctxFor(prisma, 'user-maria'));
    expect(own.error).toBeUndefined();
    const other = await svc.execute('get_client_360', { clientId: 'c-3' }, ctxFor(prisma, 'user-maria'));
    expect(other.error).toBe('forbidden');
  });

  it('finds the gaps in their own day', async () => {
    const { prisma, svc } = setup();
    const res = await svc.execute('find_filling_opportunities', {}, ctxFor(prisma, 'user-maria'));
    expect(res.error).toBeUndefined();
    // 09:00-09:30 then 11:00: one 90-minute gap; Jorge's 13:00 is not hers.
    expect(res.gaps).toHaveLength(1);
  });

  it('a staff account linked to no professional gets nothing, not the whole salon', async () => {
    const { prisma, svc } = setup([]);
    for (const tool of ['get_my_agenda', 'find_filling_opportunities']) {
      const res = await svc.execute(tool, {}, ctxFor(prisma, 'user-nobody'));
      expect(res.error).toBe('forbidden');
    }
    const res = await svc.execute('get_client_360', { clientId: 'c-1' }, ctxFor(prisma, 'user-nobody'));
    expect(res.error).toBe('forbidden');
  });
});


/**
 * Copilot audit M6: the gaps are per professional, inside her working hours
 * and the salon's, minus closures, time off and her appointments, never in
 * the past; and the wait list offered for a gap is the one that fits it.
 */
describe('M6: free gaps per professional', () => {
  const WEEK = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const shifts = (...ranges: Array<[string, string]>) =>
    WEEK.flatMap((day) => ranges.map(([openTime, closeTime]) => ({ day, openTime, closeTime })));
  // The salon opens 10-14 and 16-20 (lunch closed); Ana works both shifts, Lucía only afternoons.
  const TENANT = { timezone: TZ, openingHours: shifts(['10:00', '14:00'], ['16:00', '20:00']) };
  const ANA = { id: 'p-ana', userId: 'u-ana', firstName: 'Ana', workingHours: shifts(['10:00', '14:00'], ['16:00', '20:00']), locationIds: ['l-centro'] };
  const LUCIA = { id: 'p-lucia', userId: 'u-lucia', firstName: 'Lucía', workingHours: shifts(['16:00', '20:00']), locationIds: ['l-gracia'] };
  // Ana is booked all morning.
  const APPTS = [
    { id: 'x-1', tenantId: TENANT_ID, professionalId: 'p-ana', clientId: 'c-1', scheduledDate: today, scheduledTime: '10:00', duration: 240, status: 'confirmed', services: [{ service: { name: 'Mechas' } }] },
  ];
  const owner = (prisma: any) => ({ prisma, tenantId: TENANT_ID, userId: 'owner-1', role: 'owner' as const });
  const setup = (extra: Record<string, unknown> = {}, now = atSalonTime('06:00')) => {
    const prisma = makePrisma({ tenant: TENANT, professionals: [ANA, LUCIA], appointments: APPTS, clients: SAMPLE_CLIENTS, ...extra });
    return { prisma, svc: newSvc(prisma, now) };
  };
  const brief = (gaps: any[]) => gaps.map((g) => `${g.professionalFirstName} ${g.start}-${g.end}`);

  it('one row per professional inside her hours: the lunch closure is not a gap, a free afternoon is', async () => {
    const { prisma, svc } = setup();
    const res: any = await svc.execute('get_my_agenda', {}, owner(prisma));
    expect(brief(res.gaps)).toEqual(['Ana 16:00-20:00', 'Lucía 16:00-20:00']);
    expect(res.gaps[0]).toMatchObject({ professionalId: 'p-ana', minutes: 240 });
  });

  it('a whole-day closure leaves no gaps; a partial one takes its hours out', async () => {
    const closed = setup({ timeOff: [{ professionalId: null, kind: 'closure', startDate: today, endDate: today, status: 'approved' }] });
    expect((await closed.svc.execute('get_my_agenda', {}, owner(closed.prisma)) as any).gaps).toEqual([]);

    const partial = setup({ timeOff: [{ professionalId: null, kind: 'closure', startDate: today, endDate: today, startTime: '16:00', endTime: '18:00', status: 'approved' }] });
    expect(brief((await partial.svc.execute('get_my_agenda', {}, owner(partial.prisma)) as any).gaps)).toEqual([
      'Ana 18:00-20:00',
      'Lucía 18:00-20:00',
    ]);
  });

  it('time off (ausencias) takes the professional out; a pending request does not', async () => {
    const off = setup({ timeOff: [{ professionalId: 'p-lucia', kind: 'vacation', startDate: today, endDate: today, status: 'approved' }] });
    expect(brief((await off.svc.execute('get_my_agenda', {}, owner(off.prisma)) as any).gaps)).toEqual(['Ana 16:00-20:00']);

    const pending = setup({ timeOff: [{ professionalId: 'p-lucia', kind: 'vacation', startDate: today, endDate: today, status: 'pending' }] });
    expect(brief((await pending.svc.execute('get_my_agenda', {}, owner(pending.prisma)) as any).gaps)).toContain('Lucía 16:00-20:00');
  });

  it('time already gone today is not a gap', async () => {
    const { prisma, svc } = setup({}, atSalonTime('17:30'));
    const res: any = await svc.execute('get_my_agenda', {}, owner(prisma));
    expect(brief(res.gaps)).toEqual(['Ana 17:30-20:00', 'Lucía 17:30-20:00']);
    expect(res.gaps[0].minutes).toBe(150);
  });

  it('reads the date asked for, not always today', async () => {
    const { prisma, svc } = setup();
    const tomorrow = addDaysIso(TODAY, 1);
    const res: any = await svc.execute('get_my_agenda', { date: tomorrow }, owner(prisma));
    expect(res.date).toBe(tomorrow);
    // Nobody is booked tomorrow: Ana's two shifts and Lucía's afternoon.
    expect(brief(res.gaps)).toEqual(['Ana 10:00-14:00', 'Ana 16:00-20:00', 'Lucía 16:00-20:00']);
  });

  it('a professional only gets her own gaps', async () => {
    const { prisma, svc } = setup();
    const ctx = { prisma, tenantId: TENANT_ID, userId: 'u-lucia', role: 'staff' as const };
    expect(brief((await svc.execute('get_my_agenda', {}, ctx) as any).gaps)).toEqual(['Lucía 16:00-20:00']);
    const week: any = await svc.execute('find_filling_opportunities', { daysAhead: 2 }, ctx);
    expect(week.gaps.every((g: any) => g.professionalId === 'p-lucia')).toBe(true);
    expect(week.gaps).toHaveLength(2);
  });

  it('a location: only the professionals who work there', async () => {
    const { prisma, svc } = setup({ locations: [{ id: 'l-centro', name: 'Centro' }, { id: 'l-gracia', name: 'Local Gràcia' }] });
    const res: any = await svc.execute('get_my_agenda', { location: 'gracia' }, owner(prisma));
    expect(res.location).toBe('Local Gràcia');
    expect(brief(res.gaps)).toEqual(['Lucía 16:00-20:00']);
    const unknown: any = await svc.execute('find_filling_opportunities', { location: 'Sants' }, owner(prisma));
    expect(unknown.error).toBe('location_not_found');
    expect(unknown.message).toContain('Centro');
  });

  it('find_filling_opportunities: per professional and day, in date order, from now on', async () => {
    const { prisma, svc } = setup();
    const res: any = await svc.execute('find_filling_opportunities', { daysAhead: 2 }, owner(prisma));
    expect(res.from).toBe(TODAY);
    expect(res.totalGaps).toBe(5); // today: Ana pm, Lucía pm; tomorrow: Ana am+pm, Lucía pm
    expect(res.gaps.map((g: any) => `${g.date === TODAY ? 'hoy' : 'mañana'} ${g.professionalFirstName} ${g.start}`)).toEqual([
      'hoy Ana 16:00',
      'hoy Lucía 16:00',
      'mañana Ana 10:00',
      'mañana Ana 16:00',
      'mañana Lucía 16:00',
    ]);
  });

  describe('wait-list suggestions', () => {
    const CLIENTS = [
      ...SAMPLE_CLIENTS,
      { id: 'c-blocked', firstName: 'Bea', lastName: 'B', tenantId: TENANT_ID, status: 'blocked' as const },
      { id: 'c-later', firstName: 'Eva', lastName: 'E', tenantId: TENANT_ID, status: 'active' as const },
      { id: 'c-long', firstName: 'Olga', lastName: 'O', tenantId: TENANT_ID, status: 'active' as const },
    ];
    const SERVICES = [
      { id: 's-corte', name: 'Corte', duration: 30, professionals: [] },
      { id: 's-largo', name: 'Alisado', duration: 300, professionals: [] },
      { id: 's-color', name: 'Color', duration: 60, professionals: [{ professionalId: 'p-ana', professional: { isActive: true } }] },
    ];
    const t = (days: number) => new Date(`${addDaysIso(TODAY, days)}T00:00:00.000Z`);
    let seq = 0;
    const wl = (id: string, clientId: string, serviceId: string, extra: Record<string, unknown> = {}) => ({
      id, tenantId: TENANT_ID, clientId, serviceId, professionalId: null, status: 'waiting', earliestDate: null, latestDate: null,
      createdAt: new Date(Date.UTC(2026, 0, 1) + (seq++) * 60_000), ...extra,
    });
    const run = async (waitList: any[], args: Record<string, unknown> = {}) => {
      const { prisma, svc } = setup({ clients: CLIENTS, services: SERVICES, waitList });
      return (await svc.execute('find_filling_opportunities', { daysAhead: 1, ...args }, owner(prisma))) as any;
    };
    const names = (res: any, who: string) =>
      res.gaps.find((g: any) => g.professionalFirstName === who).suggestions.map((s: any) => s.firstName);

    it('never offers a blocked client', async () => {
      const res = await run([wl('w-b', 'c-blocked', 's-corte'), wl('w-c', 'c-1', 's-corte')]);
      expect(res.gaps).toHaveLength(2);
      for (const g of res.gaps) expect(g.suggestions.map((s: any) => s.firstName)).toEqual(['Carmen']);
    });

    it('matches the professional she asked for and who performs the service', async () => {
      const res = await run([
        wl('w-1', 'c-1', 's-corte', { professionalId: 'p-lucia' }),
        wl('w-2', 'c-2', 's-color'), // only Ana does colour
      ]);
      expect(names(res, 'Ana')).toEqual(['Lucía']);
      expect(names(res, 'Lucía')).toEqual(['Carmen']);
      const first = res.gaps.find((g: any) => g.professionalFirstName === 'Lucía').suggestions[0];
      expect(first).toMatchObject({ service: 'Corte', askedForThisProfessional: true });
    });

    it('matches her dates and leaves out a service longer than the gap', async () => {
      const res = await run([
        wl('w-1', 'c-later', 's-corte', { earliestDate: t(3) }),
        wl('w-2', 'c-long', 's-largo'),
        wl('w-3', 'c-3', 's-corte', { earliestDate: t(-5), latestDate: t(0) }),
      ]);
      expect(res.gaps).toHaveLength(2);
      for (const g of res.gaps) expect(g.suggestions.map((s: any) => s.firstName)).toEqual(['Pablo']);
    });

    it('does not offer the same client first in every gap when another fits', async () => {
      const res = await run([wl('w-1', 'c-1', 's-corte'), wl('w-2', 'c-2', 's-corte')], { topN: 1 });
      expect(res.gaps).toHaveLength(2);
      expect(res.gaps.map((g: any) => g.suggestions[0].firstName).sort()).toEqual(['Carmen', 'Lucía']);
    });
  });
});

function addDaysIso(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
