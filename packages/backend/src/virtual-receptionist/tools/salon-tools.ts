import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AppointmentsService } from '../../appointments/appointments.service';

/**
 * Tools the Virtual Receptionist exposes to the LLM.
 *
 * Every entry in `SALON_TOOLS` is sent to the model so it can ground
 * answers in real database data. The corresponding `executeSalonTool`
 * implementation MUST be the only path that produces the value of a
 * given field — the LLM is forbidden from inventing prices, durations,
 * professionals, or availability that did not come back through these
 * tool calls.
 */

export type Audience = 'male' | 'female' | 'child';

export interface SalonToolContext {
  prisma: PrismaService;
  tenantId: string;
  appointmentsService?: AppointmentsService;
}

/* -------------------------------------------------------------------------- */
/*  Tool definitions (sent to the LLM)                                       */
/* -------------------------------------------------------------------------- */

export const SALON_TOOLS = [
  {
    name: 'list_services',
    description:
      'List the salon\'s active services. Use this whenever the user asks about ' +
      'the catalog, available services, or wants to see prices. Returns up to 25 ' +
      'services. For exact price / duration of one service, prefer `get_service`.',
    input_schema: {
      type: 'object' as const,
      properties: {
        audience: {
          type: 'string',
          enum: ['male', 'female', 'child'],
          description:
            'Optional. Filter by target audience inferred from the user message ' +
            '(e.g. "corte para hombre" -> "male", "para mi hija" -> "child").',
        },
        keyword: {
          type: 'string',
          description:
            'Optional. Free-text token that must appear in the service name or ' +
            'description (accent-insensitive).',
        },
        limit: {
          type: 'number',
          description: 'Max results to return. Default 25, max 50.',
        },
      },
    },
  },
  {
    name: 'get_service',
    description:
      'Get a single service by its id. Returns name, description, price, duration, ' +
      'currency and category. Use this when the user names a specific service ' +
      '("cuánto cuesta la coloración completa") and you have the id from a ' +
      'previous `list_services` call.',
    input_schema: {
      type: 'object' as const,
      properties: {
        serviceId: {
          type: 'string',
          description: 'Service UUID returned by `list_services`.',
        },
      },
      required: ['serviceId'],
    },
  },
  {
    name: 'list_professionals',
    description:
      'List the salon\'s active professionals. Use when the user asks who works ' +
      'at the salon, their specialties, languages, or experience.',
    input_schema: {
      type: 'object' as const,
      properties: {
        specialty: {
          type: 'string',
          description: 'Optional. Specialty token to filter by (accent-insensitive).',
        },
        language: {
          type: 'string',
          description: 'Optional. ISO 639-1 code (e.g. "es", "en") to filter by.',
        },
      },
    },
  },
  {
    name: 'check_availability',
    description:
      'Get available appointment slots for a service on a given date. Returns ' +
      'an array of HH:mm strings. Use when the user asks "qué huecos tienes ' +
      'mañana" or similar. Service id MUST come from a previous `list_services` ' +
      'or `get_service` call.',
    input_schema: {
      type: 'object' as const,
      properties: {
        serviceId: {
          type: 'string',
          description: 'Service UUID.',
        },
        date: {
          type: 'string',
          description: 'ISO date YYYY-MM-DD (interpreted in the salon\'s timezone).',
        },
        professionalId: {
          type: 'string',
          description: 'Optional professional UUID to scope the search.',
        },
      },
      required: ['serviceId', 'date'],
    },
  },
  {
    name: 'get_salon_info',
    description:
      'Return salon-level details: name, address, phone, email, opening hours, ' +
      'currency and timezone. Use when the user asks for contact info, location ' +
      'or general salon details.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
] as const;

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function normalize(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function detectAudienceFromService(name: string, description?: string | null): Audience | null {
  const text = `${name} ${description ?? ''}`;
  if (/\b(nin[oa]|infantil|kids?|bebe)\b/i.test(text)) return 'child';
  if (/\b(hombre|hombres|caballero|caballeros|varon|chico|masculin[oa]?)\b/i.test(text)) return 'male';
  if (/\b(mujer|mujeres|damas|senora|senorita|senoras|femenin[oa]?|chica)\b/i.test(text)) return 'female';
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Tool implementations                                                     */
/* -------------------------------------------------------------------------- */

@Injectable()
export class SalonToolsService {
  private readonly logger = new Logger(SalonToolsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly appointmentsService: AppointmentsService,
  ) {}

  async listServices(
    ctx: SalonToolContext,
    input: {
      audience?: Audience;
      keyword?: string;
      limit?: number;
    },
  ): Promise<{
    services: Array<{
      id: string;
      name: string;
      description: string | null;
      category: string;
      durationMinutes: number;
      price: string;
      currency: string;
    }>;
    totalMatching: number;
    note?: string;
  }> {
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 50);
    // P2A-receptionist-tools: we deliberately don't pass `category`
    // to Prisma. The LLM has been seen to invent non-enum values like
    // "Cabello" or "Peluqueria" that Prisma rejects with
    // `PrismaClientValidationError: Invalid value for argument
    // \`category\`. Expected ServiceCategory.` — and the error
    // message was empty in earlier runs, making the failure silent.
    // Instead we filter by keyword in-memory below, which is robust
    // to any string the model produces.
    const services = await ctx.prisma.service.findMany({
      where: {
        tenantId: ctx.tenantId,
        isActive: true,
      },
      orderBy: [{ category: 'asc' }, { price: 'asc' }],
      take: limit * 4,
      select: {
        id: true,
        name: true,
        description: true,
        category: true,
        duration: true,
        price: true,
        currency: true,
      },
    });

    const keyword = input.keyword ? normalize(input.keyword) : null;
    const filtered = services.filter((s) => {
      if (keyword) {
        const haystack = `${normalize(s.name)} ${normalize(s.description ?? '')}`;
        if (!haystack.includes(keyword)) return false;
      }
      if (input.audience) {
        const svcAudience = detectAudienceFromService(s.name, s.description);
        if (svcAudience && svcAudience !== input.audience) return false;
      }
      return true;
    });

    return {
      services: filtered.slice(0, limit).map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        category: s.category,
        durationMinutes: s.duration,
        price: Number(s.price).toFixed(2),
        currency: s.currency,
      })),
      totalMatching: filtered.length,
      ...(input.audience
        ? { note: `Filtered for audience="${input.audience}".` }
        : {}),
    };
  }

  async getService(
    ctx: SalonToolContext,
    input: { serviceId: string },
  ): Promise<{
    id: string;
    name: string;
    description: string | null;
    category: string;
    durationMinutes: number;
    price: string;
    currency: string;
    onlineBookable: boolean;
  } | { error: string; serviceId: string }> {
    const service = await ctx.prisma.service.findFirst({
      where: { id: input.serviceId, tenantId: ctx.tenantId, isActive: true },
      select: {
        id: true,
        name: true,
        description: true,
        category: true,
        duration: true,
        price: true,
        currency: true,
        isOnlineBookable: true,
      },
    });
    if (!service) return { error: 'service_not_found', serviceId: input.serviceId };
    return {
      id: service.id,
      name: service.name,
      description: service.description,
      category: service.category,
      durationMinutes: service.duration,
      price: Number(service.price).toFixed(2),
      currency: service.currency,
      onlineBookable: service.isOnlineBookable,
    };
  }

  async listProfessionals(
    ctx: SalonToolContext,
    input: { specialty?: string; language?: string },
  ): Promise<{
    professionals: Array<{
      id: string;
      fullName: string;
      position: string | null;
      isOwner: boolean;
      specialties: unknown;
      yearsExperience: number | null;
      languages: unknown;
      bio: string | null;
    }>;
    totalMatching: number;
  }> {
    const professionals = await ctx.prisma.professional.findMany({
      where: { tenantId: ctx.tenantId, isActive: true },
      orderBy: [{ isOwner: 'desc' }, { firstName: 'asc' }],
      select: {
        id: true,
        firstName: true,
        lastName: true,
        position: true,
        bio: true,
        profileImage: true,
        specialties: true,
        yearsExperience: true,
        languages: true,
        isOwner: true,
      },
    });

    const specialty = input.specialty ? normalize(input.specialty) : null;
    const language = input.language ? normalize(input.language) : null;

    const filtered = professionals.filter((p) => {
      if (specialty) {
        const specs = (p.specialties as string[]) ?? [];
        const haystack = normalize([p.position ?? '', p.bio ?? '', ...specs].join(' '));
        if (!haystack.includes(specialty)) return false;
      }
      if (language) {
        const langs = ((p.languages as string[]) ?? []).map(normalize);
        if (!langs.includes(language)) return false;
      }
      return true;
    });

    return {
      professionals: filtered.map((p) => ({
        id: p.id,
        fullName: `${p.firstName} ${p.lastName}`.trim(),
        position: p.position,
        isOwner: p.isOwner,
        specialties: p.specialties,
        yearsExperience: p.yearsExperience,
        languages: p.languages,
        bio: p.bio,
      })),
      totalMatching: filtered.length,
    };
  }

  async checkAvailability(
    ctx: SalonToolContext,
    input: { serviceId: string; date: string; professionalId?: string },
  ): Promise<
    | { date: string; serviceId: string; slots: Array<{ time: string }> }
    | { error: string; date?: string; message?: string }
  > {
    if (!ctx.appointmentsService) {
      return { error: 'appointments_service_unavailable' };
    }
    const date = new Date(`${input.date}T00:00:00`);
    if (Number.isNaN(date.getTime())) {
      return { error: 'invalid_date', date: input.date };
    }
    try {
      const slots = await ctx.appointmentsService.getAvailableSlots(
        ctx.tenantId,
        date,
        input.professionalId,
        input.serviceId,
      );
      // AppointmentsService returns objects with a `time` field; the
      // chatbot only needs the HH:mm strings, so flatten before
      // returning so the LLM sees a simpler shape.
      const flat = (slots ?? []).map((s: any) =>
        typeof s === 'string' ? s : s?.time,
      ).filter((t: unknown): t is string => typeof t === 'string');
      return { date: input.date, serviceId: input.serviceId, slots: flat as any };
    } catch (err) {
      this.logger.warn(
        `checkAvailability failed tenant=${ctx.tenantId} date=${input.date}: ${(err as Error).message}`,
      );
      return { error: 'availability_check_failed', message: (err as Error).message };
    }
  }

  async getSalonInfo(
    ctx: SalonToolContext,
  ): Promise<
    | {
        name: string;
        description: string | null;
        email: string | null;
        phone: string | null;
        whatsapp: string | null;
        street: string | null;
        city: string | null;
        state: string | null;
        postalCode: string | null;
        country: string;
        timezone: string;
        currency: string;
        openingHours: unknown;
        assistantName: string;
      }
    | { error: string }
  > {
    const tenant = await ctx.prisma.tenant.findUnique({
      where: { id: ctx.tenantId },
      select: {
        name: true,
        description: true,
        email: true,
        phone: true,
        whatsapp: true,
        street: true,
        city: true,
        state: true,
        postalCode: true,
        country: true,
        timezone: true,
        currency: true,
        openingHours: true,
        assistantName: true,
      },
    });
    if (!tenant) return { error: 'tenant_not_found' };
    return tenant;
  }
}

/**
 * Route a tool name + input to the right implementation. Returns
 * `{ error }` payloads (not thrown errors) so the LLM can self-correct.
 */
export async function executeSalonTool(
  service: SalonToolsService,
  name: string,
  input: unknown,
  ctx: SalonToolContext,
): Promise<Record<string, unknown>> {
  const args = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case 'list_services':
      return service.listServices(ctx, args as any);
    case 'get_service':
      return service.getService(ctx, args as any);
    case 'list_professionals':
      return service.listProfessionals(ctx, args as any);
    case 'check_availability':
      return service.checkAvailability(ctx, args as any);
    case 'get_salon_info':
      return service.getSalonInfo(ctx);
    default:
      return { error: `unknown_tool:${name}` };
  }
}