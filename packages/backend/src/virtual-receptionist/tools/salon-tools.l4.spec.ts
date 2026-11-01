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

function makeAppointments(slots: Array<{ time: string; isAvailable?: boolean }> = []) {
  return {
    getAvailableSlots: jest
      .fn()
      .mockResolvedValue(slots.map((s) => ({ isAvailable: true, ...s }))),
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
  name: 'Kira Room Test',
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
  // Its catalogue already includes the IVA: prices are quoted as stored.
  fiscalSettings: { pricesIncludeTax: true, defaultTaxRate: 21, taxRegime: 'iva' },
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
        onlineBookable: true,
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

    it('returns the whole catalogue, with a note, when the keyword matches nothing', async () => {
      // Asked in English for a "relaxing massage", an empty list made the
      // model tell the client the salon did no massages.
      const result = await svc.listServices({ prisma, tenantId: TENANT_ID }, {
        keyword: 'relaxing massage',
      });
      expect(result.services.map((s: any) => s.id)).toContain('s-massage-rel');
      expect(result.totalMatching).toBe(0);
      expect(result.note).toMatch(/full catalogue/);
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

  describe('prices quoted to clients', () => {
    const withFiscal = (fiscalSettings: unknown) =>
      makePrisma(SAMPLE_SERVICES, SAMPLE_PROFESSIONALS, { ...SAMPLE_TENANT, fiscalSettings });

    it('a catalogue that includes the IVA is quoted as stored, and says the IVA is included', async () => {
      const list = await svc.listServices({ prisma, tenantId: TENANT_ID }, {});
      expect(list.services.find((s: any) => s.id === 's-cut-w')?.price).toBe('45.00');
      expect(list.priceNote).toContain('IVA included');
      expect(list.priceNote).toContain('IVA incluido');
      expect(list.taxIncluded).toBe('IVA incluido');
      const one = await svc.getService({ prisma, tenantId: TENANT_ID }, { serviceId: 's-cut-m' });
      expect(one).toMatchObject({ price: '18.00', priceNote: expect.stringContaining('IVA incluido') });
    });

    it('a net catalogue is quoted with the IVA the invoice adds: 45,00 -> 54,45', async () => {
      const net = withFiscal({ pricesIncludeTax: false, defaultTaxRate: 21 });
      const list = await svc.listServices({ prisma: net, tenantId: TENANT_ID }, {});
      expect(list.services.find((s: any) => s.id === 's-cut-w')?.price).toBe('54.45');
      expect(list.services.find((s: any) => s.id === 's-cut-m')?.price).toBe('21.78');
      const one = await svc.getService({ prisma: net, tenantId: TENANT_ID }, { serviceId: 's-cut-m' });
      expect(one).toMatchObject({ price: '21.78', taxIncluded: 'IVA incluido' });
      expect(net.tenant.findUnique).toHaveBeenCalledWith({
        where: { id: TENANT_ID },
        select: { fiscalSettings: true },
      });
    });

    it('a salon from before the setting (no key) is net too, as its invoices are', async () => {
      const legacy = withFiscal(undefined);
      const one = await svc.getService({ prisma: legacy, tenantId: TENANT_ID }, { serviceId: 's-cut-m' });
      expect(one).toMatchObject({ price: '21.78', priceNote: expect.stringContaining('IVA') });
    });

    it('a Canarian salon is quoted with IGIC and says so', async () => {
      const canary = withFiscal({ pricesIncludeTax: false, defaultTaxRate: 7, taxRegime: 'igic' });
      const list = await svc.listServices({ prisma: canary, tenantId: TENANT_ID }, { keyword: 'relaxing massage' });
      expect(list.totalMatching).toBe(0);
      expect(list.services.find((s: any) => s.id === 's-cut-m')?.price).toBe('19.26');
      expect(list.priceNote).toContain('IGIC incluido');
      expect(list.taxIncluded).toBe('IGIC incluido');
      expect(list.priceNote).not.toContain('IVA');
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

    it('says which services each professional can be booked for', async () => {
      // The bio is free text and may disagree with the diary; "who does
      // massages" must follow the services assigned.
      prisma.professional.findMany.mockResolvedValueOnce([
        {
          ...SAMPLE_PROFESSIONALS[0],
          services: [
            { service: { name: 'Masaje Relajante', isActive: true } },
            { service: { name: 'Servicio retirado', isActive: false } },
          ],
        },
      ]);
      const result = await svc.listProfessionals({ prisma, tenantId: TENANT_ID }, {});
      expect(result.professionals[0].services).toEqual(['Masaje Relajante']);
    });

    it('answers "who does X" from the services assigned, not the bio', async () => {
      // Carmen's bio says massages; only Ana is assigned them.
      prisma.professional.findMany.mockResolvedValueOnce([
        { ...SAMPLE_PROFESSIONALS[0], id: 'p-ana', bio: 'Manicura', services: [{ service: { name: 'Masaje Relajante', isActive: true } }] },
        { ...SAMPLE_PROFESSIONALS[1], id: 'p-carmen', bio: 'Especializada en masajes terapéuticos', services: [] },
      ]);
      const result = await svc.listProfessionals({ prisma, tenantId: TENANT_ID }, { specialty: 'masajes' });
      expect(result.professionals.map((p: any) => p.id)).toEqual(['p-ana']);
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
        undefined,
        undefined,
        { onlineWindow: true },
      );
    });

    it('asks only for slots inside the online booking window', async () => {
      // A slot inside the service's minimum notice is one a booking would
      // refuse; the receptionist must not offer it.
      await svc.checkAvailability(
        { prisma, tenantId: TENANT_ID, appointmentsService: appointments },
        { serviceId: 's-cut-m', date: '2026-09-01' },
      );
      expect(appointments.getAvailableSlots.mock.calls[0][6]).toEqual({ onlineWindow: true });
    });

    it('says why a day beyond the online booking window has no slots', async () => {
      const outside = {
        getAvailableSlots: jest.fn().mockResolvedValue([]),
        onlineBookingWindow: jest.fn().mockResolvedValue({ timeZone: 'Europe/Madrid', minHours: 2, maxHours: 30 * 24 }),
        fitsOnlineWindow: jest.fn().mockReturnValue('too-far'),
      };
      const result: any = await svc.checkAvailability(
        { prisma, tenantId: TENANT_ID, appointmentsService: outside as any },
        { serviceId: 's-massage-rel', date: '2026-12-15' },
      );
      expect(result.slots).toEqual([]);
      expect(result.reason).toBe('beyond_online_window');
      expect(result.message).toMatch(/up to \d{4}-\d{2}-\d{2}\./);
    });

    it('adds no reason when the day is simply full or closed', async () => {
      const full = {
        getAvailableSlots: jest.fn().mockResolvedValue([]),
        onlineBookingWindow: jest.fn().mockResolvedValue({ timeZone: 'Europe/Madrid', minHours: 2, maxHours: 720 }),
        fitsOnlineWindow: jest.fn().mockReturnValue('ok'),
      };
      const result: any = await svc.checkAvailability(
        { prisma, tenantId: TENANT_ID, appointmentsService: full as any },
        { serviceId: 's-massage-rel', date: '2026-10-04' },
      );
      expect(result).toEqual({ date: '2026-10-04', serviceId: 's-massage-rel', slots: [] });
    });

    describe('with time off recorded', () => {
      const none = {
        getAvailableSlots: jest.fn().mockResolvedValue([]),
        onlineBookingWindow: jest.fn().mockResolvedValue({ timeZone: 'Europe/Madrid', minHours: 2, maxHours: 720 }),
        fitsOnlineWindow: jest.fn().mockReturnValue('ok'),
      };
      const day = new Date('2026-12-25T00:00:00.000Z');
      const withTimeOff = (rows: any[]) =>
        ({ ...prisma, timeOff: { findMany: jest.fn().mockResolvedValue(rows) } }) as any;
      const closure = { professionalId: null, kind: 'closure', startDate: day, endDate: day, startTime: null, endTime: null, note: 'Navidad' };

      it('says the salon is closed that day, without the note', async () => {
        const result: any = await svc.checkAvailability(
          { prisma: withTimeOff([closure]), tenantId: TENANT_ID, appointmentsService: none as any },
          { serviceId: 's-cut-m', date: '2026-12-25' },
        );
        expect(result.slots).toEqual([]);
        expect(result.reason).toBe('salon_closed');
        expect(result.message).toMatch(/closed all day on 2026-12-25/);
        expect(result.message).not.toMatch(/Navidad/);
      });

      it('says the named professional is away, never why', async () => {
        const away = { ...closure, professionalId: 'p-ana', kind: 'sick_leave', note: 'Operación' };
        const result: any = await svc.checkAvailability(
          { prisma: withTimeOff([away]), tenantId: TENANT_ID, appointmentsService: none as any },
          { serviceId: 's-cut-m', date: '2026-12-25', professionalId: 'p-ana' },
        );
        expect(result.reason).toBe('professional_unavailable');
        expect(result.message).not.toMatch(/Operación|baja|sick/i);
      });

      it('a partial closure is not called a closed day', async () => {
        const evening = { ...closure, startTime: '14:00', endTime: '20:00' };
        const result: any = await svc.checkAvailability(
          { prisma: withTimeOff([evening]), tenantId: TENANT_ID, appointmentsService: none as any },
          { serviceId: 's-cut-m', date: '2026-12-25' },
        );
        expect(result.reason).toBeUndefined();
      });
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
        name: 'Kira Room Test',
        city: 'Madrid',
        phone: '+34123456789',
        currency: 'EUR',
        assistantName: 'Kira',
      });
      expect('error' in result).toBe(false);
      if (!('error' in result)) {
        // The legacy { open, close } is that window every day.
        expect(result.openingHours?.monday).toEqual(['09:00–20:00']);
        expect(result.openingHours?.sunday).toEqual(['09:00–20:00']);
      }
    });

    it("gives the salon's week with its shifts and closed days", async () => {
      const split = makePrisma([], [], {
        ...SAMPLE_TENANT,
        openingHours: [
          { day: 'monday', openTime: '10:00', closeTime: '14:00' },
          { day: 'monday', openTime: '17:00', closeTime: '20:00' },
        ],
      });
      const result = await svc.getSalonInfo({ prisma: split, tenantId: TENANT_ID });
      expect('error' in result).toBe(false);
      if (!('error' in result)) {
        expect(result.openingHours?.monday).toEqual(['10:00–14:00', '17:00–20:00']);
        expect(result.openingHours?.sunday).toEqual([]);
      }
    });

    it('says null when neither the salon nor anyone has hours', async () => {
      const none = makePrisma([], [], { ...SAMPLE_TENANT, openingHours: {} });
      const result = await svc.getSalonInfo({ prisma: none, tenantId: TENANT_ID });
      expect('error' in result ? undefined : result.openingHours).toBeNull();
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