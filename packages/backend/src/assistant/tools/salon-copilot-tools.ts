import { HttpException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WaitListService, NotifyResult } from '../../wait-list/wait-list.service';
import { AppointmentsService } from '../../appointments/appointments.service';
import { canTransition, transitionRefusal } from '../../appointments/appointment-status';
import { NO_SHOW_BEFORE_START_MESSAGE, startsLater } from '../../appointments/no-show-timing';
import { VISIT_ROW_ORDER } from '../../appointments/visit-totals';
import { clientsWhoAcceptedWhatsAppMarketing } from '../../consent/marketing-consent';
import { normalizePhone } from '../../common/phone';
import { STANDARD_TEMPLATES, spanishDate, templateParam } from '../../whatsapp/whatsapp-templates';
import { metaGraphBaseUrl } from '../../whatsapp/meta-api-version';
import { noticeChannelsOf } from '../../consent/client-notices';
import { maskedPhone } from '../../clients/client-reach';
import { addDays, salonToday } from '../../analytics/analytics-metrics';
import { safeTimeZone } from '../../gift-cards/gift-card-expiry';
import { moneyOfCatalogueCents, salonTaxBasis } from '../../payments/appointment-charge';
import { bookedServiceName } from '../../appointments/appointment-snapshot';
import { clientReachWhere } from '../../clients/client-reach';
import { clientSearchSql, normaliseSearchText, phoneDigitVariants } from '../../clients/client-search';
import { salonNowMinutes } from '../briefing-gaps';
import { loadProfessionalGaps, loadWaitListCandidates, suggestForGaps } from './copilot-gaps';

/**
 * P2A-staff-copilot: tools the in-app copilot exposes to the LLM.
 *
 * Same architecture as `virtual-receptionist/tools/salon-tools.ts`
 * (one array `COPILOT_TOOLS` for the LLM, one `SalonCopilotToolsService`
 * for the executor). The catalog is intentionally narrow in sprint 12:
 * just the three tools that the discovery interview told us are
 * the highest-priority read-only use cases.
 *
 * Every tool is **scoped to the calling tenantId** at the SQL level;
 * the tool executor injects it. Staff users never see other tenants'
 * data, and stylists never see other stylists' financial data
 * (handled in `redactForRole`).
 */

export type CopilotRole = 'owner' | 'admin' | 'manager' | 'staff' | 'receptionist' | 'saas_owner' | 'client';

export interface CopilotToolContext {
  prisma: PrismaService;
  tenantId: string;
  userId: string;
  role: CopilotRole;
}

/* -------------------------------------------------------------------------- */
/*  Tool definitions (sent to the LLM)                                       */
/* -------------------------------------------------------------------------- */

export const COPILOT_TOOLS = [
  {
    name: 'get_my_agenda',
    description:
      "Return a day's appointments (today by default) for the calling professional — or for the whole salon if the caller is owner/admin/manager/receptionist — " +
      'and which ones are still `pending` confirmation. Also returns the free gaps of ≥ 30 min PER PROFESSIONAL ' +
      '(`gaps`, each with professionalFirstName): inside that professional\'s working hours and the salon\'s opening hours, ' +
      'minus closures, time off and her appointments (with cleanup time), and never earlier than now. ' +
      'A `staff` user only gets her own agenda and gaps.',
    input_schema: {
      type: 'object' as const,
      properties: {
        date: {
          type: 'string',
          description: 'Optional ISO date YYYY-MM-DD. Defaults to today in the salon timezone.',
        },
        professionalId: {
          type: 'string',
          description: 'Optional. Restricts the agenda to one professional. Not for `staff` (she only sees her own).',
        },
        location: {
          type: 'string',
          description: "Optional. For salons with several locations: the location's name or id. Only the professionals who work there.",
        },
      },
    },
  },
  {
    name: 'get_salon_agenda',
    description:
      "Owner / admin / manager only. Read the agenda and free gaps of any professional by id (same shape as get_my_agenda). Use when the caller asks 'what does Jorge have on Tuesday' and the calling user is not Jorge themselves.",
    input_schema: {
      type: 'object' as const,
      properties: {
        professionalId: { type: 'string', description: 'Professional UUID' },
        date: { type: 'string', description: 'Optional ISO date YYYY-MM-DD. Defaults to today.' },
      },
      required: ['professionalId'],
    },
  },
  // The other client tools take a clientId: this is how a name ("Carmen",
  // "Marta López") becomes one. Without it the model asked the salon for
  // the client's "ID de ficha", which nobody knows.
  {
    name: 'find_client',
    description:
      "Find clients by name (or part of it, accents and case ignored) or by phone digits. Returns up to 8 " +
      "matches: clientId, name, last visit date and number of visits. Use it FIRST whenever the user names a " +
      "client and you need her clientId (get_client_360, draft_follow_up_message, send_message…). If there are " +
      "several matches, ask which one she means (by full name and last visit), never pick one yourself. " +
      "It never returns phones or emails. A `staff` user only finds clients she has attended.",
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: "Name, surname or part of them (e.g. 'carmen', 'marta lopez'), or phone digits." },
      },
      required: ['query'],
    },
  },

  // Same for services: without it the copilot asked the owner for the
  // service's "identificador interno" before notifying the wait list.
  {
    name: 'list_services',
    description:
      "List the salon's active services: serviceId, name and duration in minutes (up to 100). Use it whenever " +
      "the user names a service and you need its serviceId (close_waitlist_slot…). Optional query filters by " +
      "name (accents and case ignored). Never ask the user for a service ID.",
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: "Optional. Name or part of it (e.g. 'corte', 'mechas')." },
      },
      required: [],
    },
  },

  {
    name: 'get_client_360',
    description:
      "Return a client's file: name, allergies, whether she has an email / a phone on file (not the contact itself), " +
      "and her recent visits (date, time, services as booked, professional, status; each visit's total in euros for non-staff). " +
      "For owner / admin / manager / reception also her completed visits in the last year and her total spend in euros. " +
      "It does NOT return notes, products bought, payment methods, contact details or birth date: never claim them. " +
      "Crucial use case: '¿qué le hice a Carmen la última vez?'. " +
      "A `staff` user only reaches clients she has attended, only sees her own visits with them, and never any amount.",
    input_schema: {
      type: 'object' as const,
      properties: {
        clientId: { type: 'string', description: 'The clientId from find_client (never ask the user for it).' },
        maxVisits: { type: 'number', description: 'Max appointments to include. Default 20.' },
      },
      required: ['clientId'],
    },
  },

  // --------------------------------------------------------------------
  //  Sprint 13: the next-4 read tools from the RFC.
  // --------------------------------------------------------------------

  {
    name: 'find_filling_opportunities',
    description:
      "Scan the next days (from now; default 7, today included) for free gaps PER PROFESSIONAL: inside her working hours " +
      "and the salon's opening hours, minus closures, time off and her appointments. Gaps come in date/time order " +
      "(at most 40 listed; `totalGaps` counts them all). For owner / admin / manager each gap carries up to topN " +
      "wait-list clients who fit it: still waiting, not blocked, her dates include that day, she asked for no " +
      "professional or for this one, the professional performs the service and it fits in the gap " +
      "(those who asked for this professional first, then those suggested least, then the longest waiting). " +
      "Use this when the user says 'tengo huecos esta semana' or 'a quién puedo llamar'. " +
      'Staff and receptionist get the gaps without client names; a `staff` user only her own gaps.',
    input_schema: {
      type: 'object' as const,
      properties: {
        daysAhead: { type: 'number', description: 'Days to scan, today included. Default 7.' },
        minGapMinutes: { type: 'number', description: 'Min gap to surface. Default 30.' },
        topN: { type: 'number', description: 'How many wait-list clients per gap. Default 5.' },
        professionalId: { type: 'string', description: 'Optional. Only this professional. Not for `staff`.' },
        location: {
          type: 'string',
          description: "Optional. For salons with several locations: the location's name or id.",
        },
      },
    },
  },

  {
    name: 'get_low_stock',
    description:
      "Return all products with stock below or equal to their `lowStockAlert` threshold. " +
      "Crucial use case: '¿qué me queda por reponer?' (what do I need to reorder?). " +
      'Only products with `trackInventory = true` and `isActive = true` are considered. ' +
      'Manager / owner / receptionist can see this; stylists do not.',
    input_schema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Max results. Default 20.' },
      },
    },
  },

  {
    name: 'get_no_show_history',
    description:
      "Return clients with ≥ 2 no-show appointments in the last 90 days, " +
      "ordered by frequency. Use when the user says 'quién no se presenta' or " +
      "'qué clientas me fallan'. Receptionist / manager / owner only.",
    input_schema: {
      type: 'object' as const,
      properties: {
        minNoShows: { type: 'number', description: 'Min no-shows. Default 2.' },
        daysBack: { type: 'number', description: 'Lookback window in days. Default 90.' },
      },
    },
  },

  {
    name: 'get_top_clients',
    description:
      "Return the top clients by a chosen metric. Use when the user says " +
      "'mis mejores clientas' (best by spend), 'clientas en riesgo' (by recency, " +
      'i.e. longest time since last visit), or just wants a quick re-engagement list. ' +
      'Manager / owner / receptionist only — stylist never sees other stylists\' clients ' +
      "ranking, and not the total-spend detail of any client.",
    input_schema: {
      type: 'object' as const,
      properties: {
        metric: {
          type: 'string',
          enum: ['spend', 'visits', 'recency'],
          description:
            'What to rank by. spend=totalSpent (manager+), visits=visitCount, recency=oldest lastVisit first.',
        },
        limit: { type: 'number', description: 'Max results. Default 10.' },
      },
      required: ['metric'],
    },
  },

  // Copilot audit M8: drafting is a READ tool (no approval card). It used
  // to ask for an approval just to show a text, hid it behind "Ver
  // detalle", and the model never learnt it had been approved.
  {
    name: 'draft_follow_up_message',
    description:
      "Write a short draft of a WhatsApp or email message to a client, for the user to COPY AND SEND HERSELF " +
      "(from her phone or email). It sends nothing and needs no approval. Show the returned `draft` text " +
      "in your reply exactly as it comes, so she can copy it. You cannot send this free text: the only " +
      "WhatsApp you can send is an approved template through send_message (when that action is available). " +
      "Optional: channel ('whatsapp'|'email'), occasion ('confirmation' = confirmar la cita, 'reminder' = " +
      "recordatorio, 'reactivation' = volver a verla, 'custom' = texto propio en customText), tone " +
      "('warm'|'formal'; both address the client as «tú», as the salon's messages do). " +
      "Default: WhatsApp / confirmation / warm. A `staff` user only drafts for clients she has attended.",
    input_schema: {
      type: 'object' as const,
      properties: {
        clientId: { type: 'string', description: 'The clientId from find_client (never ask the user for it).' },
        channel: { type: 'string', enum: ['whatsapp', 'email'] },
        occasion: { type: 'string', enum: ['confirmation', 'reminder', 'reactivation', 'custom'] },
        tone: { type: 'string', enum: ['warm', 'formal'] },
        customText: { type: 'string', description: "Optional. For occasion 'custom': what the message should say, in Spanish, addressing her as «tú»." },
      },
      required: ['clientId'],
    },
  },

  // --------------------------------------------------------------------
  //  Sprint 14: write tools. Always require human approval.
  //  The LLM is instructed to NEVER execute these directly; it must
  //  produce a `pendingAction` via the orchestrator and wait for the
  //  user to click Approve. See ActionApprovalService.
  // --------------------------------------------------------------------

  {
    name: 'send_message',
    description:
      "Send a WhatsApp template message to ONE client. Requires the tenant to have an " +
      "active WhatsApp connection (WABA OAuth or manual). The text must come from a " +
      "pre-approved Meta template (you cannot send free-form WhatsApp outside the 24h " +
      "customer-service window). A promotional (MARKETING) template is refused for a " +
      "client who has not opted in to WhatsApp promotions or replied BAJA. " +
      "Audit-logged. Always returns a pending_approval card; " +
      "the actual send happens after the user clicks Approve.",
    input_schema: {
      type: 'object' as const,
      properties: {
        clientId: { type: 'string' },
        // The real names: the example "appointment_reminder" does not
        // exist, and the model sent it.
        templateName: {
          type: 'string',
          description:
            'Template name. For appointment notices use one of these KiraRoom templates (variables in order, ' +
            'with an example): ' +
            STANDARD_TEMPLATES.map((t) => `${t.name} (${t.example.map((e, n) => `${n + 1} ${e}`).join(', ')})`).join('; ') +
            '. Any other name only for a promotion template the salon created.',
        },
        templateVars: {
          type: 'object',
          description: 'Variables for the template body, all of them, in order, e.g. { "1": "Carmen", "2": "Salón Lucía", … }.',
          additionalProperties: { type: 'string' },
        },
        languageCode: { type: 'string', description: 'BCP-47 language code. Default "es".' },
      },
      required: ['clientId', 'templateName'],
    },
  },

  {
    name: 'reschedule_appointment',
    description:
      "Move one appointment from its current date/time to a new one. Only the date/time " +
      "are updated; services, professional and client stay. Owner / manager / receptionist " +
      "can reschedule any appointment. A staff user can ONLY reschedule their own. " +
      "Always goes through human approval.",
    input_schema: {
      type: 'object' as const,
      properties: {
        appointmentId: { type: 'string' },
        newDate: { type: 'string', description: 'ISO date YYYY-MM-DD' },
        newTime: { type: 'string', description: 'HH:MM 24h' },
      },
      required: ['appointmentId', 'newDate', 'newTime'],
    },
  },

  // --------------------------------------------------------------------
  //  Sprint 15: 3 more write tools + tier gating (Premium+).
  // --------------------------------------------------------------------

  // D6 (Copilot audit 2026-11-14): the no-show FEE was removed from this
  // tool. It wrote `{ discount: { noShowFee } }` over the appointment's
  // discount (wiping any real discount) and no part of KiraRoom ever
  // charged it. RESTORE IT once there is a real no-show charge (an
  // off-session charge of the saved card, or a line the till/invoice
  // picks up): add `applyFee`/`feeAmount` back here, charge through that
  // path (never through `discount`), and show the amount on the approval.
  {
    name: 'mark_no_show',
    description:
      "Mark a confirmed appointment as a no-show. It does not charge any fee: " +
      "KiraRoom has no no-show charge yet, so never promise or mention one. " +
      "Receptionist / manager / owner only — stylists cannot. Audit-logged. " +
      "Always requires human approval.",
    input_schema: {
      type: 'object' as const,
      properties: {
        appointmentId: { type: 'string' },
      },
      required: ['appointmentId'],
    },
  },

  {
    name: 'create_coupon',
    description:
      "Issue a general single-use percentage discount code (any client may bring it; " +
      "it cannot be tied to one client). Staff apply it at the till (Caja); it is " +
      "not usable for online booking. Owner / admin / saas_owner ONLY — receptionists " +
      "cannot mint coupons. Always requires human approval. The code is unique per tenant " +
      "and generated by the system: it cannot be chosen.",
    input_schema: {
      type: 'object' as const,
      properties: {
        discountPercent: { type: 'number', description: 'Discount percent (1-100).' },
        // The model said "hasta el 30" for 15 days from the 15th: the card
        // then read "válido hasta el 29/11".
        expiresInDays: {
          type: 'number',
          description:
            'Days it is valid, TODAY INCLUDED: the last valid day is today + expiresInDays - 1 ' +
            '(15 on the 15th → valid through the 29th). For "valid until <date>", send the days from ' +
            'today to that date plus 1. Default 30.',
        },
      },
      required: ['discountPercent'],
    },
  },

  {
    name: 'close_waitlist_slot',
    description:
      "When an appointment is cancelled, tell the wait-list about the freed " +
      "slot. Picks the top N waiting clients matching the service + window and " +
      "sends each one the wait-list notice (email, the salon's WhatsApp or SMS, " +
      "with a booking link). A client counts as notified only when a channel " +
      "delivered; the result says, per client, what went out or why nothing did. " +
      "Salon owner / admin only.",
    input_schema: {
      type: 'object' as const,
      properties: {
        serviceId: { type: 'string', description: 'The serviceId from list_services (never ask the user for it).' },
        professionalId: { type: 'string', description: 'Optional. Restrict to clients for this professional.' },
        windowStart: { type: 'string', description: 'ISO date YYYY-MM-DD' },
        windowEnd: { type: 'string', description: 'ISO date YYYY-MM-DD' },
        time: { type: 'string', description: 'Optional. Start time of the freed slot, HH:MM.' },
        topN: { type: 'number', description: 'How many clients to notify, 1 to 10. Default 5.' },
      },
      required: ['serviceId', 'windowStart', 'windowEnd'],
    },
  },
] as const;

