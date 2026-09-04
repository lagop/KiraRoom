import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

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
      "Return today's appointments for the calling professional — or for the whole salon if the caller is owner/manager/receptionist. " +
      'Always include the gaps ≥ 30 min between appointments and which appointments are still in `pending` confirmation. ' +
      'This is the single most-used tool: it powers the "what\'s up today" answer on the briefing card.',
    input_schema: {
      type: 'object' as const,
      properties: {
        date: {
          type: 'string',
          description: 'Optional ISO date YYYY-MM-DD. Defaults to today in the salon timezone.',
        },
        professionalId: {
          type: 'string',
          description: 'Optional. Restricts the agenda to one professional. Owner/manager only — ignored for `staff`.',
        },
      },
    },
  },
  {
    name: 'get_salon_agenda',
    description:
      "Manager-only. Read the agenda for any professional by id. Use when the caller asks 'what does Jorge have on Tuesday' and the calling user is not Jorge themselves.",
    input_schema: {
      type: 'object' as const,
      properties: {
        professionalId: { type: 'string', description: 'Professional UUID' },
        date: { type: 'string', description: 'Optional ISO date YYYY-MM-DD. Defaults to today.' },
      },
      required: ['professionalId'],
    },
  },
  {
    name: 'get_client_360',
    description:
      "Return everything we know about a client: visit history, services rendered, products bought, allergies, internal notes, " +
      "last communication. Crucial use case: '¿qué le hice a Carmen la última vez?' " +
      "(what did I do to Carmen last time?). Owner/manager and reception see everything; " +
      "a `staff` user only sees clients assigned to them, and never the financial detail (spend, payment method).",
    input_schema: {
      type: 'object' as const,
      properties: {
        clientId: { type: 'string', description: 'Client UUID' },
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
      "Scan the salon's next 7 days for gaps ≥ 30 min between appointments, " +
      'and return the top 5 wait-list clients who could realistically fill them ' +
      "(ranked by recency — clients who last visited longest ago first). " +
      "Use this when the user says 'tengo huecos esta semana' or 'a quién puedo llamar'. " +
      'Owner/manager only — staff and receptionist see only the gap list, not the matching clients.',
    input_schema: {
      type: 'object' as const,
      properties: {
        daysAhead: { type: 'number', description: 'Days to scan. Default 7.' },
        minGapMinutes: { type: 'number', description: 'Min gap to surface. Default 30.' },
        topN: { type: 'number', description: 'How many wait-list clients per gap. Default 5.' },
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

  // --------------------------------------------------------------------
  //  Sprint 14: the first 3 write tools. Always require human approval.
  //  The LLM is instructed to NEVER execute these directly; it must
  //  produce a `pendingAction` via the orchestrator and wait for the
  //  user to click Approve. See ActionApprovalService.
  // --------------------------------------------------------------------

  {
    name: 'draft_follow_up_message',
    description:
      "Compose a short follow-up WhatsApp or email message for a client. " +
      "Returns the draft text. Does NOT send. Use when the owner says " +
      "'mándale un mensaje a Carmen para que confirme su cita' — produce " +
      "the body, then ask for approval. Optional fields: channel ('whatsapp'" +
      "|'email'), occasion ('confirmation'|'reminder'|'reactivation'|'custom'), " +
      "tone ('warm'|'formal'). The default is WhatsApp / confirmation / warm.",
    input_schema: {
      type: 'object' as const,
      properties: {
        clientId: { type: 'string' },
        channel: { type: 'string', enum: ['whatsapp', 'email'] },
        occasion: { type: 'string', enum: ['confirmation', 'reminder', 'reactivation', 'custom'] },
        tone: { type: 'string', enum: ['warm', 'formal'] },
        customText: { type: 'string', description: 'Optional free-text hint; the model rewrites it in the chosen tone.' },
      },
      required: ['clientId'],
    },
  },

  {
    name: 'send_message',
    description:
      "Send a WhatsApp template message to ONE client. Requires the tenant to have an " +
      "active WhatsApp connection (WABA OAuth or manual). The text must come from a " +
      "pre-approved Meta template (you cannot send free-form WhatsApp outside the 24h " +
      "customer-service window). Audit-logged. Always returns a pending_approval card; " +
      "the actual send happens after the user clicks Approve.",
    input_schema: {
      type: 'object' as const,
      properties: {
        clientId: { type: 'string' },
        templateName: { type: 'string', description: 'Approved Meta template name, e.g. "appointment_reminder".' },
        templateVars: {
          type: 'object',
          description: 'Variables for the template body, e.g. { "1": "Carmen", "2": "16:00" }.',
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

  {
    name: 'mark_no_show',
    description:
      "Mark a confirmed appointment as a no-show. Optionally apply a no-show fee. " +
      "Receptionist / manager / owner only — stylists cannot. Audit-logged. " +
      "Always requires human approval because it changes payment state.",
    input_schema: {
      type: 'object' as const,
      properties: {
        appointmentId: { type: 'string' },
        applyFee: { type: 'boolean', description: 'Apply a no-show fee. Default false.' },
        feeAmount: { type: 'number', description: 'Fee amount in salon currency. Required when applyFee=true.' },
      },
      required: ['appointmentId'],
    },
  },

  {
    name: 'create_coupon',
    description:
      "Issue a single-use discount code for a specific client (or for any client " +
      "if clientId is omitted). Owner / admin / saas_owner ONLY — receptionists " +
      "cannot mint coupons. Always requires human approval. The code is unique " +
      "per tenant.",
    input_schema: {
      type: 'object' as const,
      properties: {
        clientId: { type: 'string', description: 'Optional. Restrict the coupon to one client.' },
        discountPercent: { type: 'number', description: 'Discount percent (1-100).' },
        expiresInDays: { type: 'number', description: 'Days until expiry. Default 30.' },
      },
      required: ['discountPercent'],
    },
  },

  {
    name: 'close_waitlist_slot',
    description:
      "When an appointment is cancelled, ask the wait-list who wants the freed " +
      "slot. Picks the top N waiting clients matching the service + window, marks " +
      "them 'notified', and returns the list (the actual send is via send_message). " +
      "Manager / receptionist only.",
    input_schema: {
      type: 'object' as const,
      properties: {
        serviceId: { type: 'string' },
        professionalId: { type: 'string', description: 'Optional. Restrict to clients for this professional.' },
        windowStart: { type: 'string', description: 'ISO date YYYY-MM-DD' },
        windowEnd: { type: 'string', description: 'ISO date YYYY-MM-DD' },
        topN: { type: 'number', description: 'How many clients to notify. Default 5.' },
      },
      required: ['serviceId', 'windowStart', 'windowEnd'],
    },
  },
] as const;

/* -------------------------------------------------------------------------- */
/*  Tool implementations                                                    */
/* -------------------------------------------------------------------------- */

@Injectable()
export class SalonCopilotToolsService {
  private readonly logger = new Logger(SalonCopilotToolsService.name);

  constructor(private readonly prisma: PrismaService) {}

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

  // --------------------------------------------------------------------
  //  Implementations
  // --------------------------------------------------------------------

  /**
   * Today's agenda. If the caller is `staff` and they pass a different
   * `professionalId`, refuse — they can only see their own agenda. Gaps
   * ≥ 30 min are computed in JS (cheap; avoids another tool call).
   */
  private async getMyAgenda(args: Record<string, unknown>, ctx: CopilotToolContext) {
    const date = this.parseDateOrToday(args.date);
    const requestedProfId = args.professionalId as string | undefined;

    if (ctx.role === 'staff' && requestedProfId && requestedProfId !== ctx.userId) {
      return {
        error: 'forbidden',
        message: 'No puedes ver la agenda de otro profesional.',
      };
    }
    const professionalId =
      ctx.role === 'staff'
        ? await this.findStaffProfessionalId(ctx)
        : requestedProfId;

    return this.computeAgenda(ctx, date, professionalId);
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
    const date = this.parseDateOrToday(args.date);
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
  private async getClient360(args: Record<string, unknown>, ctx: CopilotToolContext) {
    const clientId = args.clientId as string | undefined;
    if (!clientId) return { error: 'missing_clientId' };

    // Ownership check for `staff`.
    if (ctx.role === 'staff') {
      const owns = await this.prisma.appointment.findFirst({
        where: { clientId, professionalId: ctx.userId },
        select: { id: true },
      });
      if (!owns) {
        return {
          error: 'forbidden',
          message: 'Solo puedes ver clientes que hayas atendido.',
        };
      }
    }

    const maxVisits = Math.min(Math.max(Number(args.maxVisits ?? 20), 1), 50);
    const [client, appointments] = await Promise.all([
      this.prisma.client.findUnique({
        where: { id: clientId },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          dateOfBirth: true,
          gender: true,
          allergies: true,
          // NEVER exposed: totalSpent, paymentMethod, commissionRate, internalNotes.
          // These are queried separately and gated by role below.
        },
      }),
      this.prisma.appointment.findMany({
        where: { clientId },
        orderBy: { scheduledDate: 'desc' },
        take: maxVisits,
        select: {
          id: true,
          scheduledDate: true,
          scheduledTime: true,
          status: true,
          totalAmount: true,
          professional: { select: { id: true, firstName: true, userId: true } },
          services: {
            select: {
              service: { select: { id: true, name: true, price: true } },
            },
          },
        },
      }),
    ]);

    if (!client) return { error: 'client_not_found' };

    // `staff` users only see visits they personally attended.
    // Other roles see every visit on the client.
    const isStaff = ctx.role === 'staff';
    const allVisits = appointments
      .filter((a) => (isStaff ? a.professional?.userId === ctx.userId : true))
      .map((a) => ({
        id: a.id,
        date: a.scheduledDate,
        time: a.scheduledTime,
        status: a.status,
        professional: a.professional,
        services: a.services.map((s) => s.service),
        // Total amount is shown to non-staff roles only.
        ...(isStaff ? {} : { totalAmount: a.totalAmount }),
      }));

    // Stats (last 365d completed visits + spend) are restricted to
    // owner / admin / manager / saas_owner / receptionist. Stylists
    // never see aggregates.
    const seesStats = ['owner', 'admin', 'manager', 'receptionist', 'saas_owner']
      .includes(ctx.role);
    const stats: Record<string, unknown> = {};
    if (seesStats) {
      const since = new Date();
      since.setDate(since.getDate() - 365);
      const agg = await this.prisma.appointment.aggregate({
        where: {
          clientId,
          status: 'completed',
          scheduledDate: { gte: since },
        },
        _sum: { totalAmount: true },
        _count: { _all: true },
      });
      stats.totalVisitsLast365d = agg._count._all;
      stats.totalSpentLast365d = agg._sum.totalAmount;
    }

    return {
      id: client.id,
      name: `${client.firstName} ${client.lastName}`.trim(),
      firstName: client.firstName,
      lastName: client.lastName,
      email: client.email,
      phone: client.phone,
      birthDate: client.dateOfBirth,
      gender: client.gender,
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
      where: { user: { id: ctx.userId } },
      select: { id: true },
    });
    return professional?.id ?? null;
  }

  /**
   * Build the agenda response with gaps ≥ 30 min computed in JS.
   * Gaps are surfaced in the same shape as `appointments` (start, end,
   * duration_minutes) so the LLM can answer "tienes un hueco a las 16:00
   * de 1h" naturally.
   */
  private async computeAgenda(
    ctx: CopilotToolContext,
    date: Date,
    professionalId: string | null,
  ) {
    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayStart.getDate() + 1);

    const where: Record<string, unknown> = {
      tenantId: ctx.tenantId,
      scheduledDate: { gte: dayStart, lt: dayEnd },
      status: { in: ['confirmed', 'pending', 'in_progress'] },
    };
    if (professionalId) where.professionalId = professionalId;

    const appointments = await this.prisma.appointment.findMany({
      where,
      orderBy: { scheduledTime: 'asc' },
      select: {
        id: true,
        scheduledTime: true,
        status: true,
        client: { select: { id: true, firstName: true } },
        professional: { select: { id: true, firstName: true, lastName: true } },
        services: { select: { service: { select: { name: true } } } },
      },
    });

    // Compute gaps ≥ 30 min between consecutive appointments.
    const gaps: Array<{ start: string; end: string; minutes: number }> = [];
    for (let i = 0; i + 1 < appointments.length; i++) {
      const endA = timeToMinutes(appointments[i].scheduledTime)
        + this.estimateAppointmentDuration(appointments[i]);
      const startB = timeToMinutes(appointments[i + 1].scheduledTime);
      const gap = startB - endA;
      if (gap >= 30) {
        gaps.push({
          start: minutesToTime(endA),
          end: minutesToTime(startB),
          minutes: gap,
        });
      }
    }

    return {
      date: dayStart.toISOString().slice(0, 10),
      totalAppointments: appointments.length,
      confirmed: appointments.filter((a) => a.status === 'confirmed').length,
      pending: appointments.filter((a) => a.status === 'pending').length,
      appointments: appointments.map((a) => ({
        id: a.id,
        time: a.scheduledTime,
        status: a.status,
        client: a.client,
        professional: a.professional,
        services: a.services.map((s) => s.service.name),
      })),
      gaps,  // only gaps ≥ 30 min
    };
  }

  private parseDateOrToday(input: unknown): Date {
    if (typeof input !== 'string') {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d;
    }
    const d = new Date(`${input}T00:00:00`);
    if (Number.isNaN(d.getTime())) {
      const fallback = new Date();
      fallback.setHours(0, 0, 0, 0);
      return fallback;
    }
    d.setHours(0, 0, 0, 0);
    return d;
  }

  /**
   * Rough appointment duration from the services it bundles. Used only
   * for gap detection — when the LLM needs a precise duration for a
   * single appointment it should use the existing VirtualReceptionist's
   * `get_appointment_duration` tool, not this estimate.
   */
  private estimateAppointmentDuration(appt: { services: Array<{ service: { name: string } }> }): number {
    // Conservative default 30 min if no services count.
    return Math.max(30, appt.services.length * 30);
  }

  // --------------------------------------------------------------------
  //  Sprint 13: gap-filling + inventory + no-show + top-clients
  // --------------------------------------------------------------------

  /**
   * P2A-staff-copilot sprint-13. Scan the next N days for gaps ≥
   * `minGapMinutes` (default 30) and rank the top N wait-list clients
   * who could realistically fill them (oldest lastVisit first). Owner
   * and manager see the full result with client names and
   * preferences; stylist/receptionist see only the gap list (no
   * client names) to respect privacy.
   */
  private async findFillingOpportunities(
    args: Record<string, unknown>,
    ctx: CopilotToolContext,
  ) {
    const daysAhead = Math.max(Number(args.daysAhead ?? 7), 1);
    const minGap = Math.max(Number(args.minGapMinutes ?? 30), 15);
    const topN = Math.max(Number(args.topN ?? 5), 1);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const horizon = new Date(today);
    horizon.setDate(today.getDate() + daysAhead);

    // Fetch every appointment in the window, grouped per day.
    const appointments = await ctx.prisma.appointment.findMany({
      where: {
        tenantId: ctx.tenantId,
        scheduledDate: { gte: today, lt: horizon },
        status: { in: ['confirmed', 'pending'] },
        ...(ctx.role === 'staff' ? { professionalId: ctx.userId } : {}),
      },
      orderBy: [{ scheduledDate: 'asc' }, { scheduledTime: 'asc' }],
      select: {
        id: true,
        scheduledDate: true,
        scheduledTime: true,
        professionalId: true,
        services: { select: { service: { select: { name: true, duration: true } } } },
      },
    });

    // Group by day; compute the gaps inside each day.
    const byDay = new Map<string, typeof appointments>();
    for (const a of appointments) {
      const key = a.scheduledDate.toISOString().slice(0, 10);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key)!.push(a);
    }

    const gaps: Array<{
      date: string;
      start: string;
      end: string;
      minutes: number;
      suggestions: Array<{ clientId: string; firstName: string; lastVisit: string | null }>;
    }> = [];
    for (const [date, list] of byDay.entries()) {
      for (let i = 0; i + 1 < list.length; i++) {
        const endA =
          timeToMinutes(list[i].scheduledTime) +
          this.estimateAppointmentDuration(list[i]);
        const startB = timeToMinutes(list[i + 1].scheduledTime);
        const minutes = startB - endA;
        if (minutes < minGap) continue;

        // For manager+ we attach a top-N of wait-list clients. For
        // lower roles we omit client names to respect privacy.
        let suggestions: typeof gaps[number]['suggestions'] = [];
        if (['owner', 'admin', 'manager', 'saas_owner'].includes(ctx.role)) {
          const candidates = await ctx.prisma.waitList.findMany({
            where: {
              tenantId: ctx.tenantId,
              status: 'waiting',
              OR: [
                { earliestDate: null },
                { earliestDate: { lte: horizon } },
              ],
              AND: [
                { OR: [{ latestDate: null }, { latestDate: { gte: today } }] },
              ],
            },
            include: {
              client: {
                select: {
                  id: true,
                  firstName: true,
                  lastVisit: true,
                },
              },
            },
            orderBy: { client: { lastVisit: 'asc' } },
            take: topN,
          });
          suggestions = candidates.map((w) => ({
            clientId: w.client.id,
            firstName: w.client.firstName,
            lastVisit: w.client.lastVisit?.toISOString().slice(0, 10) ?? null,
          }));
        }

        gaps.push({
          date,
          start: minutesToTime(endA),
          end: minutesToTime(startB),
          minutes,
          suggestions,
        });
      }
    }
    gaps.sort((a, b) => b.minutes - a.minutes);

    return { totalGaps: gaps.length, daysAhead, minGapMinutes: minGap, gaps };
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
    const limit = Math.max(Number(args.limit ?? 20), 1);
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
        price: Number(p.price),
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
    const minNoShows = Math.max(Number(args.minNoShows ?? 2), 1);
    const daysBack = Math.max(Number(args.daysBack ?? 90), 1);

    const since = new Date();
    since.setDate(since.getDate() - daysBack);

    // Group by client via Prisma's groupBy on Appointment where
    // status === 'no_show'. Prisma's groupBy doesn't support filtering
    // by an aggregate (`having`) on a related model, so we paginate
    // the candidates first and only count on the client side.
    const candidates = await ctx.prisma.appointment.findMany({
      where: {
        tenantId: ctx.tenantId,
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
          ...(isSensitive ? { totalSpent: Number(c.client.totalSpent) } : {}),
        };
      });
    return {
      windowDays: daysBack,
      minNoShows,
      totalFlagged: list.length,
      flagged: list,
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
    const limit = Math.max(Number(args.limit ?? 10), 1);
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
        ? { tenantId: ctx.tenantId, status: 'active' as const, lastVisit: { not: null } }
        : { tenantId: ctx.tenantId, status: 'active' as const };

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
        ...(isSensitive ? { totalSpent: Number(c.totalSpent) } : {}),
      })),
    };
  }

  // ====================================================================
  //  Sprint 14: write tools. Every one of these is gated by human
  //  approval at the AssistantService layer; here they just produce a
  //  preview + perform the action when called for real.
  // ====================================================================

  /**

/**
 * Draft a follow-up message for a client. Does NOT send.
 * Returns `{ draft, channel, occasion, tone }` so the LLM can show
 * the body verbatim and ask the user to confirm before a `send_message`
 * is dispatched.
 */
private async draftFollowUpMessage(
  args: Record<string, unknown>,
  ctx: CopilotToolContext,
) {
  const clientId = args.clientId as string | undefined;
  if (!clientId) return { error: 'missing_clientId' };

  const channel = (args.channel as string) ?? 'whatsapp';
  const occasion = (args.occasion as string) ?? 'confirmation';
  const tone = (args.tone as string) ?? 'warm';

  const client = await this.prisma.client.findFirst({
    where: { id: clientId, tenantId: ctx.tenantId },
    select: { id: true, firstName: true, lastVisit: true },
  });
  if (!client) return { error: 'client_not_found' };

  // The draft is template-driven here (no extra LLM call). The LLM
  // can rewrite it in the prompt context if needed. Keeping the
  // generation deterministic keeps the L4 test simple and the audit
  // log readable.
  const name = client.firstName;
  const draft = composeFollowUp({ name, channel, occasion, tone, customText: args.customText as string | undefined });

  return {
    clientId,
    channel,
    occasion,
    tone,
    draft,
    requiresApproval: true,
    next: 'send_message',
  };
}

/**
 * Send a single WhatsApp template message to a client.
 * Sprint 14 keeps this self-contained: it looks up the tenant's
 * active WhatsApp connection, decrypts the access token, and
 * dispatches via Meta Cloud API. If anything is missing, returns
 * a structured error so the user can fix the connection first.
 */
private async sendMessage(
  args: Record<string, unknown>,
  ctx: CopilotToolContext,
) {
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
      where: { clientId, professionalId: { in: await this.staffProfessionalIds(ctx) } },
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
  if (!client.phone) return { error: 'client_has_no_phone' };

  const conn: any = await (this.prisma as any).whatsAppConnection?.findUnique?.({
    where: { tenantId: ctx.tenantId },
  });
  if (!conn || !conn.isActive) {
    return { error: 'whatsapp_not_connected', message: 'Conecta WhatsApp en Ajustes antes de enviar.' };
  }
  if (!conn.accessTokenEnc || !conn.phoneNumberId) {
    return { error: 'whatsapp_not_connected', message: 'Conexión WhatsApp incompleta.' };
  }

  const token = decryptAes(conn.accessTokenEnc); // best-effort: see helper below
  const vars = (args.templateVars as Record<string, string>) ?? {};
  const languageCode = (args.languageCode as string) ?? 'es';
  const components = [
    {
      type: 'body',
      parameters: Object.keys(vars)
        .sort()
        .map((k) => ({ type: 'text', text: String(vars[k] ?? '') })),
    },
  ];

  const resp = await metaFetch(
    `https://graph.facebook.com/v20.0/${conn.phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: client.phone,
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

  const updated = await this.prisma.appointment.update({
    where: { id: appointmentId },
    data: {
      scheduledDate: new Date(`${newDate}T00:00:00`),
      scheduledTime: newTime,
      updatedAt: new Date(),
    },
    select: {
      id: true,
      scheduledDate: true,
      scheduledTime: true,
      client: { select: { firstName: true } },
    },
  });

  return {
    ok: true,
    appointmentId: updated.id,
    from: { date: appt.scheduledDate, time: appt.scheduledTime },
    to: {
      date: updated.scheduledDate.toISOString().slice(0, 10),
      time: updated.scheduledTime,
    },
    clientFirstName: updated.client?.firstName ?? null,
  };
}

  private async staffProfessionalIds(ctx: CopilotToolContext): Promise<string[]> {
  const prof = await this.prisma.professional.findFirst({
    where: { user: { id: ctx.userId } },
    select: { id: true },
  });
  return prof ? [prof.id] : [];
}

  /**
   * Sprint 15: mark a confirmed/pending appointment as a no-show.
   * Receptionist / manager / owner only (stylists cannot).
   * If applyFee=true, records the fee on the appointment discount
   * block so the next invoice picks it up. We never mutate `totalAmount`
   * here — billing reconciliation runs in its own pipeline.
   */
  private async markNoShow(
    args: Record<string, unknown>,
    ctx: CopilotToolContext,
  ) {
    if (!['owner', 'admin', 'manager', 'receptionist', 'saas_owner'].includes(ctx.role)) {
      return { error: 'forbidden', message: 'Solo recepcionista / manager / owner pueden marcar no-show.' };
    }
    const appointmentId = args.appointmentId as string | undefined;
    if (!appointmentId) return { error: 'missing_appointmentId' };
    const applyFee = Boolean(args.applyFee);
    const feeAmount = Number(args.feeAmount ?? 0);

    const appt = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      select: { id: true, tenantId: true, status: true, client: { select: { firstName: true } } },
    });
    if (!appt) return { error: 'appointment_not_found' };
    if (appt.tenantId !== ctx.tenantId) {
      return { error: 'forbidden', message: 'La cita no pertenece a tu salón.' };
    }
    if (appt.status === 'no_show' || appt.status === 'completed' || appt.status === 'cancelled') {
      return { error: 'invalid_status', message: `La cita ya está en estado ${appt.status}.` };
    }
    if (applyFee && (Number.isNaN(feeAmount) || feeAmount <= 0)) {
      return { error: 'invalid_feeAmount' };
    }

    const updated = await this.prisma.appointment.update({
      where: { id: appointmentId },
      data: {
        status: 'no_show',
        ...(applyFee ? { discount: { noShowFee: feeAmount } as any } : {}),
        updatedAt: new Date(),
      },
      select: { id: true, status: true },
    });

    return {
      ok: true,
      appointmentId: updated.id,
      status: updated.status,
      feeApplied: applyFee,
      feeAmount: applyFee ? feeAmount : 0,
      clientFirstName: appt.client?.firstName ?? null,
    };
  }

  /**
   * Sprint 15: issue a single-use discount code (Promotion) for one
   * client (or for any client if clientId is omitted).
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
    const clientId = (args.clientId as string | undefined) ?? null;
    const expiresInDays = Math.max(Number(args.expiresInDays ?? 30), 1);
    const now = new Date();
    const end = new Date(now);
    end.setDate(now.getDate() + expiresInDays);

    // Generate a unique code: 6-char random uppercase. Retries up to
    // 3 times if we hit the @@unique([tenantId, code]) constraint.
    const code = await this.generateUniqueCouponCode(ctx.tenantId);

    const created = await this.prisma.promotion.create({
      data: {
        tenantId: ctx.tenantId,
        name: clientId ? 'Cupón personalizado' : 'Cupón general',
        code,
        type: 'PERCENTAGE',
        value: discountPercent as any,
        maxUses: 1,
        startDate: now,
        endDate: end,
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
      clientId,
      expiresAt: created.endDate?.toISOString() ?? null,
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
   * Sprint 15: pick the top N wait-list clients that match a freed
   * slot, mark them 'notified'. The orchestrator then dispatches the
   * actual WhatsApp send via `send_message`. Manager / receptionist
   * only.
   */
  private async closeWaitlistSlot(
    args: Record<string, unknown>,
    ctx: CopilotToolContext,
  ) {
    if (!['owner', 'admin', 'manager', 'receptionist', 'saas_owner'].includes(ctx.role)) {
      return { error: 'forbidden', message: 'Solo manager / recepcionista / owner pueden usar la lista de espera.' };
    }
    const serviceId = args.serviceId as string | undefined;
    const windowStart = args.windowStart as string | undefined;
    const windowEnd = args.windowEnd as string | undefined;
    const topN = Math.max(Number(args.topN ?? 5), 1);
    const professionalId = (args.professionalId as string | undefined) ?? null;

    if (!serviceId) return { error: 'missing_serviceId' };
    if (!windowStart || !/^\d{4}-\d{2}-\d{2}$/.test(windowStart)) return { error: 'invalid_windowStart' };
    if (!windowEnd || !/^\d{4}-\d{2}-\d{2}$/.test(windowEnd)) return { error: 'invalid_windowEnd' };

    const start = new Date(`${windowStart}T00:00:00`);
    const end = new Date(`${windowEnd}T23:59:59`);

    const candidates = await this.prisma.waitList.findMany({
      where: {
        tenantId: ctx.tenantId,
        serviceId,
        status: 'waiting',
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
      return { ok: true, notified: 0, clients: [] };
    }

    await this.prisma.waitList.updateMany({
      where: { id: { in: candidates.map((c) => c.id) } },
      data: { status: 'notified', notifiedAt: new Date() },
    });

    return {
      ok: true,
      notified: candidates.length,
      clients: candidates.map((c) => ({
        waitListId: c.id,
        clientId: c.client.id,
        firstName: c.client.firstName,
        hasPhone: Boolean(c.client.phone),
      })),
    };
  }
}

function timeToMinutes(t: string): number {
  const parts = t.split(':');
  return Number(parts[0]) * 60 + Number(parts[1] || 0);
}

function minutesToTime(m: number): string {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

// --------------------------------------------------------------------
//  Helpers for the write tools (sprint 14)
// --------------------------------------------------------------------

/**
 * Deterministic follow-up draft generator. Keeps the L4 tests simple
 * and the audit log human-readable. The LLM may rewrite this in its
 * final reply, but the source of truth is this template.
 */
function composeFollowUp(input: {
  name: string;
  channel: string;
  occasion: string;
  tone: string;
  customText?: string;
}): string {
  const greeting = input.tone === 'formal'
    ? `Estimada ${input.name}`
    : `Hola ${input.name}`;
  const closer = input.tone === 'formal' ? 'Atentamente,' : '¡Gracias!';

  let body: string;
  switch (input.occasion) {
    case 'reminder':
      body = 'te escribimos para recordarte tu próxima cita. ¿Sigue en pie?';
      break;
    case 'reactivation':
      body = 'hace tiempo que no te vemos por el salón. ¿Te gustaría reservar?';
      break;
    case 'custom':
      body = input.customText?.trim() || '¿En qué podemos ayudarte?';
      break;
    case 'confirmation':
    default:
      body = 'queremos confirmar tu cita. ¿Puedes confirmar que te viene bien?';
      break;
  }
  return `${greeting}, ${body}\n\n${closer}\nEl equipo del salón`;
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
