import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AppointmentsService } from '../../appointments/appointments.service';
import { confirmAppointment, notBookableOnline, proposeAppointment } from './receptionist-booking';
import { resolveIds } from './resolve-ids';
import { locationOption, resolveLocation, salonPlaces } from './receptionist-locations';
import { professionalLocationsOf } from '../../multi-location/client-locations';
import { clientPrices, clientPriceText, priceNote } from './client-prices';
import { taxIncludedNote } from '../../common/public-price';
import { dayBlocks, salonClosedOn } from '../../time-off/time-off-rules';
import { timeOffBetween } from '../../time-off/time-off-query';
import { salonOpenShifts } from '../../appointments/working-hours';

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
  /** The conversation the tools run in; booking needs it. */
  conversation?: {
    id: string;
    clientId?: string | null;
    /** The client's message this turn answers. */
    lastUserMessage: string;
    channel?: string;
    externalUserId?: string;
  };
}

/* -------------------------------------------------------------------------- */
/*  Tool definitions (sent to the LLM)                                       */
/* -------------------------------------------------------------------------- */

/**
 * The location of a check or a booking, for salons with several (multi-local;
 * receptionist-locations.ts). Single-location salons ignore it.
 */
const LOCATION_INPUT = {
  type: 'string',
  description:
    'Only when the salon has several locations (get_salon_info lists them): the id or name of the ' +
    'location the client wants. Left out, it is taken from the client\'s message or from the professional; ' +
    'when it cannot be, the tool answers location_required and you ask the client.',
} as const;

export const SALON_TOOLS = [
  {
    name: 'list_services',
    description:
      'List the salon\'s active services. Use this whenever the user asks about ' +
      'the catalog, available services, or wants to see prices. Returns up to 25 ' +
      'services. For exact price / duration of one service, prefer `get_service`. ' +
      'Prices are final, tax included (see priceNote). ' +
      'A service with onlineBookable: false is not booked by chat: the client books it ' +
      'by calling the salon.',
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
      'currency and category; the price is final, tax included (see priceNote). ' +
      'Use this when the user names a specific service ' +
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
      'at the salon, their specialties, languages, or experience. `services` is ' +
      'what each one can be booked for: to answer "who does X", use it, not the ' +
      'bio or specialties.',
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
          description: "Service id from list_services, or the service's exact name.",
        },
        date: {
          type: 'string',
          description: 'ISO date YYYY-MM-DD (interpreted in the salon\'s timezone).',
        },
        professionalId: {
          type: 'string',
          description: 'Optional professional id or full name to scope the search.',
        },
        locationId: LOCATION_INPUT,
      },
      required: ['serviceId', 'date'],
    },
  },
  {
    name: 'propose_appointment',
    description:
      'Step 1 of booking. Once you have service, date, time, first name, last ' +
      'name and phone (email only if they gave one), call this with them. It validates the details, checks ' +
      'the slot can be booked, and records the proposal. Then show the client ' +
      'the summary and ask them to confirm. Ids MUST come from list_services / ' +
      'list_professionals, the time from check_availability. Call it again if ' +
      'the client changes anything.',
    input_schema: {
      type: 'object' as const,
      properties: {
        serviceId: { type: 'string', description: "Service id from list_services, or the service's exact name." },
        professionalId: {
          type: 'string',
          description: 'Professional id or full name, or omit for whoever is free.',
        },
        date: { type: 'string', description: 'YYYY-MM-DD, salon timezone.' },
        time: { type: 'string', description: 'HH:MM, a slot check_availability returned.' },
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        phone: { type: 'string', description: 'Required: how the salon reaches them about a change. Ask the client for it.' },
        email: { type: 'string', description: 'Optional. Only if the client gives it.' },
        notes: { type: 'string' },
        locationId: LOCATION_INPUT,
      },
      required: ['serviceId', 'date', 'time', 'firstName', 'lastName', 'phone'],
    },
  },
  {
    name: 'create_appointment',
    description:
      'Step 2 of booking. Books the proposal recorded by propose_appointment -- ' +
      'it takes no details. Call it when the client has replied yes to the ' +
      'summary. The server checks that reply itself and refuses otherwise. ' +
      'Only created: true means the appointment exists.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'get_salon_info',
    description:
      'Return salon-level details: name, address, phone, email, opening hours, ' +
      'currency and timezone. Use when the user asks for contact info, location ' +
      'or general salon details. A salon with several locations also returns ' +
      '`locations` (id, name, address, phone): ask the client which one when booking.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
] as const;

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