/**
 * The tools that change something and so go through an approval card. Every
 * other tool in COPILOT_TOOLS is read-only and runs straight away. Drafting a
 * message is NOT here (Copilot audit M8): it only returns text.
 */
export const COPILOT_WRITE_TOOLS = [
  'send_message',
  'reschedule_appointment',
  'mark_no_show',
  'create_coupon',
  'close_waitlist_slot',
] as const;

/* -------------------------------------------------------------------------- */
/*  Tool implementations                                                    */
/* -------------------------------------------------------------------------- */

/** find_filling_opportunities lists at most this many gaps (Copilot audit M5: bounded payloads). */
const MAX_LISTED_GAPS = 40;

type BookedServiceRow = { serviceName?: string | null; service?: { id?: string; name?: string | null } | null };

/**
 * The services of a visit, as booked. A one-service booking (the public
 * booking page, most panel bookings) can have NO service lines: its
 * service is on the appointment itself. The copilot read only the lines
 * and said "la ficha no muestra los servicios" for a «Corte de Cabello».
 */
export function visitServices(a: BookedServiceRow & { services: BookedServiceRow[] }): Array<{ id: string | null; name: string }> {
  const rows = a.services.length > 0 ? a.services : a.serviceName || a.service ? [a] : [];
  return rows.map((r) => ({ id: r.service?.id ?? null, name: bookedServiceName(r, 'Servicio') }));
}

/** find_client lists at most this many matches. */
const FIND_CLIENT_MAX = 8;

/** A staff account linked to no professional: nothing of anyone's, not the whole salon's. */
const STAFF_NOT_LINKED = {
  error: 'forbidden',
  message: 'Tu cuenta no está vinculada a ninguna ficha de profesional. Pide a quien gestiona el salón que lo revise.',
} as const;

@Injectable()
export class SalonCopilotToolsService {
  private readonly logger = new Logger(SalonCopilotToolsService.name);

  /** The clock the gaps read "now" from; the specs pin it. */
  now: () => Date = () => new Date();

  constructor(
    private readonly prisma: PrismaService,
    // Optional only for the specs that build the service by hand; Nest
    // resolves it from WaitListModule (no @Optional: a missing provider
    // must fail the boot, not silently skip the notices).
    private readonly waitList?: WaitListService,
    // mark_no_show takes the appointment's own status path. Same rule:
    // resolved from AppointmentsModule, optional only for the specs.
    private readonly appointments?: AppointmentsService,
  ) {}

  async execute(
    name: string,
    input: unknown,
    ctx: CopilotToolContext,
  ): Promise<Record<string, unknown>> {
    const args = (input ?? {}) as Record<string, unknown>;
    switch (name) {
      case 'get_my_agenda':
        return this.getMyAgenda(args, ctx);
      case 'get_salon_agenda':
        return this.getSalonAgenda(args, ctx);
      case 'find_client':
        return this.findClient(args, ctx);
      case 'list_services':
        return this.listServices(args, ctx);
      case 'get_client_360':
        return this.getClient360(args, ctx);
      case 'find_filling_opportunities':
        return this.findFillingOpportunities(args, ctx);
      case 'get_low_stock':
        return this.getLowStock(args, ctx);
      case 'get_no_show_history':
        return this.getNoShowHistory(args, ctx);
      case 'get_top_clients':
        return this.getTopClients(args, ctx);
      case 'draft_follow_up_message':
        return this.draftFollowUpMessage(args, ctx);
      case 'send_message':
        return this.sendMessage(args, ctx);
      case 'reschedule_appointment':
        return this.rescheduleAppointment(args, ctx);
      case 'mark_no_show':
        return this.markNoShow(args, ctx);
      case 'create_coupon':
        return this.createCoupon(args, ctx);
      case 'close_waitlist_slot':
        return this.closeWaitlistSlot(args, ctx);
      default:
        return { error: `unknown_tool:${name}` };
    }
  }

