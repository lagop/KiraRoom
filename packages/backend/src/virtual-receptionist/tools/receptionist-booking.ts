import { HttpException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync, ValidationError } from 'class-validator';
import { OnlineBookingDto } from '../../appointments/dto/book-appointment.dto';
import type { SalonToolContext } from './salon-tools';
import { clientPrices, clientPriceText } from './client-prices';
import { taxIncludedNote } from '../../common/public-price';
import { samePhone } from '../../common/phone';
import { locationLabel } from './receptionist-locations';

/**
 * How the virtual receptionist books, in two steps the server enforces.
 *
 * 1. propose_appointment: validates the details, checks the slot is
 *    bookable online, and stores them on the conversation as the pending
 *    booking. The model shows the summary.
 * 2. create_appointment: books THAT stored proposal -- it takes no details
 *    -- and only when the client has written a new message since the
 *    proposal and that message is a yes.
 *
 * A single create_appointment with the details and a model-supplied
 * `clientConfirmed: true` was the first version. Nothing checked the
 * client's actual reply, and nothing stopped a second call from booking
 * again: with "whoever is free", the next free professional and a
 * duplicate appointment.
 */

/** Bookings one conversation may make, and one client (phone or email) may make by chat per day. */
export const MAX_BOOKINGS_PER_CONVERSATION = 2;
export const MAX_CHAT_BOOKINGS_PER_EMAIL_PER_DAY = 3;

/**
 * How long a summary can wait for its "sí". Older than this, a yes no longer
 * books it: the slot may have gone and the client may be answering something
 * else entirely.
 */
export const PROPOSAL_MAX_AGE_MINUTES = 30;

export interface PendingBooking {
  serviceId: string;
  professionalId?: string;
  date: string;
  time: string;
  firstName: string;
  lastName: string;
  /** Optional: the phone is what is required. */
  email?: string;
  phone?: string;
  notes?: string;
  /** One of the salon's locations, when it has several (receptionist-locations.ts). */
  locationId?: string;
  /**
   * She said she does not want promotions: recorded like the booking page's
   * unticked "No quiero recibir promociones" (a refusal). Absent records nothing.
   */
  refusesPromotions?: boolean;
  /** Client messages in the conversation when this was proposed. */
  proposedAtUserTurn: number;
  /** When it was proposed (ISO). Older proposals have none. */
  proposedAt?: string;
  bookedAppointmentId?: string;
}

/**
 * Is the client's current message the reply to this proposal? Only the very
 * next message after the summary is, and only while the proposal is fresh.
 *
 * "There is a proposal and the client said yes" was the old test: a summary
 * for a cut on Tuesday, then "¿hacéis uñas?", "¿te miro hueco?", "sí" -- and
 * the server booked the cut, which the client had not confirmed. A proposal
 * the model shows again is proposed again, which moves proposedAtUserTurn.
 *
 * `currentUserTurn` counts the client's messages including the current one.
 */
export function isReplyToProposal(
  pending: Pick<PendingBooking, 'proposedAtUserTurn' | 'proposedAt' | 'bookedAppointmentId'> | undefined | null,
  currentUserTurn: number,
  now: Date = new Date(),
): boolean {
  if (!pending || pending.bookedAppointmentId) return false;
  if (currentUserTurn !== pending.proposedAtUserTurn + 1) return false;
  if (pending.proposedAt) {
    const age = now.getTime() - new Date(pending.proposedAt).getTime();
    if (!(age >= 0 && age <= PROPOSAL_MAX_AGE_MINUTES * 60_000)) return false;
  }
  return true;
}

/**
 * What stays of a proposal once it is booked: enough to recognise the booked
 * time and never book it twice. The client's name, phone and email are on
 * the appointment and her client record; the conversation does not need a
 * second copy.
 */
