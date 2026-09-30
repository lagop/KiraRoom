import { HttpException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync, ValidationError } from 'class-validator';
import { OnlineBookingDto } from '../../appointments/dto/book-appointment.dto';
import type { SalonToolContext } from './salon-tools';
import { samePhone } from '../../common/phone';

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
  /** Client messages in the conversation when this was proposed. */
  proposedAtUserTurn: number;
  bookedAppointmentId?: string;
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
    source: 'online',
    clientInfo: {
      firstName: p.firstName,
      lastName: p.lastName ?? '',
      email: p.email || undefined,
      phone: p.phone || undefined,
    },
  });
}

async function readState(ctx: SalonToolContext): Promise<ConversationState> {
  const row = await ctx.prisma.chatConversation.findUnique({
    where: { id: ctx.conversation!.id },
    select: { context: true },
  });
  const context = row?.context;
  return context && typeof context === 'object' ? { ...(context as ConversationState) } : {};
}

async function writeState(ctx: SalonToolContext, state: ConversationState): Promise<void> {
  await ctx.prisma.chatConversation.update({
    where: { id: ctx.conversation!.id },
    data: { context: state as any },
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

  // Is the slot still bookable online right now? (Booking re-checks it.)
  const slots = await ctx.appointmentsService!.getAvailableSlots(
    ctx.tenantId,
    new Date(details.date),
    details.professionalId,
    details.serviceId,
    undefined,
    undefined,
    { onlineWindow: true },
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

  const state = await readState(ctx);
  state.pendingBooking = { ...details, proposedAtUserTurn: await userTurns(ctx) };
  await writeState(ctx, state);

  return {
    proposed: true,
    // Show exactly this. It is what create_appointment will book.
    summary: {
      service: service.name,
      durationMinutes: service.duration,
      price: `${Number(service.price).toFixed(2)} ${service.currency}`,
      professional: `${professional.firstName} ${professional.lastName}`.trim(),
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

  const state = await readState(ctx);
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

  // The client must have answered the summary, and answered yes.
  if ((await userTurns(ctx)) <= pending.proposedAtUserTurn) {
    return { created: false, error: 'not_confirmed', message: 'Wait for the client to reply to the summary.' };
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
    const appointment: any = await ctx.appointmentsService!.bookOnline(ctx.tenantId, toDto(pending));
    state.pendingBooking = { ...pending, bookedAppointmentId: appointment.id };
    state.chatBookings = (state.chatBookings ?? 0) + 1;
    await writeState(ctx, state);
    // No appointmentId: the model showed the UUID to clients as a
    // "referencia". The id stays in the conversation state.
    return {
      created: true,
      // Only true when the provider accepted the email. Say "te hemos
      // enviado un email" only then.
      confirmationEmailSent: appointment.confirmationEmailSent === true,
      confirmationSmsSent: appointment.confirmationSmsSent === true,
      service: appointment.service?.name,
      professional: [appointment.professional?.firstName, appointment.professional?.lastName]
        .filter(Boolean)
        .join(' '),
      date: pending.date,
      time: pending.time,
    };
  } catch (err) {
    const status = err instanceof HttpException ? err.getStatus() : undefined;
    return {
      created: false,
      error: status === 409 ? 'slot_unavailable' : 'booking_failed',
      message: (err as Error).message,
    };
  }
}