  /**
   * The text of an approval card, built HERE from the database and never
   * from the model's words: who it affects (client, masked phone), the
   * appointment as it stands and what it becomes, the message as it will
   * read. The card used to say "Mover la cita a 2026-11-20 16:00" with no
   * client, so with two Carmens in the agenda, or a model misled by what a
   * client typed in her booking, the salon approved blind.
   *
   * Something that does not exist in the salon says so: the action will
   * fail anyway, and the card must not look like a valid one.
   */
  /**
   * A write that cannot be done, told to the model before any card is shown
   * (null = go ahead and propose it). Only send_message so far.
   */
  async approvalPrecheck(
    name: string,
    input: unknown,
    ctx: CopilotToolContext,
  ): Promise<{ error: string; message?: string } | null> {
    if (name === 'mark_no_show') {
      if (!['owner', 'admin', 'manager', 'receptionist', 'saas_owner'].includes(ctx.role)) return null;
      const id = (input as { appointmentId?: unknown } | null)?.appointmentId;
      return typeof id === 'string' ? this.noShowRefusal(id, ctx) : null;
    }
    if (name !== 'send_message') return null;
    const checked = await this.sendMessageCheck((input ?? {}) as Record<string, unknown>, ctx);
    return 'error' in checked ? checked : null;
  }

  async approvalPreview(name: string, input: unknown, ctx: CopilotToolContext): Promise<string> {
    const i = (input ?? {}) as Record<string, any>;
    try {
      switch (name) {
        case 'send_message': {
          const client = await this.previewClient(i.clientId, ctx, true);
          if (!client) return 'Clienta no encontrada en tu salón: no se enviará nada.';
          const vars = (i.templateVars ?? {}) as Record<string, unknown>;
          const values = templateVarKeys(vars).map((k) => templateParam(String(vars[k] ?? '')));
          const standard = STANDARD_TEMPLATES.find((t) => t.name === i.templateName);
          const text = standard
            ? standard.body.replace(/\{\{(\d+)\}\}/g, (_m, n) => values[Number(n) - 1] ?? `{{${n}}}`)
            : `plantilla «${String(i.templateName ?? '')}»${values.length ? ` con: ${values.join(' · ')}` : ''}`;
          return `Enviar un WhatsApp a ${client}: «${text}»`;
        }
        case 'reschedule_appointment': {
          const appt = await this.previewAppointment(i.appointmentId, ctx);
          if (!appt) return 'Cita no encontrada en tu salón: no se moverá nada.';
          const to = /^\d{4}-\d{2}-\d{2}$/.test(String(i.newDate ?? ''))
            ? spanishDate(new Date(`${i.newDate}T00:00:00.000Z`))
            : String(i.newDate ?? '?');
          return `Mover la cita de ${appt.who} con ${appt.professional}: ${appt.when} → ${to}, ${String(i.newTime ?? '?')}. Se avisa a la clienta.`;
        }
        case 'mark_no_show': {
          const appt = await this.previewAppointment(i.appointmentId, ctx);
          if (!appt) return 'Cita no encontrada en tu salón: no se marcará nada.';
          // D6: no fee exists, so the card says nothing will be charged.
          return `Marcar que ${appt.who} no se presentó a su cita del ${appt.when} con ${appt.professional}. No se cobra ninguna penalización.`;
        }
        case 'create_coupon': {
          const pct = Number(i.discountPercent);
          const days = Math.min(Math.max(Math.round(Number(i.expiresInDays ?? 30)) || 30, 1), 365);
          // The last valid day, as createCoupon stores it: "15 días" left the
          // salon to count (and the model announced the 30th for a coupon
          // that ended on the 29th).
          const tenant = await this.prisma.tenant.findUnique({ where: { id: ctx.tenantId }, select: { timezone: true } });
          const today = salonToday(safeTimeZone(tenant?.timezone), this.now());
          const lastDay = spanishDate(new Date(`${addDays(today, days - 1)}T00:00:00.000Z`));
          return `Crear un código de descuento del ${Number.isFinite(pct) ? pct : '?'}% para cualquier clienta, de un solo uso y válido ${days === 1 ? 'solo hoy' : `hasta el ${lastDay} incluido`}. Se aplica al cobrar en caja (no en la reserva online).`;
        }
        case 'close_waitlist_slot': {
          const service = typeof i.serviceId === 'string'
            ? await this.prisma.service.findFirst({ where: { id: i.serviceId, tenantId: ctx.tenantId }, select: { name: true } })
            : null;
          if (!service) return 'Servicio no encontrado en tu salón: no se avisará a nadie.';
          const n = Math.min(Math.max(Math.floor(Number(i.topN ?? 5)) || 5, 1), 10);
          // Days in words (the card read "el 2026-11-20").
          const day = (v: unknown) =>
            /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? spanishDate(new Date(`${String(v)}T00:00:00.000Z`)) : String(v ?? '?');
          const range = i.windowStart === i.windowEnd ? `el ${day(i.windowStart)}${i.time ? ` a las ${String(i.time)}` : ''}` : `del ${day(i.windowStart)} al ${day(i.windowEnd)}`;
          return `Avisar por email, WhatsApp o SMS a hasta ${n} clientes de la lista de espera de «${service.name}» del hueco ${range} (solo cuenta como avisado si le llega).`;
        }
        default:
          return `Acción pendiente: ${name}`;
      }
    } catch (err) {
      this.logger.warn(`Approval preview for ${name} failed: ${(err as Error).message}`);
      return `Acción pendiente: ${name} (no se ha podido preparar el resumen; revísala antes de aprobar).`;
    }
  }

  /** "Carmen G." (+ "· tel. ···· 222"), or null when not in the salon. */
  private async previewClient(clientId: unknown, ctx: CopilotToolContext, withPhone = false): Promise<string | null> {
    if (typeof clientId !== 'string' || !clientId) return null;
    const c = await this.prisma.client.findFirst({
      where: { id: clientId, tenantId: ctx.tenantId },
      select: { firstName: true, lastName: true, phone: true },
    });
    if (!c) return null;
    const name = `${c.firstName}${c.lastName?.trim() ? ` ${c.lastName.trim()[0]}.` : ''}`;
    const phone = withPhone ? maskedPhone(c.phone) : null;
    return phone ? `${name} (tel. ${phone})` : name;
  }

  /** Who, when and with whom an appointment of the salon is, or null. */
  private async previewAppointment(
    appointmentId: unknown,
    ctx: CopilotToolContext,
  ): Promise<{ who: string; when: string; professional: string } | null> {
    if (typeof appointmentId !== 'string' || !appointmentId) return null;
    const a = await this.prisma.appointment.findFirst({
      where: { id: appointmentId, tenantId: ctx.tenantId },
      select: {
        scheduledDate: true,
        scheduledTime: true,
        client: { select: { firstName: true, lastName: true } },
        professional: { select: { firstName: true } },
      },
    });
    if (!a) return null;
    const who = a.client
      ? `${a.client.firstName}${a.client.lastName?.trim() ? ` ${a.client.lastName.trim()[0]}.` : ''}`
      : 'la clienta';
    return {
      who,
      when: `${spanishDate(a.scheduledDate)}, ${a.scheduledTime}`,
      professional: a.professional?.firstName ?? 'sin profesional',
    };
  }

  // --------------------------------------------------------------------
  //  Implementations
  // --------------------------------------------------------------------

  /**
   * Today's agenda. If the caller is `staff` and they pass a different
   * `professionalId`, refuse — they can only see their own agenda. Gaps
   * ≥ 30 min are computed in JS (cheap; avoids another tool call).
   */
  private async getMyAgenda(args: Record<string, unknown>, ctx: CopilotToolContext) {
    const date = await this.parseDateOrToday(args.date, ctx);
    const requestedProfId = typeof args.professionalId === 'string' && args.professionalId ? args.professionalId : undefined;

    if (ctx.role === 'staff') {
      // `ctx.userId` is the User id, not the Professional id: comparing the
      // two refused a staff member their own agenda by id. And a staff
      // account linked to no professional must not get the whole salon's
      // (computeAgenda without a professional is every appointment).
      const own = await this.findStaffProfessionalId(ctx);
      if (!own) return STAFF_NOT_LINKED;
      if (requestedProfId && requestedProfId !== own) {
        return {
          error: 'forbidden',
          message: 'No puedes ver la agenda de otro profesional.',
        };
      }
      return this.computeAgenda(ctx, date, own);
    }

    const location = await this.resolveLocation(args.location, ctx);
    if (isLocationError(location)) return location;
    return this.computeAgenda(ctx, date, requestedProfId ?? null, location);
  }

  /**
   * Same as `getMyAgenda` but always for a given professional. Manager+
   * only — blocked for `staff` and `receptionist`.
   */
  private async getSalonAgenda(args: Record<string, unknown>, ctx: CopilotToolContext) {
    if (!['owner', 'admin', 'manager', 'saas_owner'].includes(ctx.role)) {
      return {
        error: 'forbidden',
        message: 'Esta vista solo está disponible para owner / admin / manager.',
      };
    }
    const date = await this.parseDateOrToday(args.date, ctx);
    const professionalId = args.professionalId as string | undefined;
    if (!professionalId) {
      return { error: 'missing_professionalId' };
    }
    return this.computeAgenda(ctx, date, professionalId);
  }

  /**
   * 360 view. Heavy field-level redaction:
   * - `staff` users only see clients they have an appointment with.
   * - `staff` never sees `totalSpent`, `paymentMethod`, `commissionRate`,
   *   or any `internalOnly` note.
   * - Everyone else sees everything in the tenant.
   */
  /**
   * find_client: a name or phone typed in the chat → the matching clients'
   * ids. The same search as the Clientas list (accents and case ignored,
   * phone by digits), within the salon, with the staff reach rule.
   */
  private async findClient(args: Record<string, unknown>, ctx: CopilotToolContext) {
    const raw = typeof args.query === 'string' ? args.query.slice(0, 80) : '';
    const search = normaliseSearchText(raw);
    const phoneDigits = phoneDigitVariants(raw);
    if (search.length < 2 && phoneDigits.length === 0) return { error: 'missing_query' };

    let reach: Prisma.ClientWhereInput = {};
    if (ctx.role === 'staff') {
      const own = await this.findStaffProfessionalId(ctx);
      if (!own) return STAFF_NOT_LINKED;
      reach = clientReachWhere({ professionalId: own });
    }

    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(
      clientSearchSql(ctx.tenantId, { search, phoneDigits }),
    );
    if (rows.length === 0) return { query: raw, matches: [], total: 0 };

    const where: Prisma.ClientWhereInput = {
      tenantId: ctx.tenantId,
      isTest: false,
      id: { in: rows.map((r) => r.id) },
      ...reach,
    };
    const [clients, total] = await Promise.all([
      this.prisma.client.findMany({
        where,
        orderBy: [{ lastVisit: { sort: 'desc', nulls: 'last' } }, { firstName: 'asc' }],
        take: FIND_CLIENT_MAX,
        select: { id: true, firstName: true, lastName: true, lastVisit: true, visitCount: true, status: true },
      }),
      this.prisma.client.count({ where }),
    ]);
    return {
      query: raw,
      total,
      matches: clients.map((c) => ({
        clientId: c.id,
        name: `${c.firstName} ${c.lastName}`.trim(),
        lastVisit: c.lastVisit ? c.lastVisit.toISOString().slice(0, 10) : null,
        visitCount: c.visitCount ?? 0,
        ...(c.status === 'active' ? {} : { status: c.status }),
      })),
      ...(total > clients.length ? { note: `Hay ${total} coincidencias; pide el apellido para afinar.` } : {}),
    };
  }