function bookedOnly(p: PendingBooking, appointmentId: string): PendingBooking {
  return {
    serviceId: p.serviceId,
    professionalId: p.professionalId,
    date: p.date,
    time: p.time,
    locationId: p.locationId,
    firstName: '',
    lastName: '',
    proposedAtUserTurn: p.proposedAtUserTurn,
    proposedAt: p.proposedAt,
    bookedAppointmentId: appointmentId,
  };
}

interface ConversationState {
  pendingBooking?: PendingBooking;
  chatBookings?: number;
  [key: string]: unknown;
}

/// A yes is an agreeing word or phrase followed by nothing but more agreement
// and courtesy. Anything else -- a condition ("si pudiera ser a las 11": "si"
// is also "if"), a correction ("sí, pero a las 11"), a question -- is not a
// yes. Words are compared lower-cased, without accents or punctuation.
const YES_PHRASES = [
  'si', 'sii', 'siii', 'vale', 'ok', 'okay', 'okey', 'de acuerdo', 'confirmo', 'confirma', 'confirmado',
  'correcto', 'perfecto', 'adelante', 'claro', 'genial', 'por supuesto', 'eso es', 'exacto', 'venga',
  'yes', 'yep', 'yeah', 'sure', 'correct', 'confirmed', 'confirm', 'go ahead', 'thats right', 'please do', 'perfect',
];
const COURTESY = new Set([
  ...YES_PHRASES.flatMap((p) => p.split(' ')),
  'gracias', 'muchas', 'por', 'favor', 'todo', 'bien', 'esta', 'asi', 'reservala', 'reserva', 'reservalo',
  // "Sí, confírmala por favor" was not a yes: only "confirma"/"confirmo" were
  // listed, so a real client's confirmation booked nothing.
  'confirmala', 'confirmalo', 'confirmamela', 'confirmamelo', 'reservamela', 'reservamelo',
  'thanks', 'thank', 'you', 'please', 'all', 'good', 'great', 'fine', 'book', 'it',
]);