const WEEK_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

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
      onlineBookable: boolean;
    }>;
    totalMatching: number;
    note?: string;
    /** The prices are final, tax included: client-prices.ts. */
    priceNote: string;
    /** "IVA incluido" (IGIC, IPSI): what to say next to them. */
    taxIncluded: string;
  }> {
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 50);
    const prices = await clientPrices(ctx);
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
        isOnlineBookable: true,
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

    // A keyword that matches nothing is not "the salon has none". Asked in
    // English for a "relaxing massage", the search found no Spanish name
    // containing it and the model told the client the salon did no
    // massages. Return the whole catalogue and say the keyword missed.
    if (keyword && filtered.length === 0) {
      const all = services.filter((s) => {
        if (!input.audience) return true;
        const svcAudience = detectAudienceFromService(s.name, s.description);
        return !svcAudience || svcAudience === input.audience;
      });
      return {
        services: all.slice(0, limit).map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          category: s.category,
          durationMinutes: s.duration,
          price: clientPriceText(s.price, prices),
          currency: s.currency,
          onlineBookable: s.isOnlineBookable !== false,
        })),
        totalMatching: 0,
        priceNote: priceNote(prices),
        taxIncluded: taxIncludedNote(prices),
        note:
          `No service name or description contains "${input.keyword}". This is the full catalogue: ` +
          'look for what the client means in it (names may be in another language) before saying the salon does not offer it.',
      };
    }

    return {
      services: filtered.slice(0, limit).map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        category: s.category,
        durationMinutes: s.duration,
        price: clientPriceText(s.price, prices),
        currency: s.currency,
        onlineBookable: s.isOnlineBookable !== false,
      })),
      totalMatching: filtered.length,
      priceNote: priceNote(prices),
      taxIncluded: taxIncludedNote(prices),
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
    priceNote: string;
    taxIncluded: string;
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
    const prices = await clientPrices(ctx);
    return {
      id: service.id,
      name: service.name,
      description: service.description,
      category: service.category,
      durationMinutes: service.duration,
      price: clientPriceText(service.price, prices),
      currency: service.currency,
      onlineBookable: service.isOnlineBookable,
      priceNote: priceNote(prices),
      taxIncluded: taxIncludedNote(prices),
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
      services: string[];
      /** The locations they work at, when the salon has several. */
      locations?: string[];
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
        services: { select: { service: { select: { name: true, isActive: true } } } },
      },
    });

    // "masajes" must find "Masaje Relajante": compare without a plural ending.
    const specialty = input.specialty ? normalize(input.specialty).trim().replace(/(es|s)$/, '') : null;
    const language = input.language ? normalize(input.language) : null;

    // The services a professional is assigned decide who does what; the bio
    // and specialties are free text and can disagree. Asked who does
    // massages, the text search found Carmen -- whose bio mentions them --
    // while only Ana is assigned massages and is who a booking gets. So
    // when the assigned services answer the question, they are the answer.
    const assigned = (p: any): string =>
      normalize(
        ((p.services ?? []) as any[])
          .filter((ps) => ps.service?.isActive)
          .map((ps) => ps.service.name)
          .join(' | '),
      );
    const byService = specialty ? professionals.filter((p) => assigned(p).includes(specialty)) : [];

    const filtered = professionals.filter((p) => {
      if (specialty) {
        if (byService.length > 0) {
          if (!byService.includes(p)) return false;
        } else {
          const specs = (p.specialties as string[]) ?? [];
          const haystack = normalize([p.position ?? '', p.bio ?? '', ...specs].join(' '));
          if (!haystack.includes(specialty)) return false;
        }
      }
      if (language) {
        const langs = ((p.languages as string[]) ?? []).map(normalize);
        if (!langs.includes(language)) return false;
      }
      return true;
    });

    // Where each works, when the salon has several locations to book at.
    const places = await salonPlaces(ctx);
    const placeNames = (id: string) =>
      professionalLocationsOf(id, places.locations, places.links).locationIds.map(
        (lid) => places.locations.find((l) => l.id === lid)!.name,
      );

    return {
      professionals: filtered.map((p) => ({
        ...(places.locations.length > 0 ? { locations: placeNames(p.id) } : {}),
        id: p.id,
        fullName: `${p.firstName} ${p.lastName}`.trim(),
        position: p.position,
        isOwner: p.isOwner,
        specialties: p.specialties,
        yearsExperience: p.yearsExperience,
        languages: p.languages,
        bio: p.bio,
        // What the diary will book them for. The bio and specialties are free
        // text and can say otherwise: in the test salon Carmen's bio mentions
        // massages, but only Ana is assigned them, and the model told a client
        // Carmen does the massages.
        services: ((p as any).services ?? [])
          .filter((ps: any) => ps.service?.isActive)
          .map((ps: any) => ps.service.name),
      })),
      totalMatching: filtered.length,
    };
  }

  async checkAvailability(
    ctx: SalonToolContext,
    input: { serviceId: string; date: string; professionalId?: string; locationId?: string },
  ): Promise<
    | {
        date: string;
        serviceId: string;
        locationId?: string;
        slots: Array<{ time: string }>;
        reason?: string;
        message?: string;
      }
    | { error: string; date?: string; message?: string }
  > {
    if (!ctx.appointmentsService) {
      return { error: 'appointments_service_unavailable' };
    }
    // UTC midnight, like every other caller of getAvailableSlots. Local
    // midnight on a server west or east of UTC is the previous or next UTC
    // day, so this offered one day's slots under another day's name.
    const date = new Date(`${input.date}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime())) {
      return { error: 'invalid_date', date: input.date };
    }
    // Not offered online: no times for it, and the model is told why.
    const closed = await notBookableOnline(ctx, input.serviceId);
    if (closed) return { ...closed, date: input.date };
    // Which location these times are at, so the model can say so.
    const here = input.locationId ? { locationId: input.locationId } : {};
    try {
      // Only what a booking will accept: not inside the service's minimum
      // notice, not beyond its maximum advance, not in the past.
      const slots = await ctx.appointmentsService.getAvailableSlots(
        ctx.tenantId,
        date,
        input.professionalId,
        input.serviceId,
        undefined,
        undefined,
        // At that location only, when the salon has several (resolveLocation).
        { onlineWindow: true, ...(input.locationId ? { locationId: input.locationId } : {}) },
      );
      // AppointmentsService returns objects with a `time` field; the
      // chatbot only needs the HH:mm strings, so flatten before
      // returning so the LLM sees a simpler shape.
      const flat = (slots ?? []).map((s: any) =>
        typeof s === 'string' ? s : s?.time,
      ).filter((t: unknown): t is string => typeof t === 'string');
      if (flat.length === 0) {
        const why = await this.whyNoSlots(ctx, input.serviceId, input.date, input.professionalId);
        if (why) return { date: input.date, serviceId: input.serviceId, ...here, slots: [], ...why };
      }
      return { date: input.date, serviceId: input.serviceId, ...here, slots: flat as any };
    } catch (err) {
      this.logger.warn(
        `checkAvailability failed tenant=${ctx.tenantId} date=${input.date}: ${(err as Error).message}`,
      );
      return { error: 'availability_check_failed', message: (err as Error).message };
    }
  }

  /**
   * Why a day has no slots, when the reason is a salon closure, the named
   * professional's time off, or the online booking window. An empty list
   * alone left the model guessing: asked for 15 December, it said its
   * calendar "only reaches 13 October" -- the two-week date list in the
   * prompt -- and suggested booking a nearer date and changing it later.
   *
   * Never the note or the kind of an absence: the client reads what the model
   * makes of this, and why a stylist is away is not theirs to know.
   */
  private async whyNoSlots(
    ctx: SalonToolContext,
    serviceId: string,
    date: string,
    professionalId?: string,
  ): Promise<{ reason: string; message: string } | null> {
    const closures = await this.timeOffOn(ctx, date);
    if (salonClosedOn(closures, date)) {
      return {
        reason: 'salon_closed',
        message: `The salon is closed all day on ${date}. Tell the client it is closed that day and offer another day.`,
      };
    }
    if (professionalId && dayBlocks(closures, date, professionalId).allDay) {
      return {
        reason: 'professional_unavailable',
        message: `That professional is not available on ${date}. Offer another day, or another professional who does this service.`,
      };
    }
    const appointments = ctx.appointmentsService as any;
    if (typeof appointments?.onlineBookingWindow !== 'function') return null;
    const window = await appointments.onlineBookingWindow(ctx.tenantId, serviceId);
    if (!window) return null;
    if (appointments.fitsOnlineWindow(date, '00:00', window) === 'too-far') {
      const last = new Intl.DateTimeFormat('en-CA', { timeZone: window.timeZone }).format(
        new Date(Date.now() + window.maxHours * 3_600_000),
      );
      return {
        reason: 'beyond_online_window',
        message: `This service can be booked online up to ${last}. For a later date the client must contact the salon.`,
      };
    }
    if (appointments.fitsOnlineWindow(date, '23:59', window) === 'too-soon') {
      return {
        reason: 'too_soon',
        message: `This service needs at least ${window.minHours} hours' notice to book online. Offer a later day, or the salon's phone.`,
      };
    }
    return null;
  }

  /** The salon's time off and closures on `date`; none when it cannot be read. */
  private async timeOffOn(ctx: SalonToolContext, date: string) {
    try {
      return await timeOffBetween(ctx.prisma as any, ctx.tenantId, date);
    } catch (err) {
      // Only the explanation is lost: availability itself already read it.
      this.logger.warn(`timeOffOn failed tenant=${ctx.tenantId} date=${date}: ${(err as Error).message}`);
      return [];
    }
  }

  /** Step 1 of booking; see receptionist-booking.ts. */
  async proposeAppointment(
    ctx: SalonToolContext,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return proposeAppointment(ctx, input);
  }

  /** Step 2 of booking; see receptionist-booking.ts. */
  async createAppointment(ctx: SalonToolContext): Promise<Record<string, unknown>> {
    return confirmAppointment(ctx);
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
        /**
         * Per weekday ("monday"...), the open stretches as "HH:MM–HH:MM"; an
         * empty list is a day the salon is closed. null when no hours are
         * recorded at all, so the model says it does not know rather than
         * inventing them.
         */
        openingHours: Record<string, string[]> | null;
        assistantName: string;
        /** Only for a salon with several locations to book at. */
        locations?: Array<{ id: string; name: string; address: string | null; phone: string | null }>;
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
    // The same week the prompt carries: the salon's own hours when it set
    // them, else its professionals' schedules. The raw column used to be
    // returned, in whichever of its stored shapes it happened to be.
    const professionals = await ctx.prisma.professional.findMany({
      where: { tenantId: ctx.tenantId, isActive: true },
      select: { workingHours: true },
    });
    const shifts = salonOpenShifts(tenant.openingHours, professionals);
    const openingHours =
      Object.keys(shifts).length === 0
        ? null
        : Object.fromEntries(
            WEEK_DAYS.map((day) => [day, (shifts[day] ?? []).map((w) => `${w.openTime}–${w.closeTime}`)]),
          );
    // Several locations to book at: each with its address and phone, so the
    // model can say where they are and ask which one when booking.
    const { locations } = await salonPlaces(ctx);
    return {
      ...tenant,
      openingHours,
      ...(locations.length > 0
        ? { locations: locations.map((l) => ({ ...locationOption(l), phone: l.phone })) }
        : {}),
    };
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
  let args = (input ?? {}) as Record<string, unknown>;
  if (name === 'get_service' || name === 'check_availability' || name === 'propose_appointment') {
    const resolved = await resolveIds(ctx, args);
    if (resolved.error) return resolved.error;
    args = resolved.args!;
  }
  // Which location, for a salon with several: given, said by the client,
  // or the professional's; else the model is told to ask.
  if (name === 'check_availability' || name === 'propose_appointment') {
    const located = await resolveLocation(ctx, args);
    if (located.error) return located.error;
    args = located.args!;
  }
  switch (name) {
    case 'list_services':
      return service.listServices(ctx, args as any);
    case 'get_service':
      return service.getService(ctx, args as any);
    case 'list_professionals':
      return service.listProfessionals(ctx, args as any);
    case 'check_availability':
      return service.checkAvailability(ctx, args as any);
    case 'propose_appointment':
      return service.proposeAppointment(ctx, args);
    case 'create_appointment':
      return service.createAppointment(ctx);
    case 'get_salon_info':
      return service.getSalonInfo(ctx);
    default:
      return { error: `unknown_tool:${name}` };
  }
}