  /** list_services: a service named in the chat → its serviceId. */
  private async listServices(args: Record<string, unknown>, ctx: CopilotToolContext) {
    const raw = typeof args.query === 'string' ? args.query.slice(0, 80) : '';
    const search = normaliseSearchText(raw);
    const services = await this.prisma.service.findMany({
      where: { tenantId: ctx.tenantId, isActive: true },
      orderBy: { name: 'asc' },
      take: 300,
      select: { id: true, name: true, duration: true },
    });
    const matches = search ? services.filter((s) => normaliseSearchText(s.name).includes(search)) : services;
    return {
      ...(raw ? { query: raw } : {}),
      total: matches.length,
      services: matches.slice(0, 100).map((s) => ({ serviceId: s.id, name: s.name, durationMinutes: s.duration })),
    };
  }

  private async getClient360(args: Record<string, unknown>, ctx: CopilotToolContext) {
    const clientId = args.clientId as string | undefined;
    if (!clientId) return { error: 'missing_clientId' };

    // Ownership check for `staff`: the panel's reach rule (an appointment
    // with her that is not cancelled), so a cancelled booking no longer
    // opens the file here either.
    let ownProfessionalId: string | null = null;
    if (ctx.role === 'staff') {
      // Their professional, not their user id (which never matched).
      ownProfessionalId = await this.findStaffProfessionalId(ctx);
      if (!ownProfessionalId) return STAFF_NOT_LINKED;
      const owns = await this.prisma.client.findFirst({
        where: { id: clientId, tenantId: ctx.tenantId, ...clientReachWhere({ professionalId: ownProfessionalId }) },
        select: { id: true },
      });
      if (!owns) {
        return {
          error: 'forbidden',
          message: 'Solo puedes ver clientes que hayas atendido.',
        };
      }
    }

    const maxVisits = Math.min(Math.max(Math.floor(Number(args.maxVisits ?? 20)) || 20, 1), 50);
    const [client, appointments, tenant] = await Promise.all([
      // Always within the caller's salon, whatever the role.
      this.prisma.client.findFirst({
        where: { id: clientId, tenantId: ctx.tenantId },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          // Contact details, birth date and gender stay out (Copilot audit
          // A4 / D1): the questions the copilot answers ("¿qué le hice la
          // última vez?") need none of them, and everything selected here
          // goes to the AI provider. Only whether she can be written to.
          email: true,
          phone: true,
          // Allergies stay (D1): they matter before a dye or a chemical
          // treatment. A health datum: the sub-processor text names the
          // copilot (lib/salon-legal.ts).
          allergies: true,
          // The lifetime spend, in euros (as Clientas shows it); only
          // returned below to the roles that see money.
          totalSpent: true,
        },
      }),
      this.prisma.appointment.findMany({
        // The wizard's test booking is left out of everything the copilot reads (D27).
        where: { clientId, tenantId: ctx.tenantId, isTest: false },
        orderBy: [{ scheduledDate: 'desc' }, { scheduledTime: 'desc' }],
        take: maxVisits,
        select: {
          id: true,
          scheduledDate: true,
          scheduledTime: true,
          status: true,
          totalAmount: true,
          professional: { select: { id: true, firstName: true } },
          // A one-service booking may keep its service only here, with no
          // service lines (see visitServices).
          serviceName: true,
          service: { select: { id: true, name: true } },
          services: {
            // The services as they were booked (their snapshot), not
            // today's catalogue: a renamed service keeps its old name here.
            select: {
              serviceName: true,
              service: { select: { id: true, name: true } },
            },
            orderBy: VISIT_ROW_ORDER as any,
          },
        },
      }),
      this.prisma.tenant.findUnique({ where: { id: ctx.tenantId }, select: { fiscalSettings: true } }),
    ]);

    if (!client) return { error: 'client_not_found' };

    // `totalAmount` is the visit in catalogue CENTS (tax inside or not,
    // per the salon): turned into euros the client pays, as the till and
    // the invoice read it. The model used to get the cents and say
    // "12.000 €" for three 40 € visits.
    const basis = salonTaxBasis(tenant?.fiscalSettings);
    const euros = (cents: unknown) =>
      Math.round(moneyOfCatalogueCents(Math.round(Number(cents ?? 0)), basis)) / 100;

    // `staff` users only see visits they personally attended.
    // Other roles see every visit on the client.
    const isStaff = ctx.role === 'staff';
    const allVisits = appointments
      .filter((a) => (isStaff ? a.professional?.id === ownProfessionalId : true))
      .map((a) => ({
        id: a.id,
        date: a.scheduledDate.toISOString().slice(0, 10),
        time: a.scheduledTime,
        status: a.status,
        professional: a.professional ? { id: a.professional.id, firstName: a.professional.firstName } : null,
        services: visitServices(a),
        // The visit's total in euros, shown to non-staff roles only.
        ...(isStaff ? {} : { totalEur: euros(a.totalAmount) }),
      }));

    // Stats (completed visits in the last 365 days, lifetime spend) are
    // restricted to owner / admin / manager / saas_owner / receptionist.
    // Stylists never see aggregates.
    const seesStats = ['owner', 'admin', 'manager', 'receptionist', 'saas_owner']
      .includes(ctx.role);
    const stats: Record<string, unknown> = {};
    if (seesStats) {
      const since = new Date();
      since.setUTCDate(since.getUTCDate() - 365);
      const completed = await this.prisma.appointment.count({
        where: {
          clientId,
          tenantId: ctx.tenantId,
          isTest: false,
          status: 'completed',
          scheduledDate: { gte: since },
        },
      });
      stats.completedVisitsLast365d = completed;
      // Her total spend in euros: the same figure as her file in Clientas,
      // not a sum of list prices.
      stats.totalSpentEur = Math.round(Number(client.totalSpent ?? 0) * 100) / 100;
    }