/** Is this client message a yes to a summary? Conservative: when in doubt, no. */
export function isAffirmative(message: string): boolean {
  const text = message
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '')
    .replace(/[¡!¿?.,;:()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const lead = YES_PHRASES.find((p) => text === p || text.startsWith(`${p} `));
  if (!lead) return false;
  return text
    .slice(lead.length)
    .split(' ')
    .filter(Boolean)
    .every((word) => COURTESY.has(word));
}

/** "clientInfo.email" rather than "clientInfo": the model has to know what to ask for. */
function fieldPaths(errors: ValidationError[], prefix = ''): string[] {
  return errors.flatMap((e) => {
    const path = prefix ? `${prefix}.${e.property}` : e.property;
    return e.children && e.children.length > 0 ? fieldPaths(e.children, path) : [path];
  });
}

function toDto(p: Omit<PendingBooking, 'proposedAtUserTurn' | 'bookedAppointmentId'>): OnlineBookingDto {
  return plainToInstance(OnlineBookingDto, {
    serviceId: p.serviceId,
    professionalId: p.professionalId || undefined,
    scheduledDate: p.date,
    scheduledTime: p.time,
    notes: p.notes || undefined,
    locationId: p.locationId || undefined,
    source: 'online',
    clientInfo: {
      firstName: p.firstName,
      lastName: p.lastName ?? '',
      email: p.email || undefined,
      phone: p.phone || undefined,
    },
    ...(p.refusesPromotions ? { refusesMarketingEmail: true } : {}),
  });
}

/**
 * "Sí, pero no quiero promociones": the yes books, and the refusal counts
 * even though the model did not propose again with it.
 */
const REFUSES_PROMOTIONS =
  /\b(no|sin)\b[^.!?\n]{0,30}\b(promociones|publicidad|ofertas|novedades|marketing|newsletter|promotions|offers|ads)\b/i;

export function refusesPromotions(message: string | undefined): boolean {
  return REFUSES_PROMOTIONS.test(message ?? '');
}

async function readState(ctx: SalonToolContext): Promise<ConversationState> {
  return (await readRow(ctx)).state;
}

async function readRow(ctx: SalonToolContext): Promise<{ state: ConversationState; clientId: string | null }> {
  const row = await ctx.prisma.chatConversation.findUnique({
    where: { id: ctx.conversation!.id },
    select: { context: true, clientId: true },
  });
  const context = row?.context;
  return {
    state: context && typeof context === 'object' ? { ...(context as ConversationState) } : {},
    clientId: (row as { clientId?: string | null } | null)?.clientId ?? null,
  };
}

/**
 * `clientId` links the conversation to the client the booking was made for,
 * so her data export and erasure find it: a visitor's conversation had no
 * client, and stayed behind when she asked to be erased.
 */
async function writeState(ctx: SalonToolContext, state: ConversationState, clientId?: string): Promise<void> {
  await ctx.prisma.chatConversation.update({
    where: { id: ctx.conversation!.id },
    data: { context: state as any, ...(clientId ? { clientId } : {}) },
  });
}

async function userTurns(ctx: SalonToolContext): Promise<number> {
  return ctx.prisma.chatMessage.count({
    where: { conversationId: ctx.conversation!.id, role: 'user' },
  });
}

/**
 * Checks shared by both steps. A conversation must exist and belong to one
 * person: the public site used to send clientId "anonymous" for every
 * visitor, which put everyone's details in one shared conversation.
 */
function refuseUnlessPrivateConversation(ctx: SalonToolContext): Record<string, unknown> | null {
  if (!ctx.appointmentsService) return { error: 'appointments_service_unavailable' };
  if (!ctx.conversation) return { error: 'no_conversation' };
  if (!ctx.conversation.clientId || ctx.conversation.clientId === 'anonymous') {
    return {
      error: 'anonymous_session',
      message: 'This chat cannot book. Give the client the booking page and the phone number.',
    };
  }
  return null;
}

/**
 * A service the salon has not opened to online booking (isOnlineBookable
 * off) is not offered or booked by the receptionist either: the chat and
 * WhatsApp are online bookings. The server refuses the booking itself
 * (AppointmentsService.assertBookableOnline); this tells the model why, so
 * it sends the client to the salon instead of trying other times.
 */
export async function notBookableOnline(
  ctx: SalonToolContext,
  serviceId: string,
): Promise<{ error: string; message: string } | null> {
  const service = await ctx.prisma.service.findFirst({
    where: { id: serviceId, tenantId: ctx.tenantId, isActive: true },
    select: { isOnlineBookable: true },
  });
  if (service?.isOnlineBookable !== false) return null;
  return {
    error: 'not_bookable_online',
    message:
      'The salon does not take bookings for this service online or by chat. Tell the client to call ' +
      'the salon to book it (get_salon_info has the phone). Do not offer times for it.',
  };
}

/** The phone a channel already gives us: WhatsApp identifies the user by number. */
function channelPhone(ctx: SalonToolContext): string | undefined {
  const c = ctx.conversation;
  if (!c?.externalUserId) return undefined;
  if (String(c.channel).toLowerCase() !== 'whatsapp') return undefined;
  const digits = c.externalUserId.replace(/\D/g, '');
  return digits.length >= 8 ? `+${digits}` : undefined;
}

export async function proposeAppointment(
  ctx: SalonToolContext,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const refused = refuseUnlessPrivateConversation(ctx);
  if (refused) return refused;

  const details = {
    serviceId: String(input.serviceId ?? ''),
    professionalId: input.professionalId ? String(input.professionalId) : undefined,
    date: String(input.date ?? ''),
    time: String(input.time ?? ''),
    firstName: String(input.firstName ?? ''),
    lastName: String(input.lastName ?? ''),
    email: input.email ? String(input.email).trim() || undefined : undefined,
    phone: input.phone ? String(input.phone) : channelPhone(ctx),
    notes: input.notes ? String(input.notes) : undefined,
    // Set by resolveLocation for a salon with several locations; else absent.
    locationId: input.locationId ? String(input.locationId) : undefined,
    // Unticked by default: only her explicit "no quiero promociones" counts.
    refusesPromotions: input.refusesPromotions === true || refusesPromotions(ctx.conversation?.lastUserMessage) || undefined,
  };

  const invalid = validateSync(toDto(details), { whitelist: true });
  if (invalid.length > 0) {
    return {
      proposed: false,
      error: 'invalid_input',
      fields: fieldPaths(invalid),
      message: 'Ask the client for these details, then propose again.',
    };
  }

  const closed = await notBookableOnline(ctx, details.serviceId);
  if (closed) return { proposed: false, ...closed };

  // Is the slot still bookable online right now? (Booking re-checks it.)
  const slots = await ctx.appointmentsService!.getAvailableSlots(
    ctx.tenantId,
    new Date(details.date),
    details.professionalId,
    details.serviceId,
    undefined,
    undefined,
    { onlineWindow: true, ...(details.locationId ? { locationId: details.locationId } : {}) },
  );
  if (!slots.some((s: { time: string; isAvailable: boolean }) => s.time === details.time && s.isAvailable)) {
    return {
      proposed: false,
      error: 'slot_unavailable',
      message: 'That time cannot be booked. Check availability again and offer other times.',
    };
  }

  // "Whoever is free" is decided now, not at booking, so the summary the
  // client says yes to names the professional they will get. Deciding it at
  // booking time booked Ana Martínez after the model had shown Carmen.
  if (!details.professionalId) {
    try {
      details.professionalId = await ctx.appointmentsService!.findFreeProfessional(
        ctx.tenantId,
        new Date(details.date),
        details.serviceId,
        details.time,
        [],
        // Someone who works at that location.
        details.locationId,
      );
    } catch {
      return {
        proposed: false,
        error: 'slot_unavailable',
        message: 'Nobody is free at that time. Check availability again and offer other times.',
      };
    }
  }

  const [service, professional] = await Promise.all([
    ctx.prisma.service.findFirst({
      where: { id: details.serviceId, tenantId: ctx.tenantId },
      select: { name: true, duration: true, price: true, currency: true },
    }),
    ctx.prisma.professional.findFirst({
      where: { id: details.professionalId, tenantId: ctx.tenantId },
      select: { firstName: true, lastName: true },
    }),
  ]);
  if (!service || !professional) {
    return {
      proposed: false,
      error: 'invalid_input',
      fields: [!service ? 'serviceId' : 'professionalId'],
      message: 'Use the ids returned by list_services and list_professionals.',
    };
  }

  // What the client will pay, tax included, as list_services quoted it.
  const prices = await clientPrices(ctx);
  // Where, for a salon with several locations: its name and address.
  const location = await locationLabel(ctx, details.locationId);
  const state = await readState(ctx);
  state.pendingBooking = {
    ...details,
    proposedAtUserTurn: await userTurns(ctx),
    proposedAt: new Date().toISOString(),
  };
  await writeState(ctx, state);

  return {
    proposed: true,
    // Show exactly this. It is what create_appointment will book.
    summary: {
      service: service.name,
      durationMinutes: service.duration,
      price: `${clientPriceText(service.price, prices)} ${service.currency} (${taxIncludedNote(prices)})`,
      professional: `${professional.firstName} ${professional.lastName}`.trim(),
      ...(location ? { location } : {}),
      date: details.date,
      time: details.time,
      name: `${details.firstName} ${details.lastName}`.trim(),
      email: details.email ?? null,
      phone: details.phone ?? null,
    },
    next:
      'Show exactly this summary, with its labels in the language the client is writing in, and ask them to confirm. ' +
      'Book with create_appointment only after they reply yes.',
  };
}

export async function confirmAppointment(ctx: SalonToolContext): Promise<Record<string, unknown>> {
  const refused = refuseUnlessPrivateConversation(ctx);
  if (refused) return refused;

  const row = await readRow(ctx);
  const state = row.state;
  const pending = state.pendingBooking;
  if (!pending) {
    return { created: false, error: 'nothing_proposed', message: 'Propose the booking with propose_appointment first.' };
  }

  // Idempotent: the same proposal is never booked twice.
  if (pending.bookedAppointmentId) {
    return {
      created: true,
      alreadyBooked: true,
      date: pending.date,
      time: pending.time,
    };
  }

  // The client must have answered the summary, and answered yes: with the
  // very next message after it (see isReplyToProposal).
  const turns = await userTurns(ctx);
  if (turns <= pending.proposedAtUserTurn) {
    return { created: false, error: 'not_confirmed', message: 'Wait for the client to reply to the summary.' };
  }
  if (!isReplyToProposal(pending, turns)) {
    return {
      created: false,
      error: 'not_confirmed',
      message:
        'The client is no longer answering that summary. If they still want that booking, call ' +
        'propose_appointment again and show the new summary.',
    };
  }
  if (!isAffirmative(ctx.conversation!.lastUserMessage)) {
    return {
      created: false,
      error: 'not_confirmed',
      message: 'The client has not said yes. Ask what they would like to change.',
    };
  }

  if ((state.chatBookings ?? 0) >= MAX_BOOKINGS_PER_CONVERSATION) {
    return { created: false, error: 'too_many_bookings', message: 'Further bookings must be made with the salon.' };
  }
  const since = new Date(Date.now() - 24 * 3_600_000);
  // The same client by phone or by email: the phone is required now and the
  // email optional, so counting by email alone let a client past the limit
  // just by leaving it out.
  const recentRows = await ctx.prisma.appointment.findMany({
    where: {
      tenantId: ctx.tenantId,
      createdAt: { gte: since },
      status: { not: 'cancelled' },
      source: 'online',
    },
    select: { client: { select: { email: true, phone: true } } },
  });
  const recent = recentRows.filter(
    (r: any) =>
      (pending.email && r.client?.email === pending.email) || samePhone(r.client?.phone, pending.phone),
  ).length;
  if (recent >= MAX_CHAT_BOOKINGS_PER_EMAIL_PER_DAY) {
    return { created: false, error: 'too_many_bookings', message: 'Further bookings must be made with the salon.' };
  }

  try {
    const choice = refusesPromotions(ctx.conversation?.lastUserMessage) ? { ...pending, refusesPromotions: true } : pending;
    const appointment: any = await ctx.appointmentsService!.bookOnline(ctx.tenantId, toDto(choice));
    state.pendingBooking = bookedOnly(pending, appointment.id);
    state.chatBookings = (state.chatBookings ?? 0) + 1;
    // A conversation already linked to someone (a WhatsApp client) stays so.
    const linkTo = !row.clientId && typeof appointment.clientId === 'string' ? appointment.clientId : undefined;
    await writeState(ctx, state, linkTo);
    // No appointmentId: the model showed the UUID to clients as a
    // "referencia". The id stays in the conversation state.
    return {
      created: true,
      // Only true when the provider accepted the email. Say "te hemos
      // enviado un email" only then.
      confirmationEmailSent: appointment.confirmationEmailSent === true,
      confirmationSmsSent: appointment.confirmationSmsSent === true,
      // false: the salon confirms online bookings itself. Say "reservada,
      // pendiente de que el salón la confirme", never "confirmada".
      confirmed: appointment.status === 'confirmed',
      service: appointment.service?.name,
      professional: [appointment.professional?.firstName, appointment.professional?.lastName]
        .filter(Boolean)
        .join(' '),
      // Where, when the salon has several locations.
      ...(pending.locationId ? { location: await locationLabel(ctx, pending.locationId) } : {}),
      date: pending.date,
      time: pending.time,
    };
  } catch (err) {
    const status = err instanceof HttpException ? err.getStatus() : undefined;
    // The booking service's own refusals are written for the client ("Este
    // salón no acepta reservas en este momento"). Anything else is an
    // internal error whose text -- a database message -- is not passed on.
    return {
      created: false,
      error: status === 409 ? 'slot_unavailable' : 'booking_failed',
      message: err instanceof HttpException ? err.message : 'The booking could not be made.',
    };
  }
}
