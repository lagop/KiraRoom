import { SalonToolsService, executeSalonTool } from './salon-tools';

/**
 * L-4 contract tests for the salon tools the Virtual Receptionist
 * exposes to the LLM. The whole point of the tool layer is to be
 * the only path through which the LLM learns about services,
 * professionals, availability and salon info — so each tool must
 * be pinned here against a deterministic Prisma mock.
 */

function makePrisma(services: any[], professionals: any[], tenant: any = null) {
  return {
    service: {
      findMany: jest.fn().mockImplementation(async ({ where, orderBy, take }: any) => {
        const filtered = services.filter((s) => {
          if (where?.tenantId && s.tenantId !== where.tenantId) return false;
          if (where?.isActive !== undefined && s.isActive !== where.isActive) return false;
          if (where?.category && s.category !== where.category) return false;
          return true;
        });
        const sorted = filtered.slice();
        if (Array.isArray(orderBy)) {
          sorted.sort((a: any, b: any) => {
            for (const o of orderBy) {
              const key = Object.keys(o)[0];
              const dir = o[key];
              if (a[key] < b[key]) return dir === 'desc' ? 1 : -1;
              if (a[key] > b[key]) return dir === 'desc' ? -1 : 1;
            }
            return 0;
          });
        }
        return typeof take === 'number' ? sorted.slice(0, take) : sorted;
      }),
      findFirst: jest.fn().mockImplementation(async ({ where }: any) => {
        return (
          services.find(
            (s) =>
              s.id === where?.id &&
              s.tenantId === where?.tenantId &&
              (where?.isActive === undefined || s.isActive === where.isActive),
          ) ?? null
        );
      }),
    },
    professional: {
      findMany: jest.fn().mockImplementation(async ({ where }: any) => {
        return professionals.filter((p) => {
          if (where?.tenantId && p.tenantId !== where.tenantId) return false;
          if (where?.isActive !== undefined && p.isActive !== where.isActive) return false;
          return true;
        });
      }),
    },
    tenant: {
      findUnique: jest.fn().mockImplementation(async ({ where }: any) => {
        if (where?.id === (tenant?.id ?? 't-1')) return tenant;
        return null;
      }),
    },
  } as any;
}

function makeAppointments(slots: Array<{ time: string }> = []) {
  return {
    getAvailableSlots: jest.fn().mockResolvedValue(slots),
  } as any;
}

const TENANT_ID = 't-1';

const SAMPLE_SERVICES = [
  {
    id: 's-cut-w',
    tenantId: TENANT_ID,
    name: 'Corte de Cabello Mujer',
    description: 'Corte y peinado para mujer',
    category: 'HAIR',
    duration: 60,
    price: 45,
    currency: 'EUR',
    isActive: true,
  },
  {
    id: 's-cut-m',
    tenantId: TENANT_ID,
    name: 'Corte de Cabello Hombre',
    description: 'Corte clásico para caballero',
    category: 'HAIR',
    duration: 30,
    price: 18,
    currency: 'EUR',
    isActive: true,
  },
  {
    id: 's-massage-rel',
    tenantId: TENANT_ID,
    name: 'Masaje Relajante',
    description: 'Masaje de 60 minutos para aliviar tensiones',
    category: 'MASSAGE',
    duration: 60,
    price: 55,
    currency: 'EUR',
    isActive: true,
  },
  {
    id: 's-massage-deep',
    tenantId: TENANT_ID,
    name: 'Masaje Descontracturante',
    description: 'Masaje profundo para contracturas',
    category: 'MASSAGE',
    duration: 75,
    price: 70,
    currency: 'EUR',
    isActive: true,
  },
  {
    id: 's-inactive',
    tenantId: TENANT_ID,
    name: 'Servicio Inactivo',
    description: null,
    category: 'HAIR',
    duration: 30,
    price: 1,
    currency: 'EUR',
    isActive: false,
  },
];

const SAMPLE_PROFESSIONALS = [
  {
    id: 'p-ana',
    tenantId: TENANT_ID,
    firstName: 'Ana',
    lastName: 'García',
    position: 'Estilista senior',
    bio: 'Especialista en coloración',
    profileImage: null,
    specialties: ['color', 'mechas'],
    yearsExperience: 10,
    languages: ['es', 'en'],
    isOwner: true,
    isActive: true,
  },
  {
    id: 'p-luis',
    tenantId: TENANT_ID,
    firstName: 'Luis',
    lastName: 'Pérez',
    position: 'Barbero',
    bio: 'Cortes masculinos',
    profileImage: null,
    specialties: ['corte hombre', 'barba'],
    yearsExperience: 5,
    languages: ['es'],
    isOwner: false,
    isActive: true,
  },
];