    return {
      id: client.id,
      name: `${client.firstName} ${client.lastName}`.trim(),
      firstName: client.firstName,
      lastName: client.lastName,
      hasEmail: !!client.email?.trim(),
      hasPhone: !!client.phone?.trim(),
      allergies: client.allergies,
      visits: allVisits,
      stats,
    };
  }

  // --------------------------------------------------------------------
  //  Helpers
  // --------------------------------------------------------------------

  /**
   * Returns the `professionalId` for the calling `staff` user. Most users
   * have a 1:1 user→professional mapping; if absent, we return null
   * (so the agenda query doesn't accidentally surface another
   * professional's data).
   */
  private async findStaffProfessionalId(ctx: CopilotToolContext): Promise<string | null> {
    const professional = await this.prisma.professional.findFirst({
      where: { tenantId: ctx.tenantId, user: { id: ctx.userId } },
      select: { id: true },
    });
    return professional?.id ?? null;
  }

  /**
   * A day's agenda and its free gaps per professional (Copilot audit M6):
   * each professional's bookable hours minus closures, time off and her own
   * appointments, from now on (copilot-gaps.ts, the daily briefing's rule).
   * It used to merge every professional into one row and report the space
   * between consecutive appointments: a professional free all afternoon never
   * showed and the lunch closure read as a gap.
   */
  private async computeAgenda(
    ctx: CopilotToolContext,
    date: Date,
    professionalId: string | null,
    location: { id: string; name: string } | null = null,
  ) {
    // Dates are stored as their UTC midnight: the day is [date, date + 1).
    const dayStart = new Date(date);
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayStart.getUTCDate() + 1);
    const day = dayStart.toISOString().slice(0, 10);
    const clock = await this.salonClock(ctx);

    const { gaps, professionals } = await loadProfessionalGaps(ctx.prisma, {
      tenantId: ctx.tenantId,
      fromDay: day,
      toDay: day,
      todayDay: clock.today,
      nowMinutes: clock.nowMinutes,
      openingHours: clock.openingHours,
      timeZone: clock.timeZone,
      professionalIds: professionalId ? [professionalId] : null,
      locationId: location?.id ?? null,
      minGapMinutes: 30,
    });

    const where: Record<string, unknown> = {
      tenantId: ctx.tenantId,
      isTest: false,
      scheduledDate: { gte: dayStart, lt: dayEnd },
      status: { in: ['confirmed', 'pending', 'in_progress'] },
    };
    if (professionalId) where.professionalId = professionalId;
    // One location: the appointments of the professionals who work there.
    else if (location) where.professionalId = { in: professionals.map((p) => p.id) };

    const appointments = await this.prisma.appointment.findMany({
      where,
      orderBy: { scheduledTime: 'asc' },
      select: {
        id: true,
        scheduledTime: true,
        status: true,
        client: { select: { id: true, firstName: true } },
        professional: { select: { id: true, firstName: true, lastName: true } },
        serviceName: true,
        service: { select: { id: true, name: true } },
        services: {
          select: { serviceName: true, service: { select: { id: true, name: true } } },
          orderBy: VISIT_ROW_ORDER as any,
        },
      },
    });

    return {
      date: day,
      ...(location ? { location: location.name } : {}),
      totalAppointments: appointments.length,
      confirmed: appointments.filter((a) => a.status === 'confirmed').length,
      pending: appointments.filter((a) => a.status === 'pending').length,
      appointments: appointments.map((a) => ({
        id: a.id,
        time: a.scheduledTime,
        status: a.status,
        client: a.client,
        professional: a.professional,
        services: visitServices(a).map((v) => v.name),
      })),
      // ≥ 30 min, per professional, from now on.
      gaps: gaps.map((g) => ({
        professionalId: g.professionalId,
        professionalFirstName: g.professionalFirstName,
        start: g.start,
        end: g.end,
        minutes: g.minutes,
      })),
    };
  }

  /**
   * The day asked for (YYYY-MM-DD) or the SALON's today, as the UTC midnight
   * dates are stored at. It used the server's clock (UTC): between midnight
   * and 01:00/02:00 in Madrid "today" was yesterday. (The pattern had lost
   * its backslashes, so every date asked for read as today.)
   */
  private async parseDateOrToday(input: unknown, ctx: CopilotToolContext): Promise<Date> {
    if (typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input)) {
      const d = new Date(`${input}T00:00:00.000Z`);
      if (!Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === input) return d;
    }
    return new Date(`${await this.salonDay(ctx)}T00:00:00.000Z`);
  }

  /** Today in the salon's time zone, YYYY-MM-DD. */
  private async salonDay(ctx: CopilotToolContext): Promise<string> {
    let timezone: string | null | undefined;
    try {
      const tenant = await this.prisma.tenant.findUnique({ where: { id: ctx.tenantId }, select: { timezone: true } });
      timezone = tenant?.timezone;
    } catch {
      timezone = undefined; // the default zone (Spain)
    }
    return salonToday(safeTimeZone(timezone), this.now());
  }

  /** The salon's today, its clock now (minutes since midnight) and its opening hours. */
  private async salonClock(
    ctx: CopilotToolContext,
  ): Promise<{ today: string; nowMinutes: number; openingHours: unknown; timeZone: string }> {
    let tenant: { timezone?: string | null; openingHours?: unknown } | null = null;
    try {
      tenant = await this.prisma.tenant.findUnique({
        where: { id: ctx.tenantId },
        select: { timezone: true, openingHours: true },
      });
    } catch {
      tenant = null; // the default zone (Spain), no salon hours
    }
    const timeZone = safeTimeZone(tenant?.timezone);
    const now = this.now();
    return {
      today: salonToday(timeZone, now),
      nowMinutes: salonNowMinutes(timeZone, now),
      openingHours: tenant?.openingHours,
      timeZone,
    };
  }

  /**
   * One of the salon's locations, by id or name ("Gracia" finds "Local
   * Gracia"); null when none was asked for; an error naming the locations
   * when it is not one of them.
   */
  private async resolveLocation(
    input: unknown,
    ctx: CopilotToolContext,
  ): Promise<{ id: string; name: string } | { error: string; message: string } | null> {
    if (typeof input !== 'string' || !input.trim()) return null;
    const wanted = input.trim();
    const locations: Array<{ id: string; name: string }> =
      (await (this.prisma as any).location?.findMany?.({
        where: { tenantId: ctx.tenantId, isActive: true },
        select: { id: true, name: true },
      })) ?? [];
    const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const found =
      locations.find((l) => l.id === wanted) ??
      locations.find((l) => fold(l.name) === fold(wanted)) ??
      locations.find((l) => fold(l.name).includes(fold(wanted)));
    if (found) return found;
    return {
      error: 'location_not_found',
      message: locations.length
        ? `No hay ningún local «${wanted}». Los locales del salón son: ${locations.map((l) => l.name).join(', ')}.`
        : 'Este salón no tiene varios locales: pregunta sin indicar local.',
    };
  }

  // --------------------------------------------------------------------
  //  Sprint 13: gap-filling + inventory + no-show + top-clients
  // --------------------------------------------------------------------

  /**
   * The free gaps of the next days, per professional (Copilot audit M6, see
   * computeAgenda), and for owner / admin / manager the wait-list clients
   * who fit each one: still waiting and not blocked, her dates include the
   * day, she asked for that professional or none, the professional performs
   * her service and it fits. It used to offer the same five clients
   * (blocked ones included) for every gap. Staff and receptionist get the
   * gaps without client names; staff only her own.
   */
  private async findFillingOpportunities(
    args: Record<string, unknown>,
    ctx: CopilotToolContext,
  ) {
    const daysAhead = bounded(args.daysAhead, 7, 1, 30);
    const minGap = bounded(args.minGapMinutes, 30, 15, 480);
    const topN = bounded(args.topN, 5, 1, 10);
    const requestedProfId = typeof args.professionalId === 'string' && args.professionalId ? args.professionalId : null;

    // Staff: their own professional (this compared with the User id, which
    // no appointment carries).
    let professionalIds: string[] | null = requestedProfId ? [requestedProfId] : null;
    let location: { id: string; name: string } | null = null;
    if (ctx.role === 'staff') {
      const own = await this.findStaffProfessionalId(ctx);
      if (!own) return STAFF_NOT_LINKED;
      if (requestedProfId && requestedProfId !== own) {
        return { error: 'forbidden', message: 'Solo puedes ver tus propios huecos.' };
      }
      professionalIds = [own];
    } else {
      const resolved = await this.resolveLocation(args.location, ctx);
      if (isLocationError(resolved)) return resolved;
      location = resolved;
    }

    const clock = await this.salonClock(ctx);
    const fromDay = clock.today;
    const toDay = addDays(fromDay, daysAhead - 1);
    const { gaps: all } = await loadProfessionalGaps(ctx.prisma, {
      tenantId: ctx.tenantId,
      fromDay,
      toDay,
      todayDay: clock.today,
      nowMinutes: clock.nowMinutes,
      openingHours: clock.openingHours,
      timeZone: clock.timeZone,
      professionalIds,
      locationId: location?.id ?? null,
      minGapMinutes: minGap,
    });
    all.sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.start.localeCompare(b.start) ||
        a.professionalFirstName.localeCompare(b.professionalFirstName),
    );
    const listed = all.slice(0, MAX_LISTED_GAPS).map((g) => ({
      date: g.date,
      start: g.start,
      end: g.end,
      minutes: g.minutes,
      professionalId: g.professionalId,
      professionalFirstName: g.professionalFirstName,
    }));

    // Owner / admin / manager: who on the wait list fits each gap. Lower
    // roles get no client names.
    const seesClients = ['owner', 'admin', 'manager', 'saas_owner'].includes(ctx.role);
    const gaps =
      seesClients && listed.length
        ? suggestForGaps(listed, await loadWaitListCandidates(ctx.prisma, { tenantId: ctx.tenantId, fromDay, toDay }), topN)
        : listed.map((g) => ({ ...g, suggestions: [] as Array<never> }));

    return {
      from: fromDay,
      to: toDay,
      ...(location ? { location: location.name } : {}),
      daysAhead,
      minGapMinutes: minGap,
      totalGaps: all.length,
      ...(all.length > listed.length ? { listedGaps: listed.length, note: `Solo se listan los ${listed.length} primeros huecos por fecha.` } : {}),
      gaps,
    };
  }

  /**
   * P2A-staff-copilot sprint-13. Return every active, inventory-tracked
   * product whose stock is at or below its lowStockAlert threshold.
   * Stylist never sees this; only manager / owner / receptionist do.
   */
  private async getLowStock(args: Record<string, unknown>, ctx: CopilotToolContext) {
    if (!['owner', 'admin', 'manager', 'receptionist', 'saas_owner'].includes(ctx.role)) {
      return {
        error: 'forbidden',
        message: 'Esta vista solo está disponible para owner / admin / manager / recepcionista.',
      };
    }
    const limit = bounded(args.limit, 20, 1, 50);
    const products = await ctx.prisma.product.findMany({
      where: {
        tenantId: ctx.tenantId,
        isActive: true,
        trackInventory: true,
      },
      orderBy: { quantity: 'asc' },
      take: 200,  // over-fetch; filter in JS for accurate ≤ comparisons
      select: {
        id: true,
        name: true,
        sku: true,
        quantity: true,
        lowStockAlert: true,
        price: true,
        category: true,
      },
    });
    const low = products
      .filter((p) => p.quantity <= p.lowStockAlert)
      .slice(0, limit)
      .map((p) => ({
        id: p.id,
        name: p.name,
        sku: p.sku,
        quantity: p.quantity,
        lowStockAlert: p.lowStockAlert,
        deficit: Math.max(0, p.lowStockAlert - p.quantity),
        priceEur: Number(p.price),
        category: p.category,
      }));
    return { totalLowStock: low.length, items: low };
  }

  /**
   * P2A-staff-copilot sprint-13. Return the clients with ≥ N no-show
   * appointments in the last K days, ordered by frequency desc. The
   * role check mirrors the customer-facing chat so stylists cannot
   * snoop on a colleague's reliability score.
   */
  private async getNoShowHistory(
    args: Record<string, unknown>,
    ctx: CopilotToolContext,
  ) {
    if (!['owner', 'admin', 'manager', 'receptionist', 'saas_owner'].includes(ctx.role)) {
      return {
        error: 'forbidden',
        message: 'Esta vista solo está disponible para owner / admin / manager / recepcionista.',
      };
    }
    const minNoShows = bounded(args.minNoShows, 2, 1, 50);
    const daysBack = bounded(args.daysBack, 90, 1, 365);

    const since = new Date();
    since.setDate(since.getDate() - daysBack);

    // Group by client via Prisma's groupBy on Appointment where
    // status === 'no_show'. Prisma's groupBy doesn't support filtering
    // by an aggregate (`having`) on a related model, so we paginate
    // the candidates first and only count on the client side.
    const candidates = await ctx.prisma.appointment.findMany({
      where: {
        tenantId: ctx.tenantId,
        isTest: false,
        status: 'no_show',
        scheduledDate: { gte: since },
      },
      select: {
        clientId: true,
        scheduledDate: true,
        client: {
          select: { id: true, firstName: true, lastName: true, lastVisit: true, totalSpent: true },
        },
      },
      orderBy: { scheduledDate: 'desc' },
    });
    const counts = new Map<
      string,
      { count: number; lastDate: Date; client: (typeof candidates)[number]['client'] }
    >();
    for (const a of candidates) {
      const key = a.clientId;
      if (!counts.has(key)) {
        counts.set(key, { count: 1, lastDate: a.scheduledDate, client: a.client });
      } else {
        const e = counts.get(key)!;
        e.count += 1;
        if (a.scheduledDate > e.lastDate) e.lastDate = a.scheduledDate;
      }
    }
    const list = Array.from(counts.values())
      .filter((c) => c.count >= minNoShows)
      .sort((a, b) => b.count - a.count || b.lastDate.getTime() - a.lastDate.getTime())
      .map((c, i) => {
        const isSensitive = ['owner', 'admin', 'manager', 'saas_owner'].includes(ctx.role);
        return {
          clientId: c.client.id,
          firstName: c.client.firstName,
          noShows: c.count,
          lastNoShow: c.lastDate.toISOString().slice(0, 10),
          // Owner/manager/SAAS see total spent; receptionist does not.
          ...(isSensitive ? { totalSpentEur: Number(c.client.totalSpent) } : {}),
        };
      });
    return {
      windowDays: daysBack,
      minNoShows,
      totalFlagged: list.length,
      // At most 50 clients reach the model (Copilot audit M5).
      flagged: list.slice(0, 50),
    };
  }

  /**
   * P2A-staff-copilot sprint-13. Top clients by a chosen metric. The
   * response omits `totalSpent` unless the caller is owner / manager /
   * SAAS (receptionist must not see revenue detail). Stylist never
   * sees this; it would be a privacy issue.
   */
  private async getTopClients(args: Record<string, unknown>, ctx: CopilotToolContext) {
    if (!['owner', 'admin', 'manager', 'receptionist', 'saas_owner'].includes(ctx.role)) {
      return {
        error: 'forbidden',
        message: 'Esta vista solo está disponible para owner / admin / manager / recepcionista.',
      };
    }
    const metric = String(args.metric ?? 'spend') as 'spend' | 'visits' | 'recency';
    const limit = bounded(args.limit, 10, 1, 50);
    const isSensitive = ['owner', 'admin', 'manager', 'saas_owner'].includes(ctx.role);

    let orderBy: any = { totalSpent: 'desc' };
    if (metric === 'visits') orderBy = { visitCount: 'desc' };
    if (metric === 'recency') orderBy = { lastVisit: 'asc' };

    // For "recency" we want the clients with the OLDEST lastVisit. We
    // need at least one visit to be ranked at all; for recency-of-no-visit
    // we sort by firstVisit asc, but here the user wants long-no-visit,
    // so a null lastVisit should be top. Prisma sorts nulls last by
    // default — for "recency" we exclude not-yet-returned clients.
    const where =
      metric === 'recency'
        ? { tenantId: ctx.tenantId, status: 'active' as const, isTest: false, lastVisit: { not: null } }
        : { tenantId: ctx.tenantId, status: 'active' as const, isTest: false };

    const clients = await ctx.prisma.client.findMany({
      where,
      orderBy,
      take: limit,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        lastVisit: true,
        visitCount: true,
        ...(isSensitive ? { totalSpent: true } : {}),
      },
    });
    return {
      metric,
      totalReturned: clients.length,
      top: clients.map((c) => ({
        clientId: c.id,
        name: c.firstName,
        lastVisit: c.lastVisit?.toISOString().slice(0, 10) ?? null,
        visitCount: c.visitCount,
        ...(isSensitive ? { totalSpentEur: Number(c.totalSpent) } : {}),
      })),
    };
  }

  // ====================================================================
  //  Sprint 14: write tools. Every one of these is gated by human
  //  approval at the AssistantService layer; here they just produce a
  //  preview + perform the action when called for real. Drafting a
  //  message is the exception: a read tool (Copilot audit M8).
  // ====================================================================

  /**
   * Draft a message for a client, for the salon to copy and send herself.
   * Sends nothing and needs no approval (Copilot audit M8): it used to go
   * through an approval card just to show a text, hidden in "Ver detalle",
   * and the model never learnt it had been approved. The text addresses the
   * client as «tú», like every message KiraRoom sends her, and names her
   * next appointment when there is one.
   */
  private async draftFollowUpMessage(
    args: Record<string, unknown>,
    ctx: CopilotToolContext,
  ) {
    const clientId = typeof args.clientId === 'string' ? args.clientId : undefined;
    if (!clientId) return { error: 'missing_clientId' };

    const channel: DraftChannel = args.channel === 'email' ? 'email' : 'whatsapp';
    const occasion: DraftOccasion = (DRAFT_OCCASIONS as readonly string[]).includes(String(args.occasion))
      ? (args.occasion as DraftOccasion)
      : 'confirmation';
    const tone: DraftTone = args.tone === 'formal' ? 'formal' : 'warm';

    // A professional drafts only for the clients she has attended, as she
    // reads their file.
    let reach: Record<string, unknown> = {};
    if (ctx.role === 'staff') {
      const own = await this.findStaffProfessionalId(ctx);
      if (!own) return STAFF_NOT_LINKED;
      reach = clientReachWhere({ professionalId: own });
    }
    const client = await this.prisma.client.findFirst({
      where: { id: clientId, tenantId: ctx.tenantId, ...reach },
      select: { id: true, firstName: true },
    });
    if (!client) return { error: 'client_not_found' };

    const tenant = await (this.prisma as any).tenant
      ?.findUnique?.({ where: { id: ctx.tenantId }, select: { name: true, timezone: true } })
      .catch(() => null);
    const salonName: string | null = tenant?.name?.trim() || null;

    // Her next appointment, for a confirmation or a reminder.
    let next: { date: Date; time: string } | null = null;
    if (occasion === 'confirmation' || occasion === 'reminder') {
      const today = new Date(`${salonToday(safeTimeZone(tenant?.timezone), this.now())}T00:00:00.000Z`);
      const appt = await (this.prisma as any).appointment
        ?.findFirst?.({
          where: {
            tenantId: ctx.tenantId,
            clientId,
            isTest: false,
            status: { in: ['pending', 'confirmed'] },
            scheduledDate: { gte: today },
          },
          orderBy: [{ scheduledDate: 'asc' }, { scheduledTime: 'asc' }],
          select: { scheduledDate: true, scheduledTime: true },
        })
        .catch(() => null);
      if (appt?.scheduledDate && appt?.scheduledTime) next = { date: appt.scheduledDate, time: appt.scheduledTime };
    }

    const draft = composeFollowUp({
      name: client.firstName,
      salonName,
      occasion,
      tone,
      next: next ? { date: spanishDate(next.date), time: next.time } : null,
      customText: typeof args.customText === 'string' ? args.customText.slice(0, 1000) : undefined,
    });

    return {
      clientId,
      clientFirstName: client.firstName,
      channel: channel === 'email' ? 'email' : 'WhatsApp',
      occasion: DRAFT_OCCASION_LABEL[occasion],
      tone: tone === 'formal' ? 'formal' : 'cercano',
      ...(channel === 'email' ? { subject: draftSubject(occasion, salonName) } : {}),
      draft,
      sent: false,
      instructions:
        'This is only a draft: nothing was sent and nothing needs approving. Show the draft text in your reply exactly as ' +
        'it is, and tell the user (in her language) to copy it and send it herself from her WhatsApp or email. ' +
        'You cannot send this free text: the only WhatsApp you can send is an approved template through send_message, ' +
        'and only when that action is available to her.',
    };
  }

/**
 * Send a single WhatsApp template message to a client.
 * Sprint 14 keeps this self-contained: it looks up the tenant's
 * active WhatsApp connection, decrypts the access token, and
 * dispatches via Meta Cloud API. If anything is missing, returns
 * a structured error so the user can fix the connection first.
 */
/**
 * Whether a send_message would go out: everything but the send itself.
 * It runs before the approval card too (approvalPrecheck), so the owner is
 * not asked to approve a WhatsApp that cannot be sent (no connection, no
 * phone, no consent): the card used to be shown and fail once approved.
 */
private async sendMessageCheck(
  args: Record<string, unknown>,
  ctx: CopilotToolContext,
): Promise<
  | { error: string; message?: string }
  | { client: { id: string; firstName: string; phone: string }; conn: any; token: string | null }
> {
  const clientId = args.clientId as string | undefined;
  const templateName = args.templateName as string | undefined;
  if (!clientId) return { error: 'missing_clientId' };
  if (!templateName) return { error: 'missing_templateName' };

  // Only roles that can send messages (manager+ or staff for own clients).
  const canSend = ['owner', 'admin', 'manager', 'staff', 'receptionist', 'saas_owner'].includes(ctx.role);
  if (!canSend) {
    return { error: 'forbidden', message: 'Tu rol no puede enviar mensajes.' };
  }

  // Staff: can only send to clients they have an appointment with.
  if (ctx.role === 'staff') {
    const owns = await this.prisma.appointment.findFirst({
      where: { clientId, tenantId: ctx.tenantId, professionalId: { in: await this.staffProfessionalIds(ctx) } },
      select: { id: true },
    });
    if (!owns) {
      return { error: 'forbidden', message: 'Solo puedes escribir a tus clientas.' };
    }
  }

  const client = await this.prisma.client.findFirst({
    where: { id: clientId, tenantId: ctx.tenantId },
    select: { id: true, firstName: true, phone: true },
  });
  if (!client) return { error: 'client_not_found' };
  if (!client.phone) return { error: 'client_has_no_phone', message: 'La clienta no tiene teléfono en su ficha.' };

  const conn: any = await (this.prisma as any).whatsAppConnection?.findUnique?.({
    where: { tenantId: ctx.tenantId },
  });
  if (!conn || !conn.isActive) {
    return { error: 'whatsapp_not_connected', message: 'Conecta WhatsApp en Ajustes antes de enviar.' };
  }
  if (!conn.accessTokenEnc || !conn.phoneNumberId) {
    return { error: 'whatsapp_not_connected', message: 'Conexión WhatsApp incompleta.' };
  }

  // A promotion (a campaign's kr_promo_* template, or any template Meta files
  // as MARKETING) only to a client who opted in to WhatsApp promotions and
  // has not replied BAJA since: Meta's policy, and the client's choice. This
  // tool used to send any template to any client. A template whose category
  // cannot be told counts as a promotion.
  const kind = standardTemplateKind(templateName);
  let token: string | null = null;
  let promotion = kind === 'marketing';
  if (kind === 'unknown') {
    token = decryptAes(conn.accessTokenEnc);
    promotion = (await templateCategory(token, conn.wabaId, templateName)) !== 'UTILITY';
  }
  if (promotion) {
    const accepted = await clientsWhoAcceptedWhatsAppMarketing(this.prisma, ctx.tenantId, [client.id]);
    if (!accepted.has(client.id)) {
      return {
        error: 'no_whatsapp_marketing_consent',
        message:
          'Esta clienta no ha aceptado recibir promociones por WhatsApp (o respondió BAJA). ' +
          'Solo puedes enviarle avisos de sus citas.',
      };
    }
  } else {
    // An appointment notice: only to a client who gets her notices by
    // WhatsApp (off by default; the booking checkbox or the salon turns it
    // on), as the reminders read it. Only the promotions consent used to be
    // checked, so any client could get a WhatsApp she never asked for.
    const prefs = await this.prisma.notificationPreference
      .findUnique({ where: { clientId: client.id }, select: { preferences: true } })
      .catch(() => null);
    if (!noticeChannelsOf(prefs?.preferences).whatsapp) {
      return {
        error: 'no_whatsapp_notices',
        message:
          'Esta clienta no recibe los avisos de sus citas por WhatsApp. ' +
          'Puedes activarlo en su ficha si ella lo pide, o avisarla por otro canal.',
      };
    }
  }
  return { client: { ...client, phone: client.phone }, conn, token };
}