const SAMPLE_TENANT = {
  id: TENANT_ID,
  name: 'Kira Studio Test',
  description: 'Salón de prueba',
  email: 'salon@test.com',
  phone: '+34123456789',
  whatsapp: null,
  street: 'Calle Mayor 1',
  city: 'Madrid',
  state: 'Madrid',
  postalCode: '28001',
  country: 'ES',
  timezone: 'Europe/Madrid',
  currency: 'EUR',
  openingHours: { open: '09:00', close: '20:00' },
  assistantName: 'Kira',
};

describe('SalonToolsService (L-4)', () => {
  let svc: SalonToolsService;
  let prisma: ReturnType<typeof makePrisma>;
  let appointments: ReturnType<typeof makeAppointments>;

  beforeEach(() => {
    prisma = makePrisma(SAMPLE_SERVICES, SAMPLE_PROFESSIONALS, SAMPLE_TENANT);
    appointments = makeAppointments([
      { time: '10:00' },
      { time: '10:30' },
      { time: '11:00' },
    ]);
    svc = new SalonToolsService(prisma as any, appointments as any);
  });

  describe('list_services', () => {
    it('returns every active service when no filter is supplied', async () => {
      const result = await svc.listServices({ prisma, tenantId: TENANT_ID }, {});
      expect(prisma.service.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId: TENANT_ID, isActive: true } }),
      );
      expect(result.services.map((s: any) => s.id).sort()).toEqual([
        's-cut-m',
        's-cut-w',
        's-massage-deep',
        's-massage-rel',
      ]);
      const cut = result.services.find((s: any) => s.id === 's-cut-w');
      expect(cut).toEqual({
        id: 's-cut-w',
        name: 'Corte de Cabello Mujer',
        description: 'Corte y peinado para mujer',
        category: 'HAIR',
        durationMinutes: 60,
        price: '45.00',
        currency: 'EUR',
      });
      expect(result.totalMatching).toBe(4);
    });

    it('filters by audience="male" so women-only services are excluded', async () => {
      const result = await svc.listServices({ prisma, tenantId: TENANT_ID }, {
        audience: 'male',
      });
      const ids = result.services.map((s: any) => s.id);
      // Women-only services must be filtered out.
      expect(ids).not.toContain('s-cut-w');
      // Men's services must remain.
      expect(ids).toContain('s-cut-m');
      // Neutral services (no gender marker in name/description) pass
      // through by design — only services that conflict with the
      // audience are excluded.
      expect(result.note).toContain('male');
    });

    it('returns the empty list + note when only conflicting-audience services exist', async () => {
      prisma.service.findMany.mockImplementation(async () => [
        {
          ...SAMPLE_SERVICES[0], // "Corte de Cabello Mujer"
          id: 's-only-women',
        },
      ]);
      const result = await svc.listServices({ prisma, tenantId: TENANT_ID }, {
        audience: 'male',
      });
      expect(result.services).toEqual([]);
      expect(result.totalMatching).toBe(0);
      expect(result.note).toContain('male');
    });

    it('filters by audience="child"', async () => {
      prisma.service.findMany.mockImplementation(async () => [
        {
          ...SAMPLE_SERVICES[0],
          id: 's-kid',
          name: 'Corte Infantil',
          description: null,
        },
      ]);
      const result = await svc.listServices({ prisma, tenantId: TENANT_ID }, {
        audience: 'child',
      });
      expect(result.services.map((s: any) => s.id)).toEqual(['s-kid']);
    });

    it('does not pass category to Prisma (filtered in-memory instead)', async () => {
      // The Prisma where clause intentionally has no `category` field
      // — the LLM has been seen to invent non-enum values like
      // "Cabello" that Prisma rejects. Filtering happens in-memory
      // by keyword so we never crash.
      await svc.listServices({ prisma, tenantId: TENANT_ID }, { keyword: 'masaje' });
      expect(prisma.service.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId: TENANT_ID, isActive: true } }),
      );
      // The where clause must NOT contain a `category` key.
      const callArgs = prisma.service.findMany.mock.calls[0][0];
      expect(callArgs.where).not.toHaveProperty('category');
    });

    it('filters by free-text keyword using accent-insensitive substring match', async () => {
      const result = await svc.listServices({ prisma, tenantId: TENANT_ID }, {
        keyword: 'cabello',
      });
      expect(result.services.map((s: any) => s.id).sort()).toEqual(['s-cut-m', 's-cut-w']);
    });

    it('hides inactive services', async () => {
      const result = await svc.listServices({ prisma, tenantId: TENANT_ID }, {});
      expect(result.services.map((s: any) => s.id)).not.toContain('s-inactive');
    });

    it('caps the result list at the requested limit', async () => {
      const result = await svc.listServices({ prisma, tenantId: TENANT_ID }, { limit: 2 });
      expect(result.services).toHaveLength(2);
    });
  });

  describe('get_service', () => {
    it('returns the exact price and duration for a known service', async () => {
      const result = await svc.getService({ prisma, tenantId: TENANT_ID }, {
        serviceId: 's-cut-m',
      });
      expect(result).toMatchObject({
        id: 's-cut-m',
        name: 'Corte de Cabello Hombre',
        durationMinutes: 30,
        price: '18.00',
        currency: 'EUR',
      });
    });

    it('returns an error envelope for an unknown / wrong-tenant id', async () => {
      const result = await svc.getService({ prisma, tenantId: TENANT_ID }, {
        serviceId: 's-does-not-exist',
      });
      expect(result).toEqual({ error: 'service_not_found', serviceId: 's-does-not-exist' });
    });
  });

  describe('list_professionals', () => {
    it('returns every active professional by default', async () => {
      const result = await svc.listProfessionals({ prisma, tenantId: TENANT_ID }, {});
      expect(result.professionals).toHaveLength(2);
      expect(result.professionals[0].fullName).toBe('Ana García');
      expect(result.professionals[0].isOwner).toBe(true);
    });

    it('filters by specialty token (accent-insensitive)', async () => {
      const result = await svc.listProfessionals({ prisma, tenantId: TENANT_ID }, {
        specialty: 'barba',
      });
      expect(result.professionals.map((p: any) => p.id)).toEqual(['p-luis']);
    });

    it('filters by spoken language', async () => {
      const result = await svc.listProfessionals({ prisma, tenantId: TENANT_ID }, {
        language: 'en',
      });
      expect(result.professionals.map((p: any) => p.id)).toEqual(['p-ana']);
    });
  });

  describe('check_availability', () => {
    it('returns the slots produced by AppointmentsService.getAvailableSlots', async () => {
      const result = await svc.checkAvailability({ prisma, tenantId: TENANT_ID, appointmentsService: appointments }, {
        serviceId: 's-cut-m',
        date: '2026-09-01',
      });
      expect(result).toEqual({
        date: '2026-09-01',
        serviceId: 's-cut-m',
        slots: ['10:00', '10:30', '11:00'],
      });
      expect(appointments.getAvailableSlots).toHaveBeenCalledWith(
        TENANT_ID,
        expect.any(Date),
        undefined,
        's-cut-m',
      );
    });

    it('returns an error envelope for an unparseable date', async () => {
      const result = await svc.checkAvailability({ prisma, tenantId: TENANT_ID, appointmentsService: appointments }, {
        serviceId: 's-cut-m',
        date: 'not-a-date',
      });
      expect(result).toMatchObject({ error: 'invalid_date' });
    });
  });

  describe('get_salon_info', () => {
    it('returns address, phone, opening hours and assistant name', async () => {
      const result = await svc.getSalonInfo({ prisma, tenantId: TENANT_ID });
      expect(result).toMatchObject({
        name: 'Kira Studio Test',
        city: 'Madrid',
        phone: '+34123456789',
        currency: 'EUR',
        assistantName: 'Kira',
      });
      expect('error' in result).toBe(false);
      if (!('error' in result)) {
        expect(result.openingHours).toEqual({ open: '09:00', close: '20:00' });
      }
    });

    it('returns an error envelope when the tenant is missing', async () => {
      const emptyPrisma = makePrisma([], [], null);
      const result = await svc.getSalonInfo({ prisma: emptyPrisma, tenantId: 't-1' });
      expect(result).toEqual({ error: 'tenant_not_found' });
    });
  });

  describe('executeSalonTool dispatcher', () => {
    it('routes by tool name and returns a structured error on unknown tools', async () => {
      const ok = await executeSalonTool(svc, 'get_service', { serviceId: 's-cut-m' }, {
        prisma,
        tenantId: TENANT_ID,
      });
      expect(ok).toMatchObject({ id: 's-cut-m' });

      const bad = await executeSalonTool(svc, 'nope', {}, { prisma, tenantId: TENANT_ID });
      expect(bad).toEqual({ error: 'unknown_tool:nope' });
    });
  });
});