private async sendMessage(
  args: Record<string, unknown>,
  ctx: CopilotToolContext,
) {
  const checked = await this.sendMessageCheck(args, ctx);
  if ('error' in checked) return checked;
  const { client, conn } = checked;
  const clientId = client.id;
  const templateName = String(args.templateName);
  const token = checked.token ?? decryptAes(conn.accessTokenEnc); // best-effort: see helper below
  // The number as Meta wants it: international, digits only ("600 111 222"
  // in the client file is "34600111222"), as the other WhatsApp senders do.
  const tenant = await this.prisma.tenant
    ?.findUnique?.({ where: { id: ctx.tenantId }, select: { country: true } })
    .catch(() => null);
  const to = normalizePhone(client.phone, tenant?.country ?? 'ES').replace(/\D/g, '');
  const vars = (args.templateVars as Record<string, string>) ?? {};
  const languageCode = (args.languageCode as string) ?? 'es';
  const components = [
    {
      type: 'body',
      parameters: templateVarKeys(vars).map((k) => ({ type: 'text', text: templateParam(String(vars[k] ?? '')) })),
    },
  ];

  const resp = await metaFetch(
    `${metaGraphBaseUrl(process.env.META_API_VERSION)}/${conn.phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: templateName,
          language: { code: languageCode },
          components,
        },
      }),
    },
  );

  if (!resp.ok) {
    const body = await resp.text();
    return { error: 'whatsapp_send_failed', status: resp.status, body };
  }
  const json: any = await resp.json();
  const messageId = json?.messages?.[0]?.id ?? null;
  return {
    ok: true,
    clientId,
    templateName,
    messageId,
    sentAt: new Date().toISOString(),
  };
}

/**
 * Reschedule an appointment. Owner / manager / receptionist can move
 * any appointment; staff can only move their own.
 *
 * Through the panel's own path (AppointmentsService.rescheduleVisit): the
 * status must allow it, every professional in the visit must be free and on
 * shift, the visit's services move with it, and the start the reminders
 * read, the reminders and the notice to the client follow. It used to write
 * the date and time straight into the row: on top of another booking,
 * outside hours, on a cancelled appointment, with the reminders still set
 * for the old time.
 */
private async rescheduleAppointment(
  args: Record<string, unknown>,
  ctx: CopilotToolContext,
) {
  const appointmentId = args.appointmentId as string | undefined;
  const newDate = args.newDate as string | undefined;
  const newTime = args.newTime as string | undefined;
  if (!appointmentId) return { error: 'missing_appointmentId' };
  if (!newDate || !/^\d{4}-\d{2}-\d{2}$/.test(newDate)) {
    return { error: 'invalid_newDate' };
  }
  if (!newTime || !/^\d{2}:\d{2}$/.test(newTime)) {
    return { error: 'invalid_newTime' };
  }

  const appt = await this.prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      id: true,
      tenantId: true,
      professionalId: true,
      scheduledDate: true,
      scheduledTime: true,
      client: { select: { firstName: true } },
    },
  });
  if (!appt) return { error: 'appointment_not_found' };
  if (appt.tenantId !== ctx.tenantId) {
    return { error: 'forbidden', message: 'La cita no pertenece a tu salón.' };
  }

  // Staff can only reschedule their own. `ctx.userId` is the User id;
  // we map to Professional id via the existing helper.
  if (ctx.role === 'staff') {
    const profId = await this.findStaffProfessionalId(ctx);
    if (!profId || profId !== appt.professionalId) {
      return { error: 'forbidden', message: 'Solo puedes mover tus propias citas.' };
    }
  }

  if (!this.appointments) return { error: 'unavailable' };
  try {
    await this.appointments.rescheduleVisit(
      { id: ctx.userId, tenantId: ctx.tenantId, role: ctx.role },
      appointmentId,
      newDate,
      newTime,
    );
  } catch (err) {
    if (err instanceof HttpException) {
      const status = err.getStatus();
      return {
        error: status === 409 ? 'slot_unavailable' : status === 403 || status === 404 ? 'forbidden' : 'invalid_input',
        message: err.message,
      };
    }
    throw err;
  }

  const updated = await this.prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: { scheduledDate: true, scheduledTime: true },
  });
  return {
    ok: true,
    appointmentId,
    from: { date: appt.scheduledDate, time: appt.scheduledTime },
    to: {
      date: updated ? updated.scheduledDate.toISOString().slice(0, 10) : newDate,
      time: updated?.scheduledTime ?? newTime,
    },
    clientFirstName: appt.client?.firstName ?? null,
  };
}

  private async staffProfessionalIds(ctx: CopilotToolContext): Promise<string[]> {
  const prof = await this.prisma.professional.findFirst({
    where: { tenantId: ctx.tenantId, user: { id: ctx.userId } },
    select: { id: true },
  });
  return prof ? [prof.id] : [];
}

  /**
   * Sprint 15: mark a confirmed/pending appointment as a no-show.
   * Receptionist / manager / owner only (stylists cannot).
   * No fee (D6, see the tool definition): it only changes the status.
   */
  /**
   * Why this appointment cannot be marked a no-show (null = it can): not of
   * the salon, a status the table does not allow, or not begun yet. It runs
   * before the approval card too.
   */
  private async noShowRefusal(
    appointmentId: string,
    ctx: CopilotToolContext,
  ): Promise<{ error: string; message?: string } | null> {
    const appt = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      select: {
        id: true,
        tenantId: true,
        status: true,
        scheduledDate: true,
        scheduledTime: true,
        tenant: { select: { timezone: true } },
      },
    });
    if (!appt) return { error: 'appointment_not_found' };
    if (appt.tenantId !== ctx.tenantId) {
      return { error: 'forbidden', message: 'La cita no pertenece a tu salón.' };
    }
    // The appointments' transition table decides, here as in the panel.
    if (!canTransition(appt.status, 'no_show')) {
      return { error: 'invalid_status', message: transitionRefusal(appt.status, 'no_show') };
    }
    if (startsLater(appt, safeTimeZone(appt.tenant?.timezone), this.now())) {
      return { error: 'not_started', message: NO_SHOW_BEFORE_START_MESSAGE };
    }
    return null;
  }

  private async markNoShow(
    args: Record<string, unknown>,
    ctx: CopilotToolContext,
  ) {
    if (!['owner', 'admin', 'manager', 'receptionist', 'saas_owner'].includes(ctx.role)) {
      return { error: 'forbidden', message: 'Solo recepcionista / manager / owner pueden marcar no-show.' };
    }
    const appointmentId = args.appointmentId as string | undefined;
    if (!appointmentId) return { error: 'missing_appointmentId' };

    const refused = await this.noShowRefusal(appointmentId, ctx);
    if (refused) return refused;
    if (!this.appointments) return { error: 'unavailable' };

    // The same path as the panel's "No se presentó": checked against the
    // table again at the write, followed by the no-show notice and the
    // activity entry. It used to be a bare status write.
    let updated: { id: string; status: string };
    try {
      updated = await this.appointments.changeStatus(
        { id: ctx.userId, tenantId: ctx.tenantId, role: ctx.role },
        appointmentId,
        'no_show',
        {},
      );
    } catch (err) {
      if (err instanceof HttpException) {
        return { error: 'invalid_status', message: err.message };
      }
      throw err;
    }

    const client = await this.prisma.appointment
      .findUnique({ where: { id: appointmentId }, select: { client: { select: { firstName: true } } } })
      .catch(() => null);
    return {
      ok: true,
      appointmentId: updated.id,
      status: updated.status,
      clientFirstName: client?.client?.firstName ?? null,
    };
  }

  /**
   * Sprint 15: issue a general single-use discount code (Promotion): any
   * client may bring it, and it is applied at the till. It used to take a
   * clientId and say "para una clienta específica" in the approval, while
   * nothing tied the code to her: now it is what it says, a general code
   * with one use, valid from today (the salon's day) for expiresInDays days.
   * Owner / admin / saas_owner ONLY — receptionists do not mint
   * coupons (per RFC §5).
   */
  private async createCoupon(
    args: Record<string, unknown>,
    ctx: CopilotToolContext,
  ) {
    if (!['owner', 'admin', 'saas_owner'].includes(ctx.role)) {
      return { error: 'forbidden', message: 'Solo el owner puede crear cupones.' };
    }
    const discountPercent = Number(args.discountPercent ?? 0);
    if (!Number.isFinite(discountPercent) || discountPercent <= 0 || discountPercent > 100) {
      return { error: 'invalid_discountPercent' };
    }
    const expiresInDays = Math.min(Math.max(Math.round(Number(args.expiresInDays ?? 30)) || 30, 1), 365);
    // Calendar days, stored as their UTC midnight like the panel's form: the
    // till reads them in the salon's clock (promotion-at-till.ts).
    const tenant = await this.prisma.tenant.findUnique({ where: { id: ctx.tenantId }, select: { timezone: true } });
    const today = salonToday(safeTimeZone(tenant?.timezone), this.now());
    const startDate = new Date(`${today}T00:00:00.000Z`);
    const endDate = new Date(`${addDays(today, expiresInDays - 1)}T00:00:00.000Z`);

    // Generate a unique code: 6-char random uppercase. Retries up to
    // 3 times if we hit the @@unique([tenantId, code]) constraint.
    const code = await this.generateUniqueCouponCode(ctx.tenantId);

    const created = await this.prisma.promotion.create({
      data: {
        tenantId: ctx.tenantId,
        name: 'Cupón general',
        code,
        type: 'PERCENTAGE',
        value: discountPercent as any,
        maxUses: 1,
        startDate,
        endDate,
        isActive: true,
        applicableServiceIds: [],
        applicableProductIds: [],
      },
      select: { id: true, code: true, endDate: true },
    });

    return {
      ok: true,
      couponId: created.id,
      code: created.code,
      discountPercent,
      maxUses: 1,
      /** The last day it is valid (the salon's calendar day). */
      validUntil: created.endDate?.toISOString().slice(0, 10) ?? null,
      expiresAt: created.endDate?.toISOString() ?? null,
      usableAt: 'till',
    };
  }

  private async generateUniqueCouponCode(tenantId: string): Promise<string> {
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I/L/O/0/1
    for (let attempt = 0; attempt < 5; attempt++) {
      let candidate = '';
      for (let i = 0; i < 6; i++) {
        candidate += alphabet[Math.floor(Math.random() * alphabet.length)];
      }
      const clash = await this.prisma.promotion.findFirst({
        where: { tenantId, code: candidate },
        select: { id: true },
      });
      if (!clash) return candidate;
    }
    // Astronomically unlikely; fall back to a UUID-shaped code.
    return `KIRA-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  }

  /**
   * Sprint 15: pick the top N wait-list clients that match a freed slot
   * and notify them. Salon owner / admin only.
   *
   * This used to mark them 'notified' and send nothing: the description
   * said "the actual send is via send_message", which nothing chained, so
   * the staff approved "Notificar a las 5 primeras clientas" and the
   * clients were never told -- and, being 'notified', dropped out of the
   * next freed slot. Now each one goes through WaitListService.notify, the
   * same path as the panel's "Avisar": email, the salon's WhatsApp or SMS,
   * marked notified only when a channel delivered, and the answer says per
   * client what went out or why nothing did.
   */
  private async closeWaitlistSlot(
    args: Record<string, unknown>,
    ctx: CopilotToolContext,
  ) {
    if (!['owner', 'admin', 'saas_owner'].includes(ctx.role)) {
      return { error: 'forbidden', message: 'Solo el propietario o un administrador del salón pueden avisar a la lista de espera.' };
    }
    const serviceId = args.serviceId as string | undefined;
    const windowStart = args.windowStart as string | undefined;
    const windowEnd = args.windowEnd as string | undefined;
    // 1 to 10: each one is a real message.
    const requested = Math.floor(Number(args.topN ?? 5));
    const topN = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 10) : 5;
    const professionalId = (args.professionalId as string | undefined) ?? null;

    if (!serviceId) return { error: 'missing_serviceId' };
    if (!windowStart || !/^\d{4}-\d{2}-\d{2}$/.test(windowStart)) return { error: 'invalid_windowStart' };
    if (!windowEnd || !/^\d{4}-\d{2}-\d{2}$/.test(windowEnd)) return { error: 'invalid_windowEnd' };
    const time = args.time as string | undefined;
    if (time !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return { error: 'invalid_time' };
    if (!this.waitList) {
      return { error: 'unavailable', message: 'El aviso a la lista de espera no está disponible ahora mismo. No se ha avisado a nadie.' };
    }

    const start = new Date(`${windowStart}T00:00:00`);
    const end = new Date(`${windowEnd}T23:59:59`);

    const candidates = await this.prisma.waitList.findMany({
      where: {
        tenantId: ctx.tenantId,
        serviceId,
        // Told about an earlier slot is still waiting; blocked or removed clients are not told.
        status: { in: ['waiting', 'notified'] },
        client: { status: 'active' },
        ...(professionalId
          ? { OR: [{ professionalId: null }, { professionalId }] }
          : {}),
        AND: [
          { OR: [{ earliestDate: null }, { earliestDate: { lte: end } }] },
          { OR: [{ latestDate: null }, { latestDate: { gte: start } }] },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: topN,
      include: {
        client: { select: { id: true, firstName: true, phone: true } },
      },
    });

    if (candidates.length === 0) {
      return {
        ok: true,
        notified: 0,
        clients: [],
        message: 'No hay nadie en la lista de espera para ese servicio y esas fechas. No se ha avisado a nadie.',
      };
    }

    // One day: the slot's date goes in the notice. A range: the notice says
    // there are free slots, without a date it cannot vouch for.
    const slot = {
      date: windowStart === windowEnd ? windowStart : undefined,
      time: windowStart === windowEnd ? time : undefined,
      professionalId: professionalId ?? undefined,
    };

    const clients: Array<{
      waitListId: string;
      clientId: string;
      firstName: string;
      notified: boolean;
      summary: string;
      channels?: NotifyResult['channels'];
    }> = [];
    for (const c of candidates) {
      try {
        const res = await this.waitList.notify(ctx.tenantId, c.id, slot, ctx.userId);
        clients.push({
          waitListId: c.id,
          clientId: c.client.id,
          firstName: c.client.firstName,
          notified: res.notified,
          summary: res.summary,
          channels: res.channels,
        });
      } catch (err) {
        // Not in the plan, entry closed meanwhile... nothing was sent.
        clients.push({
          waitListId: c.id,
          clientId: c.client.id,
          firstName: c.client.firstName,
          notified: false,
          summary: `No se ha podido avisar: ${(err as Error).message}`,
        });
      }
    }

    const notified = clients.filter((c) => c.notified).length;
    const lines = clients.map((c) => `${c.firstName}: ${c.summary}`).join('\n');
    const head =
      notified === clients.length
        ? `Avisados ${notified} de ${clients.length} clientes de la lista de espera.`
        : notified === 0
          ? `No se ha podido avisar a ninguno de los ${clients.length} clientes; siguen en espera.`
          : `Avisados ${notified} de ${clients.length} clientes; los demás siguen en espera.`;
    const result = { notified, notNotified: clients.length - notified, clients, message: `${head}\n${lines}` };
    // Nothing delivered: an error, so the approval card does not show it
    // as done.
    return notified === 0 ? { error: 'not_delivered', ...result } : { ok: true, ...result };
  }
}

function isLocationError(v: { id: string; name: string } | { error: string; message: string } | null): v is { error: string; message: string } {
  return !!v && 'error' in v;
}

/**
 * A number the model asked for, kept within [min, max] (Copilot audit M5):
 * "dame todas mis clientas" used to send the whole client base to the AI in
 * one request. Not a number: the default.
 */
export function bounded(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.floor(Number(value ?? fallback));
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}

// --------------------------------------------------------------------
//  Helpers for the write tools (sprint 14)
// --------------------------------------------------------------------

/* Drafts (draft_follow_up_message) */

export const DRAFT_OCCASIONS = ['confirmation', 'reminder', 'reactivation', 'custom'] as const;
export type DraftOccasion = (typeof DRAFT_OCCASIONS)[number];
type DraftChannel = 'whatsapp' | 'email';
type DraftTone = 'warm' | 'formal';

/** What each occasion is called in the salon's words (the card used to say «de confirmation»). */
export const DRAFT_OCCASION_LABEL: Record<DraftOccasion, string> = {
  confirmation: 'confirmación de cita',
  reminder: 'recordatorio de cita',
  reactivation: 'volver a verla',
  custom: 'mensaje propio',
};

function draftSubject(occasion: DraftOccasion, salonName: string | null): string {
  const at = salonName ? ` en ${salonName}` : '';
  switch (occasion) {
    case 'confirmation':
      return `Confirma tu cita${at}`;
    case 'reminder':
      return `Recordatorio de tu cita${at}`;
    case 'reactivation':
      return salonName ? `Te echamos de menos en ${salonName}` : 'Te echamos de menos';
    default:
      return salonName ?? 'Un mensaje del salón';
  }
}

/**
 * The draft's text, deterministic (no extra model call). It addresses the
 * client as «tú» in both tones, as every message KiraRoom sends her does
 * ("Hola Carmen, te recordamos tu cita..."): the formal one used to open
 * with «Estimada» and close «Atentamente» around a «te» body.
 */
export function composeFollowUp(input: {
  name: string;
  salonName: string | null;
  occasion: DraftOccasion;
  tone: DraftTone;
  /** Her next appointment, in Spanish ("jueves, 20 de noviembre"), when known. */
  next?: { date: string; time: string } | null;
  customText?: string;
}): string {
  const formal = input.tone === 'formal';
  const greeting = formal ? `Hola, ${input.name}:` : `¡Hola, ${input.name}!`;
  const at = input.salonName ? ` en ${input.salonName}` : '';
  const when = input.next ? ` del ${input.next.date} a las ${input.next.time}` : '';

  let body: string;
  switch (input.occasion) {
    case 'reminder':
      body = input.next
        ? `Te recordamos tu cita${at}${when}. ¡Te esperamos!`
        : `Te recordamos tu próxima cita${at}. ¡Te esperamos!`;
      break;
    case 'reactivation':
      body = `Hace tiempo que no te vemos${input.salonName ? ` por ${input.salonName}` : ' por el salón'}. ¿Te apetece reservar una cita? Nos encantará verte.`;
      break;
    case 'custom':
      body = input.customText?.trim() || '¿En qué podemos ayudarte?';
      break;
    case 'confirmation':
    default:
      body = input.next
        ? `Te escribimos para confirmar tu cita${at}${when}. ¿Nos confirmas que te viene bien?`
        : `Te escribimos para confirmar tu próxima cita${at}. ¿Nos confirmas que te viene bien?`;
      break;
  }
  const closer = formal ? 'Un saludo,' : '¡Gracias!';
  const signature = input.salonName ?? 'El equipo del salón';
  return `${greeting}\n\n${body}\n\n${closer}\n${signature}`;
}

/**
 * Decrypt an AES-encrypted WhatsApp access token. The encryption
 * envelope used in the existing WhatsApp module is `aes:` + base64
 * (see `EncryptionService`). In tests we monkey-patch this helper to
 * return a literal token so the network call is skipped.
 */
function decryptAes(cipher: string): string {
  try {
    // Lazy-require to avoid loading EncryptionService at module-init
    // time (which would break unit tests that import this file).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { EncryptionService } = require('../../common/encryption/encryption.service');
    // A fresh instance is fine for one-shot decrypt; the service holds
    // no per-request state.
    const svc = new EncryptionService();
    return svc.decrypt(cipher);
  } catch (err) {
    throw new Error(`decrypt_failed:${(err as Error).message}`);
  }
}

/**
 * Thin fetch wrapper so tests can mock the network call without
 * pulling in undici / nock.
 */
async function metaFetch(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, init);
}

/**
 * A template's variable names in Meta's order: "1", "2", ... "10" by
 * number (a plain sort put "10" before "2"), anything else after them.
 */
export function templateVarKeys(vars: Record<string, unknown>): string[] {
  const num = (k: string) => (/^\d+$/.test(k) ? Number(k) : Number.POSITIVE_INFINITY);
  return Object.keys(vars).sort((a, b) => num(a) - num(b) || a.localeCompare(b));
}

/**
 * What a template is, from its name alone: KiraRoom's standard appointment
 * notices are UTILITY; a WhatsApp campaign's (kr_promo_*) are MARKETING.
 * Anything else has to be asked of Meta (templateCategory).
 */
export function standardTemplateKind(name: string): 'utility' | 'marketing' | 'unknown' {
  if (name.startsWith('kr_promo_')) return 'marketing';
  if (STANDARD_TEMPLATES.some((t) => t.name === name && t.category === 'UTILITY')) return 'utility';
  return 'unknown';
}

/** Meta's category of a template on the salon's account; null when it cannot be told. */
async function templateCategory(token: string, wabaId: string | null | undefined, name: string): Promise<string | null> {
  if (!wabaId) return null;
  try {
    const resp = await metaFetch(
      `${metaGraphBaseUrl(process.env.META_API_VERSION)}/${wabaId}/message_templates?fields=name,category&name=${encodeURIComponent(name)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!resp.ok) return null;
    const body: any = await resp.json();
    const found = (body?.data ?? []).find((t: any) => t?.name === name);
    return typeof found?.category === 'string' ? found.category.toUpperCase() : null;
  } catch {
    return null;
  }
}
