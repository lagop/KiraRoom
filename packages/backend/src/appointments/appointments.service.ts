import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Logger,
  Optional,
} from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import {
  ShiftWindow,
  bookingSlotStep,
  candidateStarts,
  clockOf as clockOfMinutes,
  workingWindowsFor,
  bookableWindows,
  fitsInShifts,
  minutesOf,
  salonWindowsFor,
  subtractWindows,
} from "./working-hours";
import { availableWindows, dayBlocks, salonClosedOn } from "../time-off/time-off-rules";
import { timeOffBetween } from "../time-off/time-off-query";
import { ProductEventsService, PRODUCT_EVENTS } from "../common/telemetry/product-events.service";
import {
  AppointmentStatus,
  PaymentStatus,
  AppointmentSource,
} from "@prisma/client";
import { NotificationsService } from "../notifications/notifications.service";
import { ClientCadenceService } from "../rebooking/client-cadence.service";
import { WaitListService } from "../wait-list/wait-list.service";
import { LoyaltyService } from "../loyalty/loyalty.service";
import { InvoiceService } from "../invoices/invoices.service";
import { EmailService } from "../notifications/services/email.service";
import { SmsService } from "../notifications/services/sms.service";
import { WhatsAppService } from "../notifications/services/whatsapp.service";
import {
  AppointmentNoticeKind,
  WhatsAppTemplateService,
} from "../whatsapp/whatsapp-template.service";
import { NotificationType } from "../notifications/dto";
import { TranslationsService } from "../translations/translations.service";
import { ConsentService } from "../consent/consent.service";
import { refreshClientStats } from "../clients/client-stats";
import { salonInstant } from "./salon-time";
import { assertCanBook, assertCanReschedule, salonDayAndTime } from "./reschedule-check";
import {
  MoveScope,
  VisitService,
  changedServices,
  clientDoubleBooked,
  currentVisitSchedule,
  planRetime,
  planVisitMove,
  visitSpan,
} from "./visit-move";
import {
  BusyBlock,
  VISIT_ROW_ORDER,
  VISIT_ROW_SELECT,
  appointmentBusyBlocks,
  cleanupMinutesOf,
  clashesWithBlock,
  plannedCleanup,
  VisitRow,
  clockOf,
  endClock,
  freesProfessional,
  isLiveRow,
  layoutVisit,
  normalizeAddons,
  visitSchedule,
  visitTotals,
} from "./visit-totals";
import { editChangesRows, planRowEdit } from "./visit-edit";
import { priceIsFrozen } from "./visit-sync";
import { appointmentLocationId } from "../multi-location/appointment-location";
import {
  clientEmailFilter,
  findClientIdByPhone,
  normalizeClientEmail,
  normalizeClientPhone,
  salonCountry,
} from "../clients/client-contact";
import { isReadOnlyStatus } from "../common/guards/read-only-tenant.guard";
import type { OnlineBookingDto, StaffBookingDto } from "./dto/book-appointment.dto";
import { UpdateAppointmentDto } from "./dto/update-appointment.dto";
import type { UpdateAppointmentPaymentDto } from "./dto/update-appointment-payment.dto";
import { appointmentTotalCents, assertVisitChargeable } from "../payments/appointment-payment";
import { moneyOfCatalogueCents, salonTaxBasis, type SalonTaxBasis } from "../payments/appointment-charge";
import { appointmentDeleteBlocker, deleteAppointmentRow } from "./appointment-delete";
import { isForeignKeyViolation } from "../common/prisma/history-deletes";
import {
  assertTransition,
  concurrentChange,
  isStaleWrite,
  needsConsent,
} from "./appointment-status";

interface AppointmentActivity {
  action: string;
  details: any;
  userId?: string;
}

export interface CreateAppointmentDto {
  /**
   * Ignored. The tenant is decided server-side: from the professional for an
   * online booking, from the token for a staff one. Callers sent placeholders
   * ('default', '1', a hardcoded salon UUID) and the old code trusted them.
   */
  tenantId?: string;
  clientId?: string;
  clientInfo?: {
    firstName: string;
    lastName: string;
    /** Email or phone, at least one; see findOrCreateClient. */
    email?: string;
    phone?: string;
  };
  serviceId: string;
  professionalId: string;
  scheduledDate: string | Date;
  scheduledTime: string;
  notes?: string;
  source?: string;
  widgetInstanceId?: string;
}

/**
 * req.user for the team. It carries no professional id: a professional's
 * own record is the one whose userId is theirs (see ownProfessionalId).
 */
export interface AuthenticatedUser {
  id: string;
  tenantId: string;
  role: string;
}

export { UpdateAppointmentDto };

export interface AppointmentFiltersDto {
  tenantId?: string;
  professionalId?: string;
  clientId?: string;
  clientEmail?: string;
  serviceId?: string;
  status?: string;
  startDate?: Date;
  endDate?: Date;
  searchQuery?: string;
}

/** What a status change may carry besides the status. */
export interface StatusChangeOptions {
  /** Cancellation reason. */
  reason?: string;
  /** Completion notes; they replace the appointment's when given. */
  notes?: string;
  /** Further columns written with the status, for internal callers (the copilot's no-show fee). */
  data?: Record<string, unknown>;
}

export interface PendingPaymentFiltersDto {
  searchQuery?: string;
  dateFrom?: string;
  dateTo?: string;
  status?: string;
}

/**
 * The candidate slots of a salon that recorded no hours of its own:
 * 09:00–20:00. It was hardcoded to 09:00–18:00 once, which made the
 * suggestion engine return nothing past 17:30.
 */
const DEFAULT_SLOT_GRID: ShiftWindow = { startMinutes: 9 * 60, endMinutes: 20 * 60 };

@Injectable()
export class AppointmentsService {
  private readonly logger = new Logger(AppointmentsService.name);

  constructor(
    private prisma: PrismaService,
    private readonly events: ProductEventsService,
    private notificationsService: NotificationsService,
    private emailService: EmailService,
    private smsService: SmsService,
    private whatsappService: WhatsAppService,
    private translationsService: TranslationsService,
    private consentService: ConsentService,
    @Optional() private clientCadenceService?: ClientCadenceService,
    @Optional() private invoiceService?: InvoiceService,
    @Optional() private readonly waitListService?: WaitListService,
    @Optional() private readonly loyaltyService?: LoyaltyService,
    @Optional() private readonly whatsappTemplates?: WhatsAppTemplateService,
  ) {}

  /**
   * Loyalty points follow the appointment: completed and paid earns,
   * cancelled or refunded gives them back. Both calls are idempotent and
   * do nothing until their condition holds, so this runs after any status
   * or payment change. A failure never fails the appointment change; the
   * hourly loyalty sweep catches up.
   */
  private async loyaltyAfterStatus(tenantId: string, appointmentId: string) {
    if (!this.loyaltyService) return;
    try {
      const apt = await this.prisma.appointment.findFirst({
        where: { id: appointmentId, tenantId },
        select: { status: true, paymentStatus: true },
      });
      if (!apt) return;
      if (apt.status === AppointmentStatus.cancelled || apt.paymentStatus === PaymentStatus.refunded) {
        await this.loyaltyService.reverseAppointment(
          tenantId,
          appointmentId,
          apt.status === AppointmentStatus.cancelled ? "Cita cancelada" : "Devolución del pago de la cita",
        );
      } else {
        await this.loyaltyService.settleAppointment(tenantId, appointmentId);
      }
    } catch (err) {
      this.logger.warn(`loyalty for appointment ${appointmentId} failed: ${(err as Error).message}`);
    }
  }

  /**
   * A WhatsApp notice from the salon's own WhatsApp Business number, with
   * the Meta-approved template for it. A confirmation, cancellation or change
   * usually reaches a client who has not written in the last 24 hours, and
   * WhatsApp refuses free text outside that window. Returns false when the
   * salon has no WhatsApp connected or the template is not approved yet, so
   * the caller falls back to the platform sender as before.
   */
  private async sendWhatsAppViaSalon(kind: AppointmentNoticeKind, appointment: any): Promise<boolean> {
    if (!this.whatsappTemplates || !appointment?.client?.phone) return false;
    try {
      const result = await this.whatsappTemplates.sendAppointmentNotice(appointment.tenantId, kind, {
        phone: appointment.client.phone,
        clientName: appointment.client.firstName,
        salonName: appointment.tenant?.name || "tu salón",
        serviceName: appointment.service?.name || "tu servicio",
        date: new Date(appointment.scheduledDate),
        time: appointment.scheduledTime,
        country: appointment.tenant?.country ?? undefined,
      });
      if (!result.sent && result.reason !== "not_connected") {
        this.logger.log(`WhatsApp ${kind} template not used for appointment ${appointment.id}: ${result.reason}`);
      }
      return result.sent;
    } catch (error) {
      this.logger.warn(`WhatsApp ${kind} template for appointment ${appointment.id} failed: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * Enrich appointment data with computed totalAmount (in cents) and amountDue.
   * The database totalAmount field is not set on creation, so we compute it from service price.
   */
  private enrichAppointment(apt: any, basis?: SalonTaxBasis | null): any {
    const servicePrice = Number(apt.service?.price || 0);
    const totalAmount = apt.totalAmount && Number(apt.totalAmount) > 0
      ? Number(apt.totalAmount)
      : Math.round(servicePrice * 100); // Convert dollars to cents
    const amountPaid = Number(apt.amountPaid || 0);
    // amountPaid is money (tax included); totalAmount is the catalogue
    // figure. For a salon whose prices are the base, what is due is the
    // money total (base + tax: appointment-charge.ts), what the till
    // charges. A visit of several services may differ by a cent from its
    // invoice here; the till prices it exactly (POST /pos/quote).
    const chargeTotal = basis ? moneyOfCatalogueCents(totalAmount, basis) : totalAmount;
    return {
      ...apt,
      // Rows saved before the fix hold {"set": [...]}: always a plain list.
      ...(apt.addons !== undefined ? { addons: normalizeAddons(apt.addons) } : {}),
      totalAmount,
      chargeTotal,
      amountDue: Math.max(0, chargeTotal - amountPaid),
    };
  }

  /** The salon's tax basis for amountDue (null when it cannot be read: catalogue = money). */
  private async chargeBasisOf(tenantId: string): Promise<SalonTaxBasis | null> {
    const tenant = await (this.prisma as any).tenant?.findUnique?.({
      where: { id: tenantId },
      select: { fiscalSettings: true },
    });
    return tenant && tenant.fiscalSettings !== undefined ? salonTaxBasis(tenant.fiscalSettings) : null;
  }

  /**
   * A booking made from outside the salon: the public site, the widget, the
   * client portal. The route is @Public(), so nothing the caller sends about
   * the tenant can be trusted, and nothing stops a direct POST from asking
   * for 03:00, for yesterday, or for a slot already taken.
   *
   * - The salon is the chosen professional's -- or, for the widget's "any
   *   professional", the widget's. A widget named alongside a professional
   *   must be that salon's (assertBookableOnline).
   * - Only a service the salon offers online (active, isOnlineBookable), and
   *   only an active professional.
   * - The start must be inside the service's booking window
   *   (minAdvanceBooking hours to maxAdvanceBooking days from now).
   * - The slot must be one getAvailableSlots offers: on the professional's
   *   shift, inside opening hours, and not overlapping another booking.
   * - Check and insert run under a per-salon, per-day advisory lock, so two
   *   concurrent requests for the same slot cannot both pass the check.
   *   Notifications are sent after the lock is released.
   */
  async createOnline(dto: OnlineBookingDto, meta: { ip?: string } = {}) {
    const professionalId = dto.professionalId || undefined;
    let tenantId: string;
    let widgetProfessionals: string[] = [];

    if (professionalId) {
      const professional = await this.prisma.professional.findFirst({
        where: { id: professionalId, isActive: true },
        select: { tenantId: true },
      });
      if (!professional) throw new NotFoundException("Profesional no encontrado");
      tenantId = professional.tenantId;
    } else {
      // "Any professional" is the widget's option; the widget says which salon.
      if (!dto.widgetInstanceId) {
        throw new BadRequestException("Elige un profesional");
      }
      const widget = await this.prisma.widgetInstance.findUnique({
        where: { id: dto.widgetInstanceId },
        select: { tenantId: true, professionals: true },
      });
      if (!widget) throw new NotFoundException("Widget no encontrado");
      tenantId = widget.tenantId;
      widgetProfessionals = widget.professionals ?? [];
    }

    return this.bookOnline(tenantId, dto, widgetProfessionals, meta);
  }

  /**
   * The online booking itself, for a salon the caller has already
   * established: createOnline (from the professional or the widget) and the
   * virtual receptionist (the salon it answers for). Window, availability,
   * lock and insert; notifications after the lock.
   *
   * `allowedProfessionals` limits "any professional" to a widget's list.
   * `meta.ip` is the booker's, for the record of what she ticked.
   */
  async bookOnline(
    tenantId: string,
    dto: OnlineBookingDto,
    allowedProfessionals: string[] = [],
    meta: { ip?: string } = {},
  ) {
    const professionalId = dto.professionalId || undefined;
    const widgetProfessionals = allowedProfessionals;
    await this.assertBookableOnline(tenantId, dto);
    const window = await this.onlineBookingWindow(tenantId, dto.serviceId);
    if (!window) throw new NotFoundException("Servicio no encontrado");

    const scheduledDay = String(dto.scheduledDate).slice(0, 10);
    const fit = this.fitsOnlineWindow(scheduledDay, dto.scheduledTime, window);
    if (fit === "too-soon") {
      throw new ConflictException("Ese horario ya no se puede reservar online");
    }
    if (fit === "too-far") {
      throw new BadRequestException(
        `Solo se puede reservar con ${window.maxHours / 24} días de antelación como máximo`,
      );
    }

    const date = new Date(scheduledDay);
    const appointment = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`booking:${tenantId}:${scheduledDay}`}))`;

        let assigned: string;
        if (professionalId) {
          if (!(await this.isSlotFree(tenantId, date, professionalId, dto.serviceId, dto.scheduledTime))) {
            throw new ConflictException("Ese horario ya no está disponible");
          }
          assigned = professionalId;
        } else {
          assigned = await this.findFreeProfessional(
            tenantId, date, dto.serviceId, dto.scheduledTime, widgetProfessionals,
          );
        }

        // Inserted through the normal client: it commits at once, before this
        // transaction ends and releases the lock, so the next request's check
        // sees it. `online`: an existing client's contact details are left
        // as they are (findOrCreateClient).
        return this.insertAppointment({ ...dto, professionalId: assigned }, tenantId, { online: true });
      },
      { timeout: 15_000 },
    );

    // What she ticked, once the booking found or created her; before the
    // confirmation goes out, so a WhatsApp request already applies to it.
    if ((dto.refusesMarketingEmail || dto.wantsWhatsAppNotices) && appointment.clientId) {
      await this.consentService
        ?.recordBookingChoices({
          tenantId,
          clientId: appointment.clientId,
          appointmentId: appointment.id,
          source: dto.source === "widget" ? "widget" : "booking",
          ip: meta.ip,
          typedPhone: dto.clientInfo?.phone,
          refusesMarketingEmail: dto.refusesMarketingEmail,
          wantsWhatsAppNotices: dto.wantsWhatsAppNotices,
        })
        .catch((err) => this.logger.warn(`Booking choices not recorded: ${(err as Error).message}`));
    }

    const notified = await this.afterAppointmentCreated(appointment, dto.source);
    // Not columns: tell the chat receptionist whether it may say the
    // confirmation email or SMS was sent.
    return Object.assign(appointment, {
      confirmationEmailSent: notified?.emailSent === true,
      confirmationSmsSent: notified?.smsSent === true,
    });
  }

  /**
   * What an online booking may not name, whoever makes it (the site, the
   * widget, the virtual receptionist): a service the salon does not offer
   * online -- inactive, or marked not bookable online -- an inactive
   * professional, or another salon's widget. The panel's bookings
   * (createByStaff) do not come through here: the team may book any of
   * the salon's services by hand.
   */
  private async assertBookableOnline(tenantId: string, dto: OnlineBookingDto): Promise<void> {
    const professionalId = dto.professionalId || undefined;
    const [service, professional, widget] = await Promise.all([
      this.prisma.service.findFirst({
        where: { id: dto.serviceId, tenantId },
        select: { isActive: true, isOnlineBookable: true },
      }),
      professionalId
        ? this.prisma.professional.findFirst({
            where: { id: professionalId, tenantId },
            select: { isActive: true },
          })
        : Promise.resolve(undefined),
      dto.widgetInstanceId
        ? this.prisma.widgetInstance.findFirst({
            where: { id: dto.widgetInstanceId, tenantId },
            select: { id: true },
          })
        : Promise.resolve(undefined),
    ]);
    if (!service || !service.isActive) throw new NotFoundException("Servicio no encontrado");
    if (!service.isOnlineBookable) {
      throw new ForbiddenException({
        code: "SERVICE_NOT_BOOKABLE_ONLINE",
        message: "Este servicio no se puede reservar online. Llama al salón para pedir cita.",
      });
    }
    if (professional !== undefined && !professional?.isActive) {
      throw new NotFoundException("Profesional no encontrado");
    }
    // Attribution only, but never to another salon's widget.
    if (widget === null) throw new NotFoundException("Widget no encontrado");
    // The booking page only offers the professionals who perform the
    // service; a direct POST could name anyone.
    if (professionalId && !(await this.offersService(tenantId, professionalId, dto.serviceId))) {
      throw new BadRequestException("Ese profesional no realiza este servicio. Elige otro profesional.");
    }
  }

  /**
   * Whether a professional performs a service, by the rule the public
   * booking page (salon-booking-page.tsx) and findFreeProfessional use: the
   * active professionals linked to the service (ProfessionalService) -- or,
   * when none is linked, as in salons that never filled that in, every
   * active professional.
   */
  async offersService(tenantId: string, professionalId: string, serviceId: string): Promise<boolean> {
    const active: Array<{ id: string; services?: Array<{ serviceId: string }> }> =
      await this.prisma.professional.findMany({
        where: { tenantId, isActive: true },
        select: { id: true, services: { select: { serviceId: true } } },
      });
    const offering = active.filter((p) => (p.services ?? []).some((s) => s.serviceId === serviceId));
    return offering.length === 0 || offering.some((p) => p.id === professionalId);
  }

  /**
   * When a client may book a service online: from minAdvanceBooking hours to
   * maxAdvanceBooking days from now, in the salon's timezone. Without a
   * service, only "not in the past". Null when the service is not an active
   * service of this salon.
   */
  async onlineBookingWindow(
    tenantId: string,
    serviceId?: string,
  ): Promise<{ timeZone: string; minHours: number; maxHours: number } | null> {
    const [tenant, service] = await Promise.all([
      this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } }),
      serviceId
        ? this.prisma.service.findFirst({
            where: { id: serviceId, tenantId, isActive: true },
            select: { minAdvanceBooking: true, maxAdvanceBooking: true },
          })
        : Promise.resolve(undefined),
    ]);
    if (service === null) return null;
    return {
      timeZone: tenant?.timezone || "Europe/Madrid",
      minHours: service?.minAdvanceBooking ?? 0,
      maxHours: service ? (service.maxAdvanceBooking ?? 30) * 24 : Infinity,
    };
  }

  fitsOnlineWindow(
    day: string,
    time: string,
    window: { timeZone: string; minHours: number; maxHours: number },
    now: number = Date.now(),
  ): "ok" | "too-soon" | "too-far" {
    const hoursAhead = (salonInstant(day, time, window.timeZone).getTime() - now) / 3_600_000;
    if (hoursAhead < window.minHours) return "too-soon";
    if (hoursAhead > window.maxHours) return "too-far";
    return "ok";
  }

  private async isSlotFree(
    tenantId: string,
    date: Date,
    professionalId: string,
    serviceId: string,
    time: string,
  ): Promise<boolean> {
    const slots = await this.getAvailableSlots(tenantId, date, professionalId, serviceId);
    return !!slots.find((s: { time: string; isAvailable: boolean }) => s.time === time)?.isAvailable;
  }

  /**
   * The first professional, by name, who offers the service and is free for
   * the slot. Limited to the widget's professionals when it lists any. When
   * no professional is linked to the service at all -- salons that never
   * filled that in -- every active professional is a candidate.
   */
  async findFreeProfessional(
    tenantId: string,
    date: Date,
    serviceId: string,
    time: string,
    allowed: string[],
  ): Promise<string> {
    const active = await this.prisma.professional.findMany({
      where: { tenantId, isActive: true, ...(allowed.length ? { id: { in: allowed } } : {}) },
      select: { id: true, services: { select: { serviceId: true } } },
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    });
    const offering = active.filter((p) => p.services.some((s) => s.serviceId === serviceId));
    const candidates = offering.length > 0 ? offering : active;
    for (const candidate of candidates) {
      if (await this.isSlotFree(tenantId, date, candidate.id, serviceId, time)) return candidate.id;
    }
    throw new ConflictException("Ese horario ya no está disponible");
  }

  /**
   * Create an appointment in `tenantId`, which the caller has already
   * established -- never taken from the DTO.
   */
  async create(createAppointmentDto: CreateAppointmentDto, tenantId: string) {
    const appointment = await this.insertAppointment(createAppointmentDto, tenantId);
    await this.afterAppointmentCreated(appointment, createAppointmentDto.source);
    return appointment;
  }

  /**
   * The salon's client with this email or, failing that, this phone; else a
   * new one. Always in THIS salon: searching every salon matched a client of
   * salon A booking on salon B's site to their salon-A record.
   *
   * Online bookings require a phone and make the email optional, so a
   * returning client may come with either. A detail the record lacks is
   * filled in on a booking by the team (`fillMissing`); one it has is never
   * overwritten by what a booking form says.
   *
   * A public booking (the site, the widget, the receptionist) changes
   * nothing on an existing client: whoever books is only known by the one
   * detail that matched. Filling in the other one from the form would send
   * that client's notices to whoever typed it. The booking is still made
   * for the matched client; the appointment has no contact fields of its
   * own to keep the differing detail in.
   */
  private async findOrCreateClient(
    tenantId: string,
    info: { firstName: string; lastName: string; email?: string; phone?: string },
    db: any = this.prisma,
    { fillMissing }: { fillMissing: boolean } = { fillMissing: true },
  ): Promise<string> {
    // Emails are stored in lower case and matched whatever their case (see
    // clients/client-contact.ts): "Ana@Mail.com" is the client "ana@mail.com".
    const email = normalizeClientEmail(info.email) ?? undefined;
    const phone = info.phone?.trim() || undefined;
    if (!email && !phone) {
      // An undefined filter is dropped by Prisma: a lookup without either
      // would match the salon's first client.
      throw new BadRequestException("Client email or phone is required");
    }

    let existing = email
      ? await db.client.findFirst({
          where: { email: clientEmailFilter(email), tenantId },
          orderBy: { createdAt: "asc" },
        })
      : null;
    if (!existing && phone) {
      // Stored numbers are in whatever format they were typed ("600 111
      // 222", "+34600111222"): compared on their last nine digits.
      const id = await findClientIdByPhone(db, tenantId, phone);
      existing = id ? await db.client.findFirst({ where: { id, tenantId } }) : null;
    }

    if (existing) {
      if (!fillMissing) return existing.id;
      const fill: Record<string, string> = {};
      if (email && !existing.email) fill.email = email;
      if (phone && !existing.phone) fill.phone = await this.salonPhone(tenantId, phone, db);
      if (Object.keys(fill).length > 0) {
        await db.client.update({ where: { id: existing.id, tenantId }, data: fill });
      }
      return existing.id;
    }

    const created = await db.client.create({
      data: {
        tenantId,
        firstName: info.firstName,
        lastName: info.lastName,
        email: email ?? null,
        phone: phone ? await this.salonPhone(tenantId, phone, db) : null,
        status: "active",
      },
    });
    return created.id;
  }

  /** A client's phone in international form, using the salon's country. */
  private async salonPhone(tenantId: string, phone: string, db: any = this.prisma): Promise<string> {
    return normalizeClientPhone(phone, await salonCountry(db, tenantId)) ?? phone;
  }

  /**
   * Validate and insert. No side effects beyond creating the client.
   *
   * `visit`: a panel booking passes its transaction (`db`), so the client,
   * the appointment and its service rows are written together or not at
   * all; the visit's length when it has several services; and those rows,
   * already timed. `online`: a public booking, which leaves an existing
   * client's contact details as they are (findOrCreateClient).
   */
  private async insertAppointment(
    createAppointmentDto: CreateAppointmentDto & { commissionRate?: number },
    tenantId: string,
    visit: {
      db?: any;
      duration?: number;
      services?: Array<{
        serviceId: string;
        professionalId: string;
        isParallel: boolean;
        scheduledStart: Date;
        scheduledEnd: Date;
      }>;
      online?: boolean;
      /** A deposit the salon asked for (owner/admin only), in cents. */
      deposit?: { amountCents: number };
    } = {},
  ) {
    const db = visit.db ?? this.prisma;
    if (!createAppointmentDto.professionalId) {
      throw new BadRequestException("Professional ID is required");
    }

    // A salon without an active plan (trial ended, cancelled, suspended) is
    // read-only: no new appointments from its page, its widget or the
    // receptionist either. ReadOnlyTenantGuard covers the team's own routes.
    const tenant = await db.tenant.findUnique({
      where: { id: tenantId },
      select: { subscriptionStatus: true, autoConfirmOnlineBookings: true },
    });
    if (isReadOnlyStatus(tenant?.subscriptionStatus)) {
      throw new ForbiddenException({
        code: "SALON_NOT_ACCEPTING_BOOKINGS",
        message: "Este salón no acepta reservas en este momento.",
      });
    }

    // Professional and service first: a booking that fails on them must not
    // leave a new client record behind.
    const professional = await db.professional.findFirst({
      where: { id: createAppointmentDto.professionalId, tenantId: tenantId },
    });
    if (!professional) {
      throw new NotFoundException("Profesional no encontrado");
    }

    const service = await db.service.findFirst({
      where: { id: createAppointmentDto.serviceId, tenantId: tenantId },
    });
    if (!service) {
      throw new NotFoundException("Servicio no encontrado");
    }

    let clientId = createAppointmentDto.clientId;

    // Find or create client if clientInfo provided
    if (!clientId && createAppointmentDto.clientInfo) {
      clientId = await this.findOrCreateClient(tenantId, createAppointmentDto.clientInfo, db, {
        fillMissing: !visit.online,
      });
    }

    if (!clientId) {
      throw new BadRequestException("Client ID is required");
    }

    // The client must belong to the same salon as the appointment.
    const client = await db.client.findFirst({
      where: { id: clientId, tenantId },
    });
    if (!client) {
      throw new NotFoundException("Cliente no encontrado");
    }
    // A client the salon blocked cannot book from its page, its widget or
    // the receptionist; the team can still book her from the panel. The
    // message does not say why: the reason is the salon's.
    if (visit.online && client.status === "blocked") {
      throw new ForbiddenException({
        code: "ONLINE_BOOKING_NOT_AVAILABLE",
        message: "No es posible reservar online; contacta con el salón.",
      });
    }

    // A visit of several services lasts from its first to its last service.
    const duration = visit.duration ?? service.duration;
    const endTime = this.calculateEndTime(createAppointmentDto.scheduledTime, duration);

    const tenantRow = await db.tenant.findUnique({
      where: { id: tenantId },
      select: { timezone: true },
    });
    // Which of the salon's locations: the consolidated report reads it.
    const locationId = await appointmentLocationId(db, tenantId, professional.id);

    // Convert scheduledDate to Date if it's a string
    const scheduledDate =
      typeof createAppointmentDto.scheduledDate === "string"
        ? new Date(createAppointmentDto.scheduledDate)
        : createAppointmentDto.scheduledDate;

    // A visit of several services costs all of them (visit-totals.ts); it
    // was charged its first service only.
    let priceCents = Math.round(Number(service.price) * 100);
    if (visit.services?.length) {
      const priced: Array<{ id: string; duration: number; price: unknown }> = await db.service.findMany({
        where: { tenantId, id: { in: [...new Set(visit.services.map((r) => r.serviceId))] } },
        select: { id: true, duration: true, price: true },
      });
      priceCents = visitTotals({
        start: visit.services[0].scheduledStart,
        professionalId: professional.id,
        mainService: service,
        rows: visit.services.map((r, i) => ({
          id: String(i),
          serviceId: r.serviceId,
          professionalId: r.professionalId,
          scheduledStart: r.scheduledStart,
          scheduledEnd: r.scheduledEnd,
          isParallel: r.isParallel,
          service: priced.find((p) => p.id === r.serviceId) ?? null,
        })),
      }).totalCents;
    }

    // Create appointment
    const dto = createAppointmentDto as any;
    // A salon that confirms online bookings automatically (its general
    // settings) gets them confirmed, unless the service still needs consent
    // forms the client hasn't signed: confirming is where that is checked
    // (needsConsent), so such a visit starts pending like any other. Nor a
    // service the salon marked "requires approval": the team confirms those.
    const autoConfirm =
      visit.online &&
      !!tenant?.autoConfirmOnlineBookings &&
      !service.requiresApproval &&
      (await this.consentAllowsConfirming(tenantId, clientId, dto.serviceId));
    const appointment = await db.appointment.create({
      data: {
        tenantId: tenantId,
        clientId: clientId,
        serviceId: dto.serviceId,
        professionalId: dto.professionalId,
        scheduledDate: scheduledDate,
        scheduledTime: dto.scheduledTime,
        // The real instant. The reminder jobs select on it, and it was never
        // written: no appointment ever got a 24-hour or 1-hour reminder.
        startTime: salonInstant(
          scheduledDate,
          dto.scheduledTime,
          tenantRow?.timezone || "Europe/Madrid",
        ),
        duration,
        endTime: endTime,
        status: autoConfirm ? AppointmentStatus.confirmed : AppointmentStatus.pending,
        price: priceCents / 100,
        totalAmount: priceCents, // Store in cents
        currency: service.currency,
        paymentStatus: PaymentStatus.pending,
        notes: dto.notes || null,
        source: (dto.source as AppointmentSource) || AppointmentSource.online,
        widgetInstanceId: dto.widgetInstanceId || null,
        locationId,
        // Commission rate can be set by admin/owner
        ...(dto.commissionRate !== undefined && {
          commissionRate: dto.commissionRate,
        }),
        // Never from the booking itself: an online booking sends the same
        // fields, and the deposit is the salon's term.
        ...(visit.deposit && {
          depositRequired: true,
          depositAmount: visit.deposit.amountCents,
        }),
      },
      include: {
        client: true,
        professional: true,
        service: true,
        tenant: true,
      },
    });

    // In the order given: which service comes first is the visit's flow.
    if (visit.services?.length) {
      await db.appointmentService.createMany({
        data: visit.services.map((row, order) => ({
          appointmentId: appointment.id,
          serviceId: row.serviceId,
          professionalId: row.professionalId,
          isParallel: row.isParallel,
          order,
          scheduledStart: row.scheduledStart,
          scheduledEnd: row.scheduledEnd,
        })),
      });
    }
    return appointment;
  }

  /** Notifications, rebooking cleanup and telemetry for a new appointment. */
  private async afterAppointmentCreated(
    appointment: any,
    source?: string,
  ): Promise<{ emailSent: boolean; smsSent: boolean }> {
    // Send notifications for appointment creation
    const notified = await this.sendAppointmentCreatedNotifications(appointment);

    // P1.4 — Cancel any pending rebooking reminders for this client/service
    // now that they have a fresh booking.
    if (
      this.clientCadenceService &&
      ["confirmed", "pending"].includes(appointment.status)
    ) {
      this.clientCadenceService
        .cancelPending(
          appointment.clientId,
          appointment.serviceId,
          appointment.id,
        )
        .catch((err) => {
          this.logger.warn(
            `cancelPending failed for client ${appointment.clientId}: ${(err as Error).message}`,
          );
        });
    }

    // She booked the service she was waiting for: her wait-list entry for
    // it closes ("Ha reservado") and she is not offered slots any more.
    if (this.waitListService && appointment.clientId && appointment.serviceId) {
      this.waitListService
        .onAppointmentBooked({
          tenantId: appointment.tenantId,
          clientId: appointment.clientId,
          serviceId: appointment.serviceId,
          professionalId: appointment.professionalId ?? null,
        })
        .catch((err) => {
          this.logger.warn(
            `wait-list close failed for appointment ${appointment.id}: ${(err as Error).message}`,
          );
        });
    }

    // Third funnel milestone, and the one that matters: the salon has a
    // real booking in the system. Time from tenant_signed_up to this is
    // the activation metric.
    await this.events.recordOnce(
      PRODUCT_EVENTS.FIRST_BOOKING_RECEIVED,
      appointment.tenantId,
      { source: source ?? 'dashboard' },
    );
    return notified;
  }

  /**
   * An appointment booked from the panel by the salon's team.
   *
   * - The salon is the caller's, from the token.
   * - A professional (role staff) books on their own agenda: their
   *   professional is the one whose userId is theirs (the token carries no
   *   professional id, and comparing with one that was never set refused
   *   every booking). A colleague's agenda only when the salon allows
   *   cross-booking (Configuración → Asignación profesional).
   * - Owners and managers book for any professional of the salon, and may
   *   set the commission.
   * - A visit of several services is one request: the appointment and its
   *   service rows are written in one transaction, so a failure leaves
   *   nothing behind and a retry cannot book it twice.
   * - Under the same per-salon, per-day advisory lock as online bookings,
   *   every service must fit its professional's agenda (assertCanBook): an
   *   overlap is always refused; the past and the hours only an owner or
   *   manager may override, after confirming (allowOutsideHours).
   */
  async createByStaff(dto: StaffBookingDto, user: AuthenticatedUser) {
    const tenantId = user.tenantId;
    const manager = user.role === "owner" || user.role === "admin";
    let professionalId = dto.professionalId || undefined;
    const requested = (dto.services ?? []).map((s) => ({
      serviceId: s.serviceId,
      professionalId: s.professionalId || undefined,
      isParallel: !!s.isParallel,
    }));

    if (user.role === "staff") {
      const own = await this.ownProfessionalId(user);
      if (!own) {
        throw new ForbiddenException("Tu usuario no está vinculado a ningún profesional del salón.");
      }
      professionalId = professionalId ?? own;
      const forColleague = [professionalId, ...requested.map((r) => r.professionalId)].some(
        (id) => id !== undefined && id !== own,
      );
      if (forColleague) {
        const tenant = await this.prisma.tenant.findUnique({
          where: { id: tenantId },
          select: { allowProfessionalCrossBooking: true },
        });
        if (!tenant?.allowProfessionalCrossBooking) {
          throw new ForbiddenException("Los profesionales solo pueden crear citas para sí mismos");
        }
      }
    }
    if (!professionalId) throw new BadRequestException("Elige un profesional");
    const rows = requested.map((r) => ({ ...r, professionalId: r.professionalId ?? professionalId! }));

    // Every id the visit points at is this salon's; durations for the timing.
    await this.assertSalonRecords(tenantId, {
      serviceIds: [dto.serviceId, ...rows.map((r) => r.serviceId)],
      professionalIds: [professionalId, ...rows.map((r) => r.professionalId)],
      clientIds: [dto.clientId],
    });
    const serviceIds = [...new Set([dto.serviceId, ...rows.map((r) => r.serviceId)])];
    const [tenantRow, catalog] = await Promise.all([
      this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } }),
      this.prisma.service.findMany({
        where: { tenantId, id: { in: serviceIds } },
        select: { id: true, duration: true, isActive: true, name: true, bufferTime: true },
      }),
    ]);
    // A deactivated service is off the menu: the pickers no longer offer it,
    // and a stale form or a direct call must not book it either. Its past
    // appointments keep it.
    const inactive = catalog.find((s: { isActive?: boolean }) => s.isActive === false);
    if (inactive) {
      throw new BadRequestException(
        `El servicio "${inactive.name}" está desactivado. Actívalo en Servicios para poder reservarlo.`,
      );
    }
    const timeZone = tenantRow?.timezone || "Europe/Madrid";
    const minutes = (serviceId: string) => catalog.find((s) => s.id === serviceId)?.duration ?? 0;

    const day = String(dto.scheduledDate).slice(0, 10);
    const start = salonInstant(day, dto.scheduledTime, timeZone);
    // Where each service falls, as the calendar draws a visit: serial ones
    // one after another from the start, parallel ones with the start.
    const visit: VisitService[] = rows.length
      ? currentVisitSchedule({
          appointmentStart: start,
          appointmentProfessionalId: professionalId,
          services: rows.map((r, i) => ({
            id: String(i),
            professionalId: r.professionalId,
            scheduledStart: null,
            scheduledEnd: null,
            isParallel: r.isParallel,
            durationMinutes: minutes(r.serviceId),
          })),
        })
      : [{
          id: "0",
          professionalId,
          start,
          end: new Date(start.getTime() + minutes(dto.serviceId) * 60_000),
          isParallel: false,
        }];
    const span = visitSpan(visit);
    // The cleanup after the visit, on the service it ends with (visit-totals.ts).
    const inCatalog = (id: string) => catalog.find((s) => s.id === id) ?? null;
    const cleanup = rows.length
      ? plannedCleanup(visit, rows.map((r) => ({ service: inCatalog(r.serviceId) })))
      : { index: 0, minutes: cleanupMinutesOf(inCatalog(dto.serviceId)) };

    const { services: _rows, allowOutsideHours, commissionRate, depositRequired, depositAmount, ...booking } =
      dto;
    const appointment = await this.prisma.$transaction(
      async (tx: any) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`booking:${tenantId}:${day}`}))`;
        for (const [i, s] of visit.entries()) {
          const at = salonDayAndTime(s.start, timeZone);
          await assertCanBook(
            tx,
            {
              tenantId,
              professionalId: s.professionalId,
              day: at.day,
              time: at.time,
              durationMinutes: Math.round((s.end.getTime() - s.start.getTime()) / 60_000),
              cleanupMinutes: i === cleanup.index ? cleanup.minutes : 0,
            },
            // A professional's bookings stay inside the hours.
            { allowOutsideHours: manager && allowOutsideHours === true },
          );
        }
        return this.insertAppointment(
          {
            ...booking,
            professionalId: professionalId!,
            source: AppointmentSource.staff,
            // The commission is the salon's term: a professional booking with
            // `commissionRate: 100` set their own pay. Unset, the
            // professional's or the service's default applies.
            commissionRate: manager ? commissionRate : undefined,
          },
          tenantId,
          {
            db: tx,
            duration: rows.length
              ? Math.round((span.end.getTime() - span.start.getTime()) / 60_000)
              : undefined,
            services: rows.length
              ? rows.map((r, i) => ({
                  ...r,
                  scheduledStart: visit[i].start,
                  scheduledEnd: visit[i].end,
                }))
              : undefined,
            // The panel's deposit (cents) was accepted and never written.
            deposit:
              manager && depositRequired
                ? { amountCents: Math.max(0, Math.round(Number(depositAmount ?? 0))) }
                : undefined,
          },
        );
      },
      { timeout: 15_000 },
    );

    // After the commit: notifications never run for a booking that rolled back.
    await this.afterAppointmentCreated(appointment);
    return appointment;
  }

  /** The caller's own professional record, or null when the account has none. */
  private async ownProfessionalId(user: { id: string; tenantId: string }): Promise<string | null> {
    const own = await this.prisma.professional.findFirst({
      where: { userId: user.id, tenantId: user.tenantId },
      select: { id: true },
    });
    return own?.id ?? null;
  }

  async findAll(user: any, filters?: AppointmentFiltersDto) {
    // This salon's only: the tenant filter adds it too, and a tenantId in
    // the filters is not the caller's to choose.
    const where: any = { tenantId: user.tenantId };

    // Aplicar filtro automático para usuarios STAFF - solo ven sus propias citas
    if (user.role === "staff") {
      const professional = await this.prisma.professional.findFirst({
        where: { userId: user.id, tenantId: user.tenantId },
        select: { id: true },
      });

      // A staff account not linked to a professional sees no appointment.
      // Without this it saw every appointment of the salon: the filter was
      // only added when the record was found.
      if (!professional) return [];
      where.professionalId = professional.id;
      // Ignorar cualquier professionalId enviado por el cliente para evitar bypass
      filters.professionalId = professional.id;
    }

    if (filters) {
      // Para STAFF, el professionalId ya fue forzado arriba, ignorar el del cliente
      if (filters.professionalId && user.role !== "staff")
        where.professionalId = filters.professionalId;
      if (filters.clientId) where.clientId = filters.clientId;
      if (filters.serviceId) where.serviceId = filters.serviceId;
      if (filters.status) where.status = filters.status;
      if (filters.startDate || filters.endDate) {
        where.scheduledDate = {};
        if (filters.startDate)
          where.scheduledDate.gte = new Date(filters.startDate);
        if (filters.endDate)
          where.scheduledDate.lte = new Date(filters.endDate);
      }

      // Handle clientEmail filter by finding the client first
      if (filters.clientEmail && !filters.clientId) {
        const client = await this.prisma.client.findFirst({
          where: { email: clientEmailFilter(filters.clientEmail), tenantId: user.tenantId },
        });
        if (client) {
          where.clientId = client.id;
        } else {
          // No client found with this email, return empty result
          return [];
        }
      }

      // Handle searchQuery by finding clients whose names match
      if (filters.searchQuery && filters.searchQuery.trim()) {
        const searchTerm = filters.searchQuery.trim();
        const clients = await this.prisma.client.findMany({
          where: {
            tenantId: user.tenantId,
            OR: [
              { firstName: { contains: searchTerm, mode: 'insensitive' } },
              { lastName: { contains: searchTerm, mode: 'insensitive' } },
            ],
          },
          select: { id: true },
        });

        const clientIds = clients.map(client => client.id);
        if (clientIds.length === 0) {
          // No clients found with this search term, return empty result
          return [];
        }

        // Add client ID filter
        where.clientId = { in: clientIds };
      }
    }

    // Bounded. The list asked for every appointment the salon ever had, with
    // its client, services and salon, on every load. Without a date range or
    // a client, it covers a year back and a year ahead (the list page pages
    // months within that); a client's history is whole. Never more than
    // FIND_ALL_MAX rows: the latest-dated ones, returned oldest first.
    if (!where.scheduledDate && !where.clientId) {
      const today = new Date();
      const yearMs = 366 * 24 * 60 * 60 * 1000;
      where.scheduledDate = {
        gte: new Date(today.getTime() - yearMs),
        lte: new Date(today.getTime() + yearMs),
      };
    }

    const newestFirst = await (this.prisma.appointment.findMany as any)({
      where,
      take: AppointmentsService.FIND_ALL_MAX,
      include: {
        client: true,
        professional: true,
        service: true,
        tenant: true,
        services: {
          include: {
            service: true,
            professional: true,
          },
          orderBy: {
            order: "asc",
          },
        },
      },
      orderBy: [{ scheduledDate: "desc" }, { scheduledTime: "desc" }],
    });
    const appointments = (newestFirst as any[]).reverse();
    const basis = await this.chargeBasisOf(user.tenantId);

    return appointments.map((apt: any) => this.enrichAppointment(apt, basis));
  }

  /** The most appointments GET /appointments returns. */
  static readonly FIND_ALL_MAX = 5000;

  async findOne(user: any, id: string) {
    const appointment = await (this.prisma.appointment.findUnique as any)({
      where: { id, tenantId: user.tenantId },
      include: {
        client: true,
        professional: true,
        service: true,
        tenant: true,
        services: {
          include: {
            service: true,
            professional: true,
          },
          orderBy: {
            order: "asc",
          },
        },
      },
    });

    if (!appointment) {
      throw new NotFoundException("Cita no encontrada");
    }

    // A client sees only their own appointments.
    if (user.role === "client" && appointment.clientId !== user.id) {
      throw new NotFoundException("Cita no encontrada");
    }

    // Validar que STAFF solo pueda ver sus propias citas
    if (user.role === "staff") {
      const professional = await this.prisma.professional.findFirst({
        where: { userId: user.id, tenantId: user.tenantId },
        select: { id: true },
      });

      if (!professional || appointment.professionalId !== professional.id) {
        throw new NotFoundException("No tienes permiso para ver esta cita");
      }
    }

    return this.enrichAppointment(
      appointment,
      appointment.tenant?.fiscalSettings !== undefined ? salonTaxBasis(appointment.tenant.fiscalSettings) : null,
    );
  }

  async update(
    user: any,
    id: string,
    updateAppointmentDto: UpdateAppointmentDto,
  ) {
    const appointment = await this.findOne(user, id);

    // Track old date/time for reschedule notifications
    const oldDate = appointment.scheduledDate;
    const oldTime = appointment.scheduledTime;
    const oldStatus = appointment.status as AppointmentStatus;

    // Built field by field from what an edit may change. The body used to be
    // spread in whole, so a request could set any column (price, payment,
    // commission, tenantId) or write the salon and its users through nested
    // relation updates.
    const dto = updateAppointmentDto;
    const updateData: any = { updatedAt: new Date() };
    if (dto.scheduledDate) {
      const date = new Date(dto.scheduledDate);
      if (isNaN(date.getTime())) {
        throw new BadRequestException("Invalid scheduledDate provided");
      }
      updateData.scheduledDate = date;
    }
    for (const key of [
      "serviceId",
      "professionalId",
      "clientId",
      "scheduledTime",
      "notes",
      "status",
      "cancellationReason",
    ] as const) {
      if (dto[key] !== undefined) updateData[key] = dto[key];
    }
    // Commission and deposit are the salon's terms, not the professional's.
    if (user.role === "owner" || user.role === "admin") {
      for (const key of ["commissionRate", "depositRequired", "depositAmount"] as const) {
        if (dto[key] !== undefined) updateData[key] = dto[key];
      }
    }
    await this.assertSalonRecords(user.tenantId, {
      serviceIds: [
        dto.serviceId,
        ...(dto.services ?? []).map((s) => s.serviceId),
        ...(dto.addons ?? []).map((a) => a.addonId),
      ],
      professionalIds: [dto.professionalId, ...(dto.services ?? []).map((s) => s.professionalId)],
      clientIds: [dto.clientId],
    });

    // Restricciones para usuarios STAFF
    if (user.role === "staff") {
      // STAFF no puede cambiar el profesional asignado
      delete updateData.professionalId;

      // STAFF solo puede actualizar citas que le pertenecen
      const professional = await this.prisma.professional.findFirst({
        where: { userId: user.id, tenantId: user.tenantId },
        select: { id: true },
      });

      if (!professional || appointment.professionalId !== professional.id) {
        throw new NotFoundException(
          "No tienes permiso para modificar esta cita",
        );
      }
    }

    // Remove undefined fields to avoid Prisma errors
    Object.keys(updateData).forEach((key) => {
      if (updateData[key] === undefined) {
        delete updateData[key];
      }
    });

    // A new status takes the same path as the cancel / complete / no-show
    // endpoints: checked here, before anything is written (services
    // included), and followed by the same notices and jobs after the write.
    // The form resends the status it shows, which is not a change.
    const statusTo =
      dto.status !== undefined && dto.status !== oldStatus ? dto.status : undefined;
    delete updateData.status;
    if (statusTo) {
      Object.assign(
        updateData,
        await this.prepareStatusChange(user, appointment, statusTo, {
          reason: dto.cancellationReason,
        }),
      );
    }

    // A move (new day, time or professional) must land on a free slot of the
    // professional's hours. Only when something actually changes: a form that
    // resends the same day and time to save a note is not a move.
    const timeZone = ((appointment as any).tenant?.timezone as string | undefined) || "Europe/Madrid";
    const dayOf = (d: Date | string) => (typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10));
    const oldClock = clockOf(appointment.scheduledTime, timeZone) ?? appointment.scheduledTime;
    const target = {
      day: dayOf(updateData.scheduledDate ?? appointment.scheduledDate),
      time: (updateData.scheduledTime as string | undefined) ?? oldClock,
      professionalId: (updateData.professionalId as string | undefined) ?? appointment.professionalId,
    };
    const moved =
      target.day !== dayOf(appointment.scheduledDate) ||
      target.time !== oldClock ||
      target.professionalId !== appointment.professionalId;
    // A cancelled appointment holds no slot, so moving one checks none.
    const holdsSlot = (statusTo ?? oldStatus) !== AppointmentStatus.cancelled;

    // The visit after this edit: its service rows (diffed, never recreated:
    // visit-edit.ts), its add-ons, and what they add up to (visit-totals.ts).
    const rowsBefore = (((appointment as any).services ?? []) as any[]).map((r) => ({
      ...r,
      isParallel: !!r.isParallel,
    }));
    const rowEdit =
      dto.services && dto.services.length > 0 ? planRowEdit(rowsBefore, dto.services) : null;
    const rowsChanged = !!rowEdit && editChangesRows(rowEdit);
    const done = rowEdit?.remove.find((r) => r.status === "completed");
    if (done) {
      throw new ConflictException(
        `${done.service?.name ?? "Un servicio"} ya está completado: no se puede quitar de la cita.`,
      );
    }
    if (dto.addons !== undefined) {
      // A plain list. It was written as {"set": [...]}, which the panel
      // could not read back.
      updateData.addons = normalizeAddons(dto.addons);
    }
    const serviceChanged = !!dto.serviceId && dto.serviceId !== appointment.serviceId;
    const priceChanges = rowsChanged || dto.addons !== undefined || serviceChanged;
    // A visit with services is always added up again: one saved before this
    // was fixed holds its first service's length and price only.
    const needsTotals = priceChanges || rowsBefore.some(isLiveRow);

    // Services the edit brings in (a new main service, new rows, add-ons):
    // their duration and price, from the salon's catalog.
    const catalogIds = [
      ...(serviceChanged ? [dto.serviceId!] : []),
      ...(rowEdit?.add ?? []).map((a) => a.serviceId),
      ...normalizeAddons(updateData.addons ?? (appointment as any).addons).map((a) => a.addonId),
    ];
    const catalog: Array<{ id: string; name?: string; duration: number; price: unknown; bufferTime?: number }> =
      needsTotals && catalogIds.length > 0
        ? await this.prisma.service.findMany({
            where: { tenantId: user.tenantId, id: { in: [...new Set(catalogIds)] } },
            select: { id: true, name: true, duration: true, price: true, bufferTime: true },
          })
        : [];
    const fromCatalog = (serviceId: string) => catalog.find((s) => s.id === serviceId) ?? null;

    const oldStart = salonInstant(appointment.scheduledDate, oldClock, timeZone);
    const newStart = salonInstant(target.day, target.time, timeZone);
    const shift = (d: Date | null | undefined) =>
      d ? new Date(new Date(d).getTime() + (newStart.getTime() - oldStart.getTime())) : null;

    // The rows as they will be: kept ones moved with the visit (or laid out
    // again when their place or mode changed), new ones after them.
    let rowsAfter: Array<VisitRow & { order: number }> = rowsBefore.map((r, order) => ({
      ...r,
      order: r.order ?? order,
      scheduledStart: shift(r.scheduledStart),
      scheduledEnd: shift(r.scheduledEnd),
    }));
    if (rowEdit) {
      rowsAfter = [
        ...rowEdit.keep.map((k) => ({
          ...k.row,
          order: k.order,
          professionalId: k.professionalId,
          isParallel: k.isParallel,
          scheduledStart: k.retime ? null : shift(k.row.scheduledStart),
          scheduledEnd: k.retime ? null : shift(k.row.scheduledEnd),
        })),
        ...rowEdit.add.map((a) => ({
          id: `new:${a.order}`,
          serviceId: a.serviceId,
          professionalId: a.professionalId,
          isParallel: a.isParallel,
          order: a.order,
          scheduledStart: null,
          scheduledEnd: null,
          type: "active",
          status: "pending",
          service: fromCatalog(a.serviceId),
        })),
      ].sort((a, b) => a.order - b.order);
    }
    const liveAfter = rowsAfter.filter(isLiveRow);
    const rowsMove = liveAfter.length > 0 && (moved || rowsChanged);

    // A professional changes a visit only when every service in it is
    // theirs (as for a drag: staffVisitCheck).
    if (user.role === "staff" && (rowsMove || rowsChanged)) {
      const mine = appointment.professionalId;
      const others = [...rowsBefore, ...rowsAfter].some((r) => (r.professionalId ?? mine) !== mine);
      if (others) {
        throw new ForbiddenException(
          "Esta cita la comparten varios profesionales: pide a la dueña o al encargado que la cambie.",
        );
      }
    }

    const addons = needsTotals
      ? normalizeAddons(updateData.addons ?? (appointment as any).addons).map((a) => ({
          quantity: a.quantity,
          service: fromCatalog(a.addonId),
        }))
      : [];
    const totals =
      needsTotals || liveAfter.length > 0
        ? visitTotals({
            start: newStart,
            professionalId: target.professionalId,
            mainService: serviceChanged ? fromCatalog(dto.serviceId!) : (appointment as any).service ?? null,
            rows: rowsAfter,
            addons,
          })
        : null;
    // Without a change to what a single-service appointment holds, its length
    // stays what it is (an imported appointment may have its own).
    const duration = totals ? totals.durationMinutes : appointment.duration;

    if (holdsSlot) {
      if (liveAfter.length > 0) {
        if (rowsMove) {
          const before = visitSchedule(oldStart, appointment.professionalId, rowsBefore);
          const after = totals!.schedule;
          const clash = clientDoubleBooked(after);
          if (clash && !clientDoubleBooked(before)) {
            const name = (rowId: string) =>
              (rowsAfter.find((r) => r.id === rowId)?.service as { name?: string } | null)?.name ?? "otro servicio";
            throw new ConflictException(`La clienta estaría a la vez en ${name(clash[0].id)} y ${name(clash[1].id)}.`);
          }
          // The cleanup after the visit, on the service it now ends with.
          const cleanup = plannedCleanup(after, liveAfter);
          for (const [i, s] of after.entries()) {
            const row = liveAfter.find((r) => r.id === s.id);
            if (row && freesProfessional(row)) continue;
            const b = before.find((x) => x.id === s.id);
            if (b && b.start.getTime() === s.start.getTime() && b.end.getTime() === s.end.getTime() && b.professionalId === s.professionalId) {
              continue;
            }
            const at = salonDayAndTime(s.start, timeZone);
            await assertCanReschedule(this.prisma as any, {
              tenantId: user.tenantId,
              appointmentId: appointment.id,
              professionalId: s.professionalId,
              day: at.day,
              time: at.time,
              durationMinutes: Math.round((s.end.getTime() - s.start.getTime()) / 60_000),
              cleanupMinutes: i === cleanup.index ? cleanup.minutes : 0,
            });
          }
        }
      } else {
        const cleanupBefore = cleanupMinutesOf((appointment as any).service);
        const cleanupAfter = serviceChanged ? cleanupMinutesOf(fromCatalog(dto.serviceId!)) : cleanupBefore;
        if (moved || duration > appointment.duration || cleanupAfter > cleanupBefore) {
          await assertCanReschedule(this.prisma as any, {
            tenantId: user.tenantId,
            appointmentId: appointment.id,
            professionalId: target.professionalId,
            day: target.day,
            time: target.time,
            durationMinutes: duration,
            cleanupMinutes: cleanupAfter,
          });
        }
      }
    }

    // The appointment's own time: the visit's first service, its length,
    // its end, its price (unless it is history: visit-sync.ts).
    if (totals && liveAfter.length > 0 && totals.start.getTime() !== newStart.getTime()) {
      const at = salonDayAndTime(totals.start, timeZone);
      updateData.scheduledDate = new Date(`${at.day}T00:00:00.000Z`);
      updateData.scheduledTime = at.time;
    }
    if (duration !== appointment.duration) updateData.duration = duration;
    if (updateData.scheduledTime || updateData.duration !== undefined) {
      updateData.endTime = endClock((updateData.scheduledTime as string | undefined) ?? target.time, duration);
    }
    if (totals && !priceIsFrozen(appointment)) {
      updateData.price = totals.price;
      updateData.totalAmount = totals.totalCents;
    }

    // A reschedule moves the instant the reminder jobs select on, and the
    // reminders already sent were for the old time.
    if (updateData.scheduledDate || updateData.scheduledTime) {
      const start = salonInstant(
        updateData.scheduledDate ?? appointment.scheduledDate,
        (updateData.scheduledTime as string | undefined) ?? oldClock,
        timeZone,
      );
      const before = (appointment as any).startTime as Date | null | undefined;
      // The drawer sends date and time on every full edit, so only a real move
      // re-arms the reminders: resetting on any edit re-sent ones already sent.
      if (!before || new Date(before).getTime() !== start.getTime()) {
        updateData.startTime = start;
        updateData.reminder24hSent = false;
        updateData.reminder1hSent = false;
        updateData.reminder24hAttempts = 0;
        updateData.reminder1hAttempts = 0;
      }
    }

    // The rows to write, in the same transaction as the appointment.
    const rowWrites: Array<(db: any) => Promise<unknown>> = [];
    if (rowEdit && rowsChanged) {
      const removeIds = rowEdit.remove.map((r) => r.id);
      if (removeIds.length > 0) {
        rowWrites.push((db) => db.appointmentService.deleteMany({
          where: { id: { in: removeIds }, appointmentId: id, appointment: { tenantId: user.tenantId } },
        }));
      }
      for (const a of rowEdit.add) {
        rowWrites.push((db) =>
          db.appointmentService.create({
            data: {
              appointmentId: id,
              serviceId: a.serviceId,
              professionalId: a.professionalId,
              isParallel: a.isParallel,
              order: a.order,
            },
          }),
        );
      }
    }
    for (const r of rowsAfter) {
      if (r.id.startsWith("new:")) continue;
      const was = rowsBefore.find((x) => x.id === r.id)!;
      const data: Record<string, unknown> = {};
      const sameTime = (x: Date | null | undefined, y: Date | null | undefined) =>
        (x ? new Date(x).getTime() : null) === (y ? new Date(y).getTime() : null);
      if (!sameTime(was.scheduledStart, r.scheduledStart)) data.scheduledStart = r.scheduledStart;
      if (!sameTime(was.scheduledEnd, r.scheduledEnd)) data.scheduledEnd = r.scheduledEnd;
      if ((was.professionalId ?? null) !== (r.professionalId ?? null)) data.professionalId = r.professionalId;
      if (!!was.isParallel !== !!r.isParallel) data.isParallel = r.isParallel;
      if (rowEdit && (was.order ?? null) !== r.order) data.order = r.order;
      if (Object.keys(data).length > 0) {
        rowWrites.push((db) => db.appointmentService.update({
          where: { id: r.id, appointmentId: id, appointment: { tenantId: user.tenantId } },
          data,
        }));
      }
    }


    try {
      // Get current appointment for activity logging
      const currentAppointment = await this.prisma.appointment.findUnique({
        where: { id, tenantId: user.tenantId },
        include: {
          client: true,
          professional: true,
          service: true,
          tenant: true,
        },
      });

      let updatedAppointment: any;
      const write = async (db: any) => {
        for (const w of rowWrites) await w(db);
        return db.appointment.update({
          // A status change is written only over the status it was checked
          // against (see changeStatus).
          where: (statusTo
            ? { id, tenantId: user.tenantId, status: oldStatus }
            : { id, tenantId: user.tenantId }) as any,
          data: updateData,
          include: {
            client: true,
            professional: true,
            service: true,
            tenant: true,
            services: {
              include: {
                service: true,
                professional: true,
              },
              orderBy: { order: "asc" },
            },
          },
        });
      };
      try {
        // Rows and appointment together, or neither.
        updatedAppointment =
          rowWrites.length > 0 ? await this.prisma.$transaction(write) : await write(this.prisma);
      } catch (err) {
        if (statusTo && isStaleWrite(err)) throw concurrentChange();
        throw err;
      }

      // Log activity for this update
      await this.logAppointmentActivity(id, "appointment_updated", user, {
        changes: updateData,
      });

      // Check if appointment was rescheduled (date or time changed). A
      // cancellation is told as a cancellation, not as a move.
      const isRescheduled =
        statusTo !== AppointmentStatus.cancelled &&
        ((updateAppointmentDto.scheduledDate &&
          new Date(updateAppointmentDto.scheduledDate).getTime() !==
            new Date(oldDate).getTime()) ||
          (updateAppointmentDto.scheduledTime &&
            updateAppointmentDto.scheduledTime !== oldTime));

      if (isRescheduled) {
        await this.sendAppointmentRescheduledNotifications(
          updatedAppointment,
          oldDate,
          oldTime,
        );
      }

      if (statusTo) {
        await this.afterStatusChange(user, updatedAppointment, oldStatus, statusTo, {
          reason: dto.cancellationReason,
        });
      }

      return this.enrichAppointment(updatedAppointment);
    } catch (error) {
      console.error("Error updating appointment:", error);
      // A refusal (consent missing, forbidden) keeps its status and message.
      if (error instanceof HttpException) throw error;
      throw new Error("Failed to update appointment");
    }
  }

  private async logAppointmentActivity(
    appointmentId: string,
    action: string,
    user: any,
    details: any,
  ): Promise<void> {
    try {
      await this.prisma.appointmentActivity.create({
        data: {
          appointmentId,
          action,
          details: {
            ...details,
            userId: user?.id,
            userRole: user?.role,
            userEmail: user?.email,
          },
        },
      });
    } catch (error) {
      console.error("Error logging appointment activity:", error);
      // Don't throw to avoid breaking the main operation
    }
  }

  /**
   * The calling client's own appointments, for the salon site's account
   * page. It used to call GET /appointments, which is staff-only, so a
   * signed-in client never saw a single appointment.
   */
  async findForClient(user: { id: string; tenantId: string }) {
    return this.prisma.appointment.findMany({
      where: { clientId: user.id, tenantId: user.tenantId },
      include: {
        service: true,
        professional: {
          select: { id: true, firstName: true, lastName: true, profileImage: true },
        },
      },
      orderBy: [{ scheduledDate: "desc" }, { scheduledTime: "desc" }],
    });
  }

  async cancel(user: any, id: string, reason?: string) {
    return this.changeStatus(user, id, AppointmentStatus.cancelled, { reason });
  }

  async complete(user: any, id: string, notes?: string) {
    return this.changeStatus(user, id, AppointmentStatus.completed, { notes });
  }

  async markNoShow(user: any, id: string) {
    return this.changeStatus(user, id, AppointmentStatus.no_show);
  }

  /**
   * The one path a status change takes, whichever route asked for it: the
   * cancel / complete / no-show endpoints, PATCH with a `status`, the
   * copilot, a multi-service visit whose services are all done. Checked
   * first (prepareStatusChange), written only if the status is still the one
   * we read, then followed by what the new status sets off
   * (afterStatusChange): the notices, the wait-list, the invoice, the
   * rebooking cadence, the points.
   *
   * `user` is whoever asks: a member of the team, a client (cancel only, via
   * the controller's roles) or, for the visit that completes on its own,
   * the system.
   */
  async changeStatus(
    user: any,
    id: string,
    to: AppointmentStatus,
    opts: StatusChangeOptions = {},
  ) {
    const appointment = await this.findOne(user, id);
    const from = appointment.status as AppointmentStatus;
    const data = await this.prepareStatusChange(user, appointment, to, opts);

    let updated: any;
    try {
      updated = await this.prisma.appointment.update({
        // Only if nobody changed it since we read it: two "complete" clicks
        // at once used to both go through and issue two invoices.
        where: { id, tenantId: user.tenantId, status: from } as any,
        data: { ...data, updatedAt: new Date() },
        include: {
          client: true,
          professional: true,
          service: true,
          tenant: true,
        },
      });
    } catch (err) {
      if (isStaleWrite(err)) throw concurrentChange();
      throw err;
    }

    await this.afterStatusChange(user, updated, from, to, opts);
    return this.enrichAppointment(updated);
  }

  /**
   * Everything that may refuse a status change, before anything is written:
   * the transition table, a client's cancellation notice, the service's
   * consent forms. Returns the columns to write along with the status.
   */
  private async prepareStatusChange(
    user: any,
    appointment: any,
    to: AppointmentStatus,
    opts: StatusChangeOptions,
  ): Promise<Record<string, unknown>> {
    const from = appointment.status as AppointmentStatus;
    assertTransition(from, to);

    // A client cancelling their own appointment is held to the salon's
    // minimum notice -- the same rule the virtual receptionist quotes. Staff
    // are not: the salon may always cancel.
    if (to === AppointmentStatus.cancelled && user?.role === "client") {
      const tenant = appointment.tenant as
        | { minCancelHours?: number; timezone?: string }
        | undefined;
      const minHours = tenant?.minCancelHours ?? 24;
      const startsAt = salonInstant(
        appointment.scheduledDate,
        appointment.scheduledTime,
        tenant?.timezone || "Europe/Madrid",
      );
      const hoursAway = (startsAt.getTime() - Date.now()) / 3_600_000;
      if (hoursAway < minHours) {
        throw new BadRequestException(
          `Esta cita solo se puede cancelar con ${minHours} horas de antelación. Contacta con el salón.`,
        );
      }
    }

    // Checked before the write: it used to run after it, so the client got
    // the 409 while the appointment had already changed.
    if (needsConsent(from, to)) {
      await this.assertConsent(appointment);
    }

    const data: Record<string, unknown> = { status: to };
    if (to === AppointmentStatus.cancelled) {
      data.cancellationReason = opts.reason || null;
    }
    if (to === AppointmentStatus.completed) {
      // The review request is timed from this.
      data.completionTime = new Date();
      if (opts.notes) data.notes = opts.notes;
    }
    return { ...data, ...opts.data };
  }

  /** Whether the client has signed every consent form the service needs. */
  private async consentAllowsConfirming(
    tenantId: string,
    clientId: string,
    serviceId: string,
  ): Promise<boolean> {
    if (!this.consentService) return true;
    return this.consentService.hasValidConsent(tenantId, clientId, serviceId);
  }

  /**
   * A service may require signed consent forms before the visit goes ahead
   * (confirmed, started or completed).
   */
  private async assertConsent(appointment: any): Promise<void> {
    if (!this.consentService) return;
    const ok = await this.consentService.hasValidConsent(
      appointment.tenantId,
      appointment.clientId,
      appointment.serviceId,
    );
    if (ok) return;
    const required = await this.consentService.getRequiredForms(
      appointment.tenantId,
      appointment.serviceId,
    );
    throw new ConflictException({
      code: "CONSENT_REQUIRED",
      message:
        "El cliente tiene que firmar los consentimientos de este servicio antes de seguir con la cita.",
      appointmentId: appointment.id,
      requiredConsents: required.map((f) => ({
        id: f.id,
        name: f.name,
        version: f.version,
      })),
    });
  }

  /**
   * What a new status sets off. Notices and side jobs never fail the change
   * itself: each catches its own errors.
   */
  private async afterStatusChange(
    user: any,
    updated: any,
    from: AppointmentStatus,
    to: AppointmentStatus,
    opts: StatusChangeOptions,
  ): Promise<void> {
    const id = updated.id as string;
    switch (to) {
      case AppointmentStatus.cancelled:
        await this.logAppointmentActivity(id, "appointment_cancelled", user, {
          reason: opts.reason,
        });
        await this.sendAppointmentCancelledNotifications(updated, opts.reason);
        this.offerFreedSlot(updated);
        break;

      case AppointmentStatus.completed:
        await this.logAppointmentActivity(id, "appointment_completed", user, {
          notes: opts.notes,
        });
        await this.sendAppointmentCompletedNotifications(updated);

        // P1.4 — Recompute cadence for this client after the visit completes.
        if (this.clientCadenceService) {
          this.clientCadenceService
            .computeForClient(updated.clientId)
            .catch((err) => {
              this.logger.warn(
                `computeForClient failed for client ${updated.clientId}: ${(err as Error).message}`,
              );
            });
        }

        // P2A — Auto-invoice the appointment if the tenant has opted in.
        // Once: the transition table refuses a second completion.
        if (this.invoiceService) {
          this.invoiceService.fromAppointment(id).catch((err) => {
            this.logger.warn(
              `auto-invoice from appointment failed for ${id}: ${(err as Error).message}`,
            );
          });
        }
        break;

      case AppointmentStatus.no_show:
        await this.logAppointmentActivity(id, "appointment_no_show", user, {});
        await this.sendAppointmentNoShowNotifications(updated);
        break;

      case AppointmentStatus.confirmed:
        await this.logAppointmentActivity(id, "appointment_status_changed", user, { from, to });
        await this.sendAppointmentConfirmedNotifications(updated);
        break;

      default:
        await this.logAppointmentActivity(id, "appointment_status_changed", user, { from, to });
    }

    // Points: completed and paid earns, cancelled gives them back.
    await this.loyaltyAfterStatus(updated.tenantId, id);

    // Her visits (count, first, last, average) follow her completed
    // appointments (client-stats.ts).
    if (to === AppointmentStatus.completed || from === AppointmentStatus.completed) {
      await refreshClientStats(this.prisma, updated.tenantId, [updated.clientId]);
    }
  }

  /**
   * The freed slot goes to the wait-list -- on any cancellation, and only
   * while the slot is still ahead: nobody can take one that has passed.
   * This used to mark every matching client "notified" without sending
   * anything; now they are really told (when the salon switched automatic
   * notices on), or the team is told who is waiting. Fire-and-forget: a
   * slow email or SMS provider must not hold up the cancellation.
   */
  private offerFreedSlot(cancelled: any): void {
    if (!this.waitListService || !cancelled.serviceId || !cancelled.professionalId) {
      return;
    }
    const startsAt = salonInstant(
      cancelled.scheduledDate,
      cancelled.scheduledTime || "23:59",
      cancelled.tenant?.timezone || "Europe/Madrid",
    );
    if (startsAt.getTime() <= Date.now()) return;
    this.waitListService
      .onAppointmentCancelled({
        tenantId: cancelled.tenantId,
        serviceId: cancelled.serviceId,
        professionalId: cancelled.professionalId,
        date: cancelled.scheduledDate,
        time: cancelled.scheduledTime,
      })
      .catch((err) =>
        this.logger.warn(
          `wait-list notification failed for cancelled appointment ${cancelled.id}: ${err.message}`,
        ),
      );
  }

  /**
   * Appointments the salon has not been paid for yet: payment pending or
   * failed, and a visit that is owed (not cancelled, not a no-show), from
   * today back unless a range is asked for. It used to return every
   * appointment, paid and future ones included, under "pending payment".
   */
  async findPendingPayment(
    user: any,
    filters: PendingPaymentFiltersDto,
  ) {
    const where: any = {
      tenantId: user.tenantId,
      paymentStatus: { in: [PaymentStatus.pending, PaymentStatus.failed] },
      status: { notIn: [AppointmentStatus.cancelled, AppointmentStatus.no_show] },
    };

    // Apply user role filtering
    if (user.role === "staff") {
      const professional = await this.prisma.professional.findFirst({
        where: { userId: user.id, tenantId: user.tenantId },
        select: { id: true },
      });

      // Unlinked staff account: nothing, not the whole salon (see findAll).
      if (!professional) return [];
      where.professionalId = professional.id;
    }

    // Apply search query (client name or appointment ID)
    if (filters.searchQuery) {
      const client = await this.prisma.client.findFirst({
        where: {
          tenantId: user.tenantId,
          OR: [
            { firstName: { contains: filters.searchQuery, mode: "insensitive" } },
            { lastName: { contains: filters.searchQuery, mode: "insensitive" } },
          ],
        },
      });

      if (client) {
        where.clientId = client.id;
      } else if (filters.searchQuery.match(/^[0-9a-f]+$/i)) {
        where.id = filters.searchQuery;
      }
    }

    // Apply date range filter. Without one: up to the end of today, the
    // visits that have already happened.
    where.scheduledDate = {
      lte: filters.dateTo
        ? new Date(filters.dateTo)
        : new Date(`${new Date().toISOString().slice(0, 10)}T23:59:59.999Z`),
    };
    if (filters.dateFrom) {
      where.scheduledDate.gte = new Date(filters.dateFrom);
    }

    // Apply status filter: one of the owed ones.
    if (filters.status) {
      if (
        !(Object.values(AppointmentStatus) as string[]).includes(filters.status) ||
        filters.status === AppointmentStatus.cancelled ||
        filters.status === AppointmentStatus.no_show
      ) {
        return [];
      }
      where.status = filters.status;
    }

    // Get appointments with payment info
    const appointments = await this.prisma.appointment.findMany({
      where,
      include: {
        client: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
          },
        },
        professional: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
        service: {
          select: {
            id: true,
            name: true,
            price: true,
            duration: true,
          },
        },
        payments: {
          select: {
            id: true,
            amount: true,
            status: true,
            type: true,
            isDeposit: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
        },
      },
      orderBy: { scheduledDate: "asc" },
      take: AppointmentsService.FIND_ALL_MAX,
    });

    // Nothing left to pay (a free service, or paid in full without the
    // status being updated) is not pending.
    const basis = await this.chargeBasisOf(user.tenantId);
    return appointments
      .map((apt: any) => this.enrichAppointment(apt, basis))
      .filter((apt: any) => apt.amountDue > 0);
  }

  /**
   * `PATCH /appointments/:id/payment`: the owner or a manager correcting how
   * an appointment stands. The till records real payments itself (POST
   * /pos/checkout); this writes no payment, so it earns no points either --
   * LoyaltyService.settleAppointment counts payments, not this flag.
   */
  async updatePaymentStatus(
    user: any,
    id: string,
    data: UpdateAppointmentPaymentDto,
  ) {
    // The controller already says so; checked here too, since a staff
    // member used this to mark their own appointments paid for any amount.
    if (user?.role !== "owner" && user?.role !== "admin") {
      throw new ForbiddenException("Solo la dueña o un encargado pueden corregir el pago de una cita.");
    }
    const appointment = await this.findOne(user, id);

    // amountPaid is in cents of money (tax included), the unit of the
    // column. There is no tip field: nothing above what the visit costs
    // (its money total, appointment-charge.ts) is accepted.
    const total = appointment.chargeTotal ?? appointmentTotalCents(appointment);
    if (data.amountPaid > total) {
      const euros = (c: number) => `${(c / 100).toFixed(2).replace(".", ",")} €`;
      throw new BadRequestException(
        `El importe pagado (${euros(data.amountPaid)}) no puede superar el total de la cita (${euros(total)}).`,
      );
    }
    if (data.status === PaymentStatus.paid) assertVisitChargeable(appointment);

    const updatedAppointment = await this.prisma.appointment.update({
      where: { id, tenantId: user.tenantId },
      data: {
        paymentStatus: data.status,
        amountPaid: data.amountPaid,
        ...(data.paymentMethod ? { paymentMethod: data.paymentMethod } : {}),
        updatedAt: new Date(),
      },
      include: {
        client: true,
        professional: true,
        service: true,
        tenant: true,
      },
    });

    // Refunded: the points go back. Paid: points only from recorded
    // payments, once the visit is also completed.
    await this.loyaltyAfterStatus(updatedAppointment.tenantId, id);

    return this.enrichAppointment(updatedAppointment);
  }

  /**
   * Drag one service of a multi-service appointment in the calendar. See
   * visit-move.ts: by default the whole visit moves; owners and managers may
   * move just this service (a wait agreed with the client). Every service
   * that moves must fit its professional's agenda and hours, the client is
   * never in two services at once, and the appointment's own time,
   * reminders and notice to the client follow.
   */
  async moveVisitService(
    user: any,
    serviceRowId: string,
    input: { scope: MoveScope; minutesDelta: number; professionalId?: string },
  ) {
    const visit = await this.loadVisit(user, serviceRowId);
    const staffOwn = await this.staffVisitCheck(user, visit);
    if (staffOwn) {
      if (input.scope !== "visit") {
        throw new ForbiddenException("Mover solo un servicio de la visita es cosa de la dueña o del encargado.");
      }
      if (input.professionalId && input.professionalId !== staffOwn) {
        throw new ForbiddenException("Solo puedes mover tus citas dentro de tu agenda.");
      }
    }
    const dragged = visit.services.find((s) => s.id === serviceRowId);
    if (!dragged) throw new NotFoundException("Servicio no encontrado en esta cita");
    const newStart = new Date(dragged.start.getTime() + input.minutesDelta * 60_000);
    const after = planVisitMove(visit.services, serviceRowId, newStart, input.scope, input.professionalId);
    return this.applyVisit(user, visit, after);
  }

  /**
   * The timing editor in the appointment card: one service gets a new start
   * and end, the serial ones after it follow. Same checks as a move. It used
   * to save the appointment's time as an ISO date ("2026-11-02T09:00:00Z")
   * instead of the salon's clock, and checked nothing.
   */
  async retimeVisitService(user: any, serviceRowId: string, start: Date, end: Date) {
    if (!(end > start)) throw new BadRequestException("El final tiene que ser después del inicio.");
    const visit = await this.loadVisit(user, serviceRowId);
    await this.staffVisitCheck(user, visit);
    return this.applyVisit(user, visit, planRetime(visit.services, serviceRowId, start, end));
  }

  private async loadVisit(user: any, serviceRowId: string) {
    const row = await this.prisma.appointmentService.findUnique({
      where: { id: serviceRowId, appointment: { tenantId: user.tenantId } },
      select: { appointmentId: true },
    });
    if (!row) throw new NotFoundException("Servicio no encontrado");
    return this.loadVisitOf(user, row.appointmentId);
  }

  /**
   * A visit as visit-move.ts models it: where each of its live services sits
   * (cancelled ones are no longer part of it). `rows` are all its rows, in
   * order; `processing` the ones during which nobody is busy.
   */
  private async loadVisitOf(user: any, appointmentId: string) {
    const appointment = await this.prisma.appointment.findFirst({
      where: { id: appointmentId, tenantId: user.tenantId },
      include: {
        tenant: { select: { timezone: true } },
        services: {
          orderBy: [{ order: "asc" }, { createdAt: "asc" }, { id: "asc" }],
          include: { service: { select: { name: true, duration: true, price: true, bufferTime: true } } },
        },
      },
    });
    if (!appointment) throw new NotFoundException("Cita no encontrada");
    const timeZone = (appointment as any).tenant?.timezone || "Europe/Madrid";
    const rows = (appointment as any).services as any[];
    // Each service's cleanup time, for the one the visit ends with (applyVisit).
    const cleanup = new Map<string, number>(rows.map((r) => [r.id, cleanupMinutesOf(r.service)]));
    const start = salonInstant(
      appointment.scheduledDate,
      clockOf(appointment.scheduledTime, timeZone) ?? appointment.scheduledTime,
      timeZone,
    );
    const services = visitSchedule(start, appointment.professionalId, rows);
    const names = new Map<string, string>(rows.map((r) => [r.id, r.service?.name ?? "otro servicio"]));
    const processing = new Set<string>(rows.filter((r) => freesProfessional(r)).map((r) => r.id));
    return { appointment, timeZone, start, services, rows, names, processing, cleanup };
  }

  /**
   * A professional changes a visit only when every service in it is theirs:
   * otherwise they would move colleagues' agendas. Returns their professional
   * id (null for owners and managers, who may).
   */
  private async staffVisitCheck(user: any, visit: { services: VisitService[] }): Promise<string | null> {
    if (user.role !== "staff") return null;
    const own = await this.prisma.professional.findFirst({
      where: { userId: user.id, tenantId: user.tenantId },
      select: { id: true },
    });
    if (!own) throw new NotFoundException("No tienes permiso para modificar esta cita");
    if (!visit.services.every((s) => s.professionalId === own.id)) {
      throw new ForbiddenException(
        "Esta cita la comparten varios profesionales: pide a la dueña o al encargado que la mueva.",
      );
    }
    return own.id;
  }

  /**
   * Reorder the services of a visit (the drawer's drag-and-drop). The visit
   * is laid out again from its start in the new order (layoutVisit) and goes
   * through the same checks and writes as a move. It used to write the
   * first row's ISO instant into the appointment's "HH:MM" time, and checked
   * nothing.
   *
   * Each item names a row by its id or, as the drawer sends it, by its
   * service; rows of the same service are taken in their current order.
   */
  async reorderVisitServices(
    user: any,
    appointmentId: string,
    serviceOrders: Array<{ serviceId: string; order: number }>,
  ) {
    if (!Array.isArray(serviceOrders)) throw new BadRequestException("Lista de servicios no válida");
    const visit = await this.loadVisitOf(user, appointmentId);
    await this.staffVisitCheck(user, visit);
    if (visit.rows.length === 0) throw new BadRequestException("Esta cita no tiene servicios que ordenar");

    const taken = new Set<string>();
    const ordered: any[] = [];
    for (const item of [...serviceOrders].sort((a, b) => Number(a?.order) - Number(b?.order))) {
      const row =
        visit.rows.find((r) => !taken.has(r.id) && r.id === item?.serviceId) ??
        visit.rows.find((r) => !taken.has(r.id) && r.serviceId === item?.serviceId);
      if (!row) throw new BadRequestException(`El servicio ${item?.serviceId} no está en esta cita`);
      taken.add(row.id);
      ordered.push(row);
    }
    if (ordered.length !== visit.rows.length) {
      throw new BadRequestException("Faltan servicios de la cita en el nuevo orden");
    }

    const byId = new Map(visit.services.map((s) => [s.id, s]));
    const live = ordered.map((r) => byId.get(r.id)).filter((s): s is VisitService => !!s);
    const after = layoutVisit(visitSpan(visit.services).start, live);
    const rowData = new Map<string, Record<string, unknown>>();
    ordered.forEach((r, order) => {
      if (r.order !== order) rowData.set(r.id, { order });
    });
    return this.applyVisit(user, visit, after, rowData);
  }

  /**
   * Switch one service of a visit between serial and parallel. The visit is
   * laid out again from its start (serial services one after another,
   * parallel ones alongside), through the same checks as a move. It used to
   * write an ISO instant into the appointment's "HH:MM" time.
   */
  async setVisitServiceMode(user: any, serviceRowId: string, isParallel: boolean) {
    if (typeof isParallel !== "boolean") throw new BadRequestException("isParallel tiene que ser true o false");
    const visit = await this.loadVisit(user, serviceRowId);
    await this.staffVisitCheck(user, visit);
    const row = visit.rows.find((r) => r.id === serviceRowId);
    if (!row) throw new NotFoundException("Servicio no encontrado en esta cita");
    if (!!row.isParallel === isParallel) return { appointmentId: visit.appointment.id, moved: 0 };
    const toggled = visit.services.map((s) => (s.id === serviceRowId ? { ...s, isParallel } : s));
    const after = layoutVisit(visitSpan(visit.services).start, toggled);
    return this.applyVisit(user, visit, after, new Map([[serviceRowId, { isParallel }]]));
  }

  /**
   * Move a whole appointment to a new day and time on the salon's clock,
   * through the panel's own checks: who may (findOne, staffVisitCheck),
   * whether its status allows it, and the reschedule check for every
   * professional in it. For callers that are not the drag or the form (the
   * copilot's reschedule_appointment, which wrote the date and time
   * straight into the row and checked nothing).
   */
  async rescheduleVisit(user: any, appointmentId: string, day: string, time: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || minutesOf(time) === null) {
      throw new BadRequestException("Fecha u hora no válida");
    }
    const appointment = await this.findOne(user, appointmentId);
    this.assertMovable(appointment.status, false);
    const visit = await this.loadVisitOf(user, appointmentId);
    if (visit.services.length === 0) {
      return this.update(user, appointmentId, { scheduledDate: day, scheduledTime: time } as UpdateAppointmentDto);
    }
    await this.staffVisitCheck(user, visit);
    const delta = salonInstant(day, time, visit.timeZone).getTime() - visitSpan(visit.services).start.getTime();
    const after = visit.services.map((s) => ({
      ...s,
      start: new Date(s.start.getTime() + delta),
      end: new Date(s.end.getTime() + delta),
    }));
    return this.applyVisit(user, visit, after);
  }

  /**
   * Only a visit still to happen is moved: not one done, cancelled or
   * missed. One under way may have its services adjusted (the timing
   * editor), but is not moved to another time as a whole.
   */
  private assertMovable(status: string, startedMayChange = true) {
    if (
      status === AppointmentStatus.completed ||
      status === AppointmentStatus.cancelled ||
      status === AppointmentStatus.no_show ||
      (!startedMayChange && status === AppointmentStatus.in_progress)
    ) {
      const word: Record<string, string> = {
        completed: "completada",
        cancelled: "cancelada",
        no_show: "marcada como no presentada",
        in_progress: "en curso",
      };
      throw new ConflictException(`Una cita ${word[status]} no se puede mover.`);
    }
  }

  private async applyVisit(
    user: any,
    visit: {
      appointment: any;
      timeZone: string;
      services: VisitService[];
      names: Map<string, string>;
      processing?: Set<string>;
      /** Each row's cleanup time (loadVisitOf). */
      cleanup?: Map<string, number>;
    },
    after: VisitService[],
    /** Further columns per row (order, mode), written with the times. */
    rowData: Map<string, Record<string, unknown>> = new Map(),
  ) {
    const { appointment, timeZone } = visit;
    const changed = changedServices(visit.services, after);
    if (changed.length === 0 && rowData.size === 0) return { appointmentId: appointment.id, moved: 0 };
    this.assertMovable(appointment.status);

    // She may wait between services if the salon chose to; she cannot be in two.
    const clash = clientDoubleBooked(after);
    if (clash && !clientDoubleBooked(visit.services)) {
      throw new ConflictException(
        `La clienta estaría a la vez en ${visit.names.get(clash[0].id)} y ${visit.names.get(clash[1].id)}.`,
      );
    }
    // The cleanup after the visit, on the service it now ends with.
    const cleanup = plannedCleanup(
      after,
      after.map((s) => ({
        type: visit.processing?.has(s.id) ? "processing" : null,
        service: { bufferTime: visit.cleanup?.get(s.id) ?? 0 },
      })),
    );
    const cleanupId = cleanup.index === -1 ? null : after[cleanup.index].id;
    for (const s of changed) {
      // While a colour sets, its professional is free: nothing to check.
      if (visit.processing?.has(s.id)) continue;
      const { day, time } = salonDayAndTime(s.start, timeZone);
      await assertCanReschedule(this.prisma as any, {
        tenantId: user.tenantId,
        appointmentId: appointment.id,
        professionalId: s.professionalId,
        day,
        time,
        durationMinutes: Math.round((s.end.getTime() - s.start.getTime()) / 60_000),
        cleanupMinutes: s.id === cleanupId ? cleanup.minutes : 0,
      });
    }

    // The appointment's own time and length: from its first to its last
    // service, plus what it held beyond them (add-ons).
    const span = visitSpan(after);
    const before = visitSpan(visit.services);
    const beyond = Math.max(
      0,
      (Number(appointment.duration) || 0) - Math.round((before.end.getTime() - before.start.getTime()) / 60_000),
    );
    const { day, time } = salonDayAndTime(span.start, timeZone);
    const duration = Math.round((span.end.getTime() - span.start.getTime()) / 60_000) + beyond;
    const oldDate = appointment.scheduledDate;
    const oldTime = appointment.scheduledTime;
    const startChanged = !appointment.startTime || new Date(appointment.startTime).getTime() !== span.start.getTime();

    const updated = await this.prisma.$transaction(async (tx: any) => {
      const changedIds = new Set(changed.map((s) => s.id));
      for (const s of after) {
        const extra = rowData.get(s.id);
        if (!changedIds.has(s.id) && !extra) continue;
        await tx.appointmentService.update({
          where: { id: s.id, appointmentId: appointment.id, appointment: { tenantId: user.tenantId } },
          data: {
            ...(changedIds.has(s.id)
              ? { scheduledStart: s.start, scheduledEnd: s.end, professionalId: s.professionalId }
              : {}),
            ...(extra ?? {}),
          },
        });
      }
      // Rows outside the schedule (cancelled ones) may still take a new order.
      for (const [id, extra] of rowData) {
        if (after.some((s) => s.id === id)) continue;
        await tx.appointmentService.update({
          where: { id, appointmentId: appointment.id, appointment: { tenantId: user.tenantId } },
          data: extra,
        });
      }
      return tx.appointment.update({
        where: { id: appointment.id, tenantId: user.tenantId },
        data: {
          scheduledDate: new Date(`${day}T00:00:00.000Z`),
          scheduledTime: time,
          duration,
          endTime: this.calculateEndTime(time, duration),
          ...(startChanged
            ? { startTime: span.start, reminder24hSent: false, reminder1hSent: false, reminder24hAttempts: 0, reminder1hAttempts: 0 }
            : {}),
        },
        include: { client: true, professional: true, service: true, tenant: true },
      });
    });

    const dayOf = (d: Date | string) => (typeof d === "string" ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10));
    if (dayOf(oldDate) !== day || oldTime !== time) {
      await this.sendAppointmentRescheduledNotifications(updated, oldDate, oldTime);
    }
    return { appointmentId: appointment.id, moved: changed.length, scheduledDate: day, scheduledTime: time, duration };
  }

  /**
   * Hard delete, only for an appointment that is not history yet: completed,
   * paid or invoiced ones are refused with a 409 that says to cancel instead.
   * See appointment-delete.ts.
   */
  async remove(user: any, id: string) {
    const appointment = await this.findOne(user, id);
    const blocker = await appointmentDeleteBlocker(this.prisma, appointment);
    if (blocker) throw new ConflictException(blocker);
    try {
      await deleteAppointmentRow(this.prisma, id);
    } catch (error) {
      // A payment recorded between the check and the delete.
      if (isForeignKeyViolation(error)) {
        throw new ConflictException(
          "No se puede eliminar una cita con pagos registrados: forma parte de la contabilidad. Cancélala en su lugar.",
        );
      }
      throw error;
    }
  }

  async getAppointmentActivity(user: any, appointmentId: string) {
    // Validar que el usuario tenga acceso a esta cita
    await this.findOne(user, appointmentId);

    return this.prisma.appointmentActivity.findMany({
      where: { appointmentId, appointment: { tenantId: user.tenantId } },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Every service, professional and client an edit points at is this
   * salon's. The tenant filter guards queries, not the ids written into a
   * row, so an id from another salon would link its record to this
   * appointment (and return it in the response).
   */
  async assertSalonRecords(
    tenantId: string,
    refs: {
      serviceIds?: Array<string | null | undefined>;
      professionalIds?: Array<string | null | undefined>;
      clientIds?: Array<string | null | undefined>;
    },
  ): Promise<void> {
    const unique = (ids?: Array<string | null | undefined>) =>
      [...new Set((ids ?? []).filter((id): id is string => !!id))];
    const checks: Array<[string[], (ids: string[]) => Promise<number>]> = [
      [unique(refs.serviceIds), (ids) => this.prisma.service.count({ where: { tenantId, id: { in: ids } } })],
      [unique(refs.professionalIds), (ids) => this.prisma.professional.count({ where: { tenantId, id: { in: ids } } })],
      [unique(refs.clientIds), (ids) => this.prisma.client.count({ where: { tenantId, id: { in: ids } } })],
    ];
    for (const [ids, count] of checks) {
      if (ids.length > 0 && (await count(ids)) !== ids.length) {
        throw new NotFoundException("Servicio, profesional o cliente no encontrado en este salón");
      }
    }
  }

  /**
   * "HH:MM" plus minutes, saturating at 23:59 (see endClock). It used to go
   * through the server's local clock and wrap: 23:30 + 60 min gave 00:30.
   */
  private calculateEndTime(startTime: string, durationMinutes: number): string {
    return endClock(startTime, durationMinutes);
  }

  async getAvailableSlots(
    tenantId: string,
    date: Date,
    professionalId?: string,
    serviceId?: string,
    duration: number = 60,
    professionalIds?: string[],
    /**
     * onlineWindow: keep only slots a client may book online -- inside the
     * service's minAdvanceBooking/maxAdvanceBooking and not in the past.
     * Applied here, with the tenant and service rows this method already
     * loads, rather than by a second pass that read them again.
     */
    opts: { onlineWindow?: boolean } = {},
  ) {
    // Get the tenant's working hours and timezone
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
    });

    if (!tenant) {
      throw new NotFoundException("Tenant not found");
    }

    // Determine which professionals to check
    const professionalsToCheck =
      professionalIds && professionalIds.length > 0
        ? professionalIds
        : professionalId
          ? [professionalId]
          : [];

    // Validate all professionals exist, and keep their rows: their
    // workingHours decide which slots are real. This used to count them and
    // throw the rows away, which is why availability ignored the one place
    // the schedule is actually stored.
    const professionalRows =
      professionalsToCheck.length > 0
        ? await this.prisma.professional.findMany({
            where: {
              id: { in: professionalsToCheck },
              tenantId,
            },
          })
        : [];

    if (professionalRows.length !== professionalsToCheck.length) {
      throw new NotFoundException("One or more professionals not found");
    }

    // "Any professional" still has to obey somebody's shift.
    //
    // The first version of this check only ran when a professional was named,
    // which is what the public booking page always does. The virtual
    // receptionist's check_availability tool does not name one, so it fell
    // through to a window of 09:00-20:00 and offered a Tuesday at 19:30 on a
    // salon whose only professional leaves at 19:00.
    // Only professionals who offer the service count -- the same rule
    // findFreeProfessional applies when it assigns one. Counting everyone
    // offered 16:30 for a massage because a hairdresser was free, and the
    // booking then found nobody to give it to. As there, a service no
    // professional is linked to falls back to everyone active.
    const activeRows =
      professionalsToCheck.length === 0
        ? await this.prisma.professional.findMany({
            where: { tenantId, isActive: true },
            include: { services: { select: { serviceId: true } } },
          })
        : [];
    const offeringRows = serviceId
      ? activeRows.filter((p: any) => (p.services ?? []).some((s: any) => s.serviceId === serviceId))
      : [];
    const anyProfessionalRows = offeringRows.length > 0 ? offeringRows : activeRows;

    // Get the service duration if specified
    let serviceDuration = duration;
    // The cleanup after it ("tiempo de limpieza", Service.bufferTime): the
    // professional stays busy that long after the service, so it may not run
    // into their next appointment. Not part of the hours: the service has to
    // end by closing time, the cleanup may run past it.
    let serviceCleanup = 0;
    let serviceRow: {
      isActive: boolean;
      isOnlineBookable: boolean;
      minAdvanceBooking: number | null;
      maxAdvanceBooking: number | null;
    } | null = null;
    if (serviceId) {
      const service = await this.prisma.service.findFirst({
        where: { id: serviceId, tenantId },
      });

      if (!service) {
        throw new NotFoundException("Service not found");
      }

      serviceDuration = service.duration;
      serviceCleanup = cleanupMinutesOf(service);
      serviceRow = service as any;
    }

    const dateString = date.toISOString().split('T')[0];

    // Time off and closures (time-off-rules.ts). A day the whole salon is
    // closed has nothing to offer, whoever is asked for; otherwise each
    // professional's shifts lose their own blocks and the salon's partial
    // closures, and a professional away all day has no shifts left.
    const timeOff = await timeOffBetween(this.prisma as any, tenantId, dateString);
    if (salonClosedOn(timeOff, dateString)) return [];
    // The salon's own hours that weekday (working-hours.ts salonWindowsFor):
    // none recorded imposes nothing, a weekday without hours is closed --
    // whoever has a shift then -- and otherwise a professional is bookable
    // only where their shifts and the salon's hours meet (bookableWindows).
    // An owner can still book outside them from the panel (assertCanBook).
    const salonHours = salonWindowsFor(tenant.openingHours, date);
    if (salonHours && salonHours.length === 0) return [];
    const salonBlocked = dayBlocks(timeOff, dateString, null);
    const windowsOf = (p: { id: string; workingHours?: unknown }) =>
      availableWindows(
        bookableWindows(workingWindowsFor(p.workingHours, date), salonHours),
        dayBlocks(timeOff, dateString, p.id),
      );
    const relevantRows: Array<{ id: string; workingHours?: unknown }> =
      professionalsToCheck.length > 0 ? professionalRows : anyProfessionalRows;
    const windowsById = new Map(relevantRows.map((p) => [p.id, windowsOf(p)]));

    // Candidate slots: the salon's hours that day, from its first opening to
    // its last closing (09:00–20:00 when it set none) every
    // Tenant.bookingSlotMinutes (half an hour unless the salon chose another
    // step in its general settings) --
    // previously hardcoded 9:00–18:00, which made the suggestion engine miss
    // every appointment past 17:30 -- plus every stretch the professionals
    // asked about can be booked in: a shift from 20:00 to 22:00, or the 10:15
    // start of one, is a candidate too (candidateStarts).
    const base: ShiftWindow = salonHours
      ? { startMinutes: salonHours[0].startMinutes, endMinutes: salonHours[salonHours.length - 1].endMinutes }
      : DEFAULT_SLOT_GRID;
    const salonOpen = salonHours ?? [base];
    const stretches: ShiftWindow[] = relevantRows.length
      ? relevantRows.flatMap((p) => {
          // No schedule recorded at all (neither theirs nor the salon's):
          // the default hours bound the grid, and a block ending inside them
          // starts a slot.
          if (bookableWindows(workingWindowsFor(p.workingHours, date), salonHours) === undefined) {
            return subtractWindows([base], dayBlocks(timeOff, dateString, p.id).windows);
          }
          return windowsById.get(p.id) ?? [];
        })
      : subtractWindows(salonOpen, salonBlocked.windows);
    const timeSlots = candidateStarts(base, stretches, bookingSlotStep(tenant.bookingSlotMinutes)).map(
      (m) => ({ time: clockOfMinutes(m) }),
    );

    // Get existing appointments for the date and professionals
    // Use date range to avoid timezone issues with date comparison
    const startOfDay = new Date(dateString + 'T00:00:00.000Z');
    const endOfDay = new Date(dateString + 'T23:59:59.999Z');

    // With their service rows: a multi-service visit keeps each of its
    // professionals busy during their own services, not its main one for
    // its first service (visit-totals.ts).
    const existingAppointments = await (this.prisma.appointment.findMany as any)({
      where: {
        tenantId,
        scheduledDate: {
          gte: startOfDay,
          lte: endOfDay,
        },
        ...(professionalsToCheck.length > 0
          ? {
              OR: [
                { professionalId: { in: professionalsToCheck } },
                { services: { some: { professionalId: { in: professionalsToCheck } } } },
              ],
            }
          : {}),
        status: { not: AppointmentStatus.cancelled },
      },
      // The service's cleanup time too: the agenda is busy for it after each
      // visit (appointmentBusyBlocks).
      include: {
        service: { select: { bufferTime: true } },
        services: { select: VISIT_ROW_SELECT, orderBy: VISIT_ROW_ORDER },
      },
    });
    const salonTimeZone = (tenant as any).timezone || "Europe/Madrid";
    const busy: BusyBlock[] = (existingAppointments as any[]).flatMap((apt) =>
      appointmentBusyBlocks(apt, salonTimeZone, dateString),
    );

    // Filter out unavailable slots
    const availableSlots = timeSlots.map((slot) => {
      // For multi-professional, check if ALL professionals are available at this slot
      let isAvailable = true;

      if (professionalsToCheck.length > 0) {
        // Check each professional's availability
        for (const profId of professionalsToCheck) {
          // Outside this professional's shift the slot is not bookable, no
          // matter how empty the calendar looks. A missing schedule imposes no
          // limit, so salons that never filled it in keep working.
          // With a split day the service has to fit inside one shift: 13:30
          // for an hour runs into the lunch gap of a 10:00–14:00 morning.
          // Time off is already out of these windows (windowsOf).
          const shifts = windowsById.get(profId);
          const slotMinutes = minutesOf(slot.time);

          if (shifts && shifts.length === 0) {
            // Has a schedule and does not work this weekday, or is away all day.
            isAvailable = false;
            break;
          }
          if (
            shifts &&
            slotMinutes !== null &&
            !fitsInShifts(slotMinutes, serviceDuration, shifts)
          ) {
            isAvailable = false;
            break;
          }

          const hasConflict =
            slotMinutes !== null &&
            busy.some(
              (block) =>
                block.professionalId === profId &&
                clashesWithBlock(block, slotMinutes, serviceDuration, serviceCleanup),
            );

          if (hasConflict) {
            isAvailable = false;
            break;
          }
        }
      } else {
        // No professional named: the slot is bookable when AT LEAST ONE of
        // the tenant's professionals is both on shift and free for it. Asking
        // only "is anybody busy" answered a different question, and answered
        // it wrongly — it offered hours nobody works.
        const slotMinutes = minutesOf(slot.time);
        const overlaps = (block: BusyBlock) =>
          slotMinutes !== null && clashesWithBlock(block, slotMinutes, serviceDuration, serviceCleanup);

        if (anyProfessionalRows.length === 0) {
          // No professionals recorded at all: impose no shift limit, and the
          // salon is free when nothing overlaps -- inside its hours when it
          // set them, and not while it is closed.
          const open = availableWindows(salonHours, salonBlocked);
          isAvailable =
            (!open || (slotMinutes !== null && fitsInShifts(slotMinutes, serviceDuration, open))) &&
            !busy.some(overlaps);
        } else {
          // Somebody who is on shift for the whole slot AND has nothing of
          // their own overlapping it. This used to ask "is anyone on shift"
          // and then "does ANY appointment overlap" -- so one stylist's 11:00
          // took 10:30 away from the four who were free.
          isAvailable = anyProfessionalRows.some((p) => {
            const shifts = windowsById.get(p.id);
            if (
              shifts &&
              !(slotMinutes !== null && fitsInShifts(slotMinutes, serviceDuration, shifts))
            ) {
              return false;
            }
            return !busy.some((block) => block.professionalId === p.id && overlaps(block));
          });
        }
      }

      return {
        time: slot.time,
        isAvailable,
        professionalId:
          professionalsToCheck.length === 1
            ? professionalsToCheck[0]
            : undefined,
        professionalIds:
          professionalsToCheck.length > 1 ? professionalsToCheck : undefined,
        serviceId,
      };
    });

    const free = availableSlots.filter((slot) => slot.isAvailable);
    if (!opts.onlineWindow) return free;

    // Nothing a booking from outside the salon would refuse
    // (assertBookableOnline): a service it does not offer online, or a named
    // professional who no longer works there.
    if (serviceRow && (serviceRow.isActive === false || serviceRow.isOnlineBookable === false)) return [];
    if (professionalRows.some((p: any) => p.isActive === false)) return [];
    // Nor a named professional who does not perform the service: the
    // booking would be refused (assertBookableOnline).
    if (professionalId && serviceId && !(await this.offersService(tenantId, professionalId, serviceId))) {
      return [];
    }
    const window = {
      timeZone: (tenant as any).timezone || "Europe/Madrid",
      minHours: serviceRow?.minAdvanceBooking ?? 0,
      maxHours: serviceRow ? (serviceRow.maxAdvanceBooking ?? 30) * 24 : Infinity,
    };
    const now = Date.now();
    return free.filter((slot) => this.fitsOnlineWindow(dateString, slot.time, window, now) === "ok");
  }

  /**
   * Send notifications when an appointment is created
   * Notifies: Client, Professional, Admin
   */
  private async sendAppointmentCreatedNotifications(
    appointment: any,
  ): Promise<{ emailSent: boolean; smsSent: boolean }> {
    // Whether the client's confirmation email and SMS actually went out. The
    // chat receptionist said "te hemos enviado la confirmación" either way.
    let emailSent = false;
    let smsSent = false;
    try {
      this.logger.log(
        `Sending appointment created notifications for appointment ${appointment.id}`,
      );
      // Ids only. This dumped the whole client row -- email, phone, notes,
      // allergies and, for clients with an account, the password hash.
      this.logger.debug(
        `Appointment details: clientId=${appointment.clientId}, tenantId=${appointment.tenantId}`,
      );

      // Get tenant language for translations
      const tenantLanguage = appointment.tenant?.language || "es";

      const dateStr = new Date(appointment.scheduledDate).toLocaleDateString(
        tenantLanguage === "es" ? "es-ES" : "en-US",
        {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        },
      );

      const clientName = appointment.client
        ? `${appointment.client.firstName} ${appointment.client.lastName}`.trim()
        : "Cliente";
      const professionalName = appointment.professional
        ? `${appointment.professional.firstName} ${appointment.professional.lastName}`.trim()
        : "Profesional";
      const serviceName = appointment.service?.name || "Servicio";
      const salonName = appointment.tenant?.name || "KiraRoom";

      // Check client notification preferences before sending
      const canSendEmail =
        appointment.clientId &&
        (await this.notificationsService.shouldSendNotification(
          appointment.clientId,
          "appointment_confirmed",
          "email",
        ));
      const canSendSms =
        appointment.clientId &&
        (await this.notificationsService.shouldSendNotification(
          appointment.clientId,
          "appointment_confirmed",
          "sms",
        ));
      const canSendWhatsapp =
        appointment.clientId &&
        (await this.notificationsService.shouldSendNotification(
          appointment.clientId,
          "appointment_confirmed",
          "whatsapp",
        ));

      // Send confirmation email to client
      if (appointment.client?.email && canSendEmail) {
        try {
          // sendEmail reports failure in its result rather than throwing;
          // this logged "Sent" for emails the provider had refused.
          const sent: any = await this.emailService.sendAppointmentConfirmation({
            clientName,
            clientEmail: appointment.client.email,
            serviceName,
            professionalName,
            date: dateStr,
            time: appointment.scheduledTime,
            salonName,
          });
          if (sent?.success === false) {
            this.logger.warn(
              `Confirmation email to client ${appointment.clientId} was not sent: ${sent.error}`,
            );
          } else {
            emailSent = true;
            this.logger.log(
              `Sent confirmation email to client ${appointment.clientId}`,
            );
          }
        } catch (error) {
          this.logger.error(
            `Failed to send confirmation email: ${error.message}`,
          );
        }
      } else if (appointment.client?.email && !canSendEmail) {
        this.logger.log(
          `Skipping confirmation email to client ${appointment.clientId} due to preferences`,
        );
      }

      // Send confirmation SMS to client
      if (appointment.client?.phone && canSendSms) {
        try {
          // Like the email: failure comes back in the result, not as a throw.
          const sent: any = await this.smsService.sendAppointmentConfirmation({
            clientName,
            clientPhone: appointment.client.phone,
            serviceName,
            professionalName,
            date: dateStr,
            time: appointment.scheduledTime,
            salonName,
          });
          if (sent?.success === false) {
            this.logger.warn(
              `Confirmation SMS to client ${appointment.clientId} was not sent: ${sent.error}`,
            );
          } else {
            smsSent = true;
            this.logger.log(`Sent confirmation SMS to client ${appointment.clientId}`);
          }
        } catch (error) {
          this.logger.error(
            `Failed to send confirmation SMS: ${error.message}`,
          );
        }
      } else if (appointment.client?.phone && !canSendSms) {
        this.logger.log(
          `Skipping confirmation SMS to client ${appointment.clientId} due to preferences`,
        );
      }

      // Send confirmation WhatsApp to client: the salon's template first.
      if (appointment.client?.phone && canSendWhatsapp) {
        try {
          if (!(await this.sendWhatsAppViaSalon("confirmed", appointment))) {
            await this.whatsappService.sendAppointmentConfirmation({
              clientName,
              clientPhone: appointment.client.phone,
              serviceName,
              professionalName,
              date: dateStr,
              time: appointment.scheduledTime,
              salonName,
            });
          }
          this.logger.log(
            `Sent confirmation WhatsApp to client ${appointment.clientId}`,
          );
        } catch (error) {
          this.logger.error(
            `Failed to send confirmation WhatsApp: ${error.message}`,
          );
        }
      } else if (appointment.client?.phone && !canSendWhatsapp) {
        this.logger.log(
          `Skipping confirmation WhatsApp to client ${appointment.clientId} due to preferences`,
        );
      }

      // 1. Notify the client (in-app)
      if (appointment.client) {
        this.logger.log(
          `Creating notification for client ${appointment.clientId}`,
        );
        await this.notificationsService.create({
          tenantId: appointment.tenantId,
          clientId: appointment.clientId,
          type: NotificationType.APPOINTMENT_CREATED,
          title: this.translationsService.translate(
            tenantLanguage as any,
            "notifications.appointment.created.title",
          ),
          message: this.translationsService.translate(
            tenantLanguage as any,
            "notifications.appointment.created.client_message",
            {
              date: dateStr,
              time: appointment.scheduledTime,
            },
          ),
          data: {
            appointmentId: appointment.id,
            serviceId: appointment.serviceId,
            serviceName,
            professionalId: appointment.professionalId,
            professionalName,
            date: appointment.scheduledDate,
            time: appointment.scheduledTime,
          },
        });
        this.logger.log(`Client notification created successfully`);
      } else {
        this.logger.warn(
          `No client found for appointment ${appointment.id}, skipping client notification`,
        );
      }

      // 2. Notify the professional (in-app)
      if (appointment.professional && appointment.professional.userId) {
        await this.notificationsService.create({
          tenantId: appointment.tenantId,
          userId: appointment.professional.userId,
          type: NotificationType.NEW_APPOINTMENT_ASSIGNED,
          title: this.translationsService.translate(
            tenantLanguage as any,
            "notifications.appointment.created.title",
          ),
          message: this.translationsService.translate(
            tenantLanguage as any,
            "notifications.appointment.created.message",
            {
              client: clientName,
              date: dateStr,
              time: appointment.scheduledTime,
            },
          ),
          data: {
            appointmentId: appointment.id,
            clientId: appointment.clientId,
            clientName,
            serviceId: appointment.serviceId,
            serviceName,
            date: appointment.scheduledDate,
            time: appointment.scheduledTime,
          },
        });
      }

      // 3. Notify admins (users with admin role in the tenant)
      const admins = await this.prisma.user.findMany({
        where: {
          tenantId: appointment.tenantId,
          role: "admin",
        },
      });

      for (const admin of admins) {
        // Skip if this admin is also the professional (avoid duplicate)
        if (
          appointment.professional &&
          admin.id === appointment.professional.userId
        ) {
          continue;
        }

        await this.notificationsService.create({
          tenantId: appointment.tenantId,
          userId: admin.id,
          type: NotificationType.APPOINTMENT_CREATED,
          title: this.translationsService.translate(
            tenantLanguage as any,
            "notifications.appointment.created.title",
          ),
          message: this.translationsService.translate(
            tenantLanguage as any,
            "notifications.appointment.created.message",
            {
              client: clientName,
              professional: professionalName,
              date: dateStr,
              time: appointment.scheduledTime,
            },
          ),
          data: {
            appointmentId: appointment.id,
            clientId: appointment.clientId,
            clientName,
            professionalId: appointment.professionalId,
            professionalName,
            serviceId: appointment.serviceId,
            serviceName,
            date: appointment.scheduledDate,
            time: appointment.scheduledTime,
          },
        });
      }

      this.logger.log(
        `Sent appointment created notifications for appointment ${appointment.id}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to send appointment created notifications: ${error.message}`,
      );
      // Don't throw - notifications are not critical to the appointment creation
    }
    return { emailSent, smsSent };
  }

  /**
   * Send notifications when an appointment is completed
   * Notifies: Client, Professional, Admin
   */
  private async sendAppointmentCompletedNotifications(appointment: any) {
    try {
      const dateStr = new Date(appointment.scheduledDate).toLocaleDateString(
        "es-ES",
        {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        },
      );

      // 1. Notify the client
      if (appointment.client) {
        await this.notificationsService.create({
          tenantId: appointment.tenantId,
          clientId: appointment.clientId,
          type: NotificationType.APPOINTMENT_COMPLETED,
          title: "Cita Completada",
          message: `Tu cita para ${appointment.service?.name || "servicio"} ha sido completada. ¡Gracias por tu visita!`,
          data: {
            appointmentId: appointment.id,
            serviceId: appointment.serviceId,
            serviceName: appointment.service?.name,
            professionalId: appointment.professionalId,
            professionalName: appointment.professional
              ? `${appointment.professional.firstName} ${appointment.professional.lastName}`
              : null,
          },
        });
      }

      // 2. Notify the professional
      if (appointment.professional && appointment.professional.userId) {
        await this.notificationsService.create({
          tenantId: appointment.tenantId,
          userId: appointment.professional.userId,
          type: NotificationType.APPOINTMENT_COMPLETED,
          title: "Cita Completada",
          message: `La cita con ${appointment.client?.firstName || ""} ${appointment.client?.lastName || ""} ha sido marcada como completada.`,
          data: {
            appointmentId: appointment.id,
            clientId: appointment.clientId,
            clientName: appointment.client
              ? `${appointment.client.firstName} ${appointment.client.lastName}`
              : null,
            serviceId: appointment.serviceId,
            serviceName: appointment.service?.name,
          },
        });
      }

      // 3. Notify admins
      const admins = await this.prisma.user.findMany({
        where: {
          tenantId: appointment.tenantId,
          role: "admin",
        },
      });

      for (const admin of admins) {
        // Skip if this admin is also the professional (avoid duplicate)
        if (
          appointment.professional &&
          admin.id === appointment.professional.userId
        ) {
          continue;
        }

        await this.notificationsService.create({
          tenantId: appointment.tenantId,
          userId: admin.id,
          type: NotificationType.APPOINTMENT_COMPLETED,
          title: "Cita Completada",
          message: `La cita de ${appointment.client?.firstName || ""} ${appointment.client?.lastName || ""} con ${appointment.professional?.firstName || ""} ${appointment.professional?.lastName || ""} ha sido completada.`,
          data: {
            appointmentId: appointment.id,
            clientId: appointment.clientId,
            clientName: appointment.client
              ? `${appointment.client.firstName} ${appointment.client.lastName}`
              : null,
            professionalId: appointment.professionalId,
            professionalName: appointment.professional
              ? `${appointment.professional.firstName} ${appointment.professional.lastName}`
              : null,
            serviceId: appointment.serviceId,
            serviceName: appointment.service?.name,
          },
        });
      }

      this.logger.log(
        `Sent appointment completed notifications for appointment ${appointment.id}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to send appointment completed notifications: ${error.message}`,
      );
      // Don't throw - notifications are not critical to the appointment completion
    }
  }

  /**
   * Send notifications when an appointment is cancelled
   * Notifies: Client, Professional, Admin
   */
  private async sendAppointmentCancelledNotifications(
    appointment: any,
    reason?: string,
  ) {
    try {
      this.logger.log(
        `Sending appointment cancelled notifications for appointment ${appointment.id}`,
      );

      const dateStr = new Date(appointment.scheduledDate).toLocaleDateString(
        "es-ES",
        {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        },
      );

      const clientName = appointment.client
        ? `${appointment.client.firstName} ${appointment.client.lastName}`.trim()
        : "Cliente";
      const professionalName = appointment.professional
        ? `${appointment.professional.firstName} ${appointment.professional.lastName}`.trim()
        : "Profesional";
      const serviceName = appointment.service?.name || "Servicio";
      const salonName = appointment.tenant?.name || "KiraRoom";

      // Check client notification preferences before sending
      const canSendEmail =
        appointment.clientId &&
        (await this.notificationsService.shouldSendNotification(
          appointment.clientId,
          "appointment_cancelled",
          "email",
        ));
      const canSendSms =
        appointment.clientId &&
        (await this.notificationsService.shouldSendNotification(
          appointment.clientId,
          "appointment_cancelled",
          "sms",
        ));
      const canSendWhatsapp =
        appointment.clientId &&
        (await this.notificationsService.shouldSendNotification(
          appointment.clientId,
          "appointment_cancelled",
          "whatsapp",
        ));

      // Send cancellation email to client
      if (appointment.client?.email && canSendEmail) {
        try {
          await this.emailService.sendAppointmentCancellation(
            {
              clientName,
              clientEmail: appointment.client.email,
              serviceName,
              professionalName,
              date: dateStr,
              time: appointment.scheduledTime,
              salonName,
            },
            reason,
          );
          this.logger.log(
            `Sent cancellation email to client ${appointment.clientId}`,
          );
        } catch (error) {
          this.logger.error(
            `Failed to send cancellation email: ${error.message}`,
          );
        }
      } else if (appointment.client?.email && !canSendEmail) {
        this.logger.log(
          `Skipping cancellation email to client ${appointment.clientId} due to preferences`,
        );
      }

      // Send cancellation SMS to client
      if (appointment.client?.phone && canSendSms) {
        try {
          await this.smsService.sendAppointmentCancellation(
            {
              clientName,
              clientPhone: appointment.client.phone,
              serviceName,
              professionalName,
              date: dateStr,
              time: appointment.scheduledTime,
              salonName,
            },
            reason,
          );
          this.logger.log(
            `Sent cancellation SMS to client ${appointment.clientId}`,
          );
        } catch (error) {
          this.logger.error(
            `Failed to send cancellation SMS: ${error.message}`,
          );
        }
      } else if (appointment.client?.phone && !canSendSms) {
        this.logger.log(
          `Skipping cancellation SMS to client ${appointment.clientId} due to preferences`,
        );
      }

      // Send cancellation WhatsApp to client
      if (appointment.client?.phone && canSendWhatsapp) {
        try {
          // The salon's template first (the free text is refused outside
          // WhatsApp's 24-hour window).
          if (!(await this.sendWhatsAppViaSalon("cancelled", appointment))) {
            await this.whatsappService.sendAppointmentCancellation(
              {
                clientName,
                clientPhone: appointment.client.phone,
                serviceName,
                professionalName,
                date: dateStr,
                time: appointment.scheduledTime,
                salonName,
              },
              reason,
            );
          }
          this.logger.log(
            `Sent cancellation WhatsApp to client ${appointment.clientId}`,
          );
        } catch (error) {
          this.logger.error(
            `Failed to send cancellation WhatsApp: ${error.message}`,
          );
        }
      } else if (appointment.client?.phone && !canSendWhatsapp) {
        this.logger.log(
          `Skipping cancellation WhatsApp to client ${appointment.clientId} due to preferences`,
        );
      }

      // 1. Notify the client (in-app)
      if (appointment.client) {
        const message = reason
          ? `Tu cita para ${serviceName} el ${dateStr} ha sido cancelada. Motivo: ${reason}`
          : `Tu cita para ${serviceName} el ${dateStr} ha sido cancelada.`;

        await this.notificationsService.create({
          tenantId: appointment.tenantId,
          clientId: appointment.clientId,
          type: NotificationType.APPOINTMENT_CANCELLED,
          title: "Cita Cancelada",
          message,
          data: {
            appointmentId: appointment.id,
            serviceId: appointment.serviceId,
            serviceName,
            professionalId: appointment.professionalId,
            professionalName,
            reason,
          },
        });
      }

      // 2. Notify the professional (in-app)
      if (appointment.professional && appointment.professional.userId) {
        const message = reason
          ? `La cita con ${clientName} el ${dateStr} ha sido cancelada. Motivo: ${reason}`
          : `La cita con ${clientName} el ${dateStr} ha sido cancelada.`;

        await this.notificationsService.create({
          tenantId: appointment.tenantId,
          userId: appointment.professional.userId,
          type: NotificationType.APPOINTMENT_CANCELLED,
          title: "Cita Cancelada",
          message,
          data: {
            appointmentId: appointment.id,
            clientId: appointment.clientId,
            clientName,
            serviceId: appointment.serviceId,
            serviceName,
            reason,
          },
        });
      }

      // 3. Notify admins
      const admins = await this.prisma.user.findMany({
        where: {
          tenantId: appointment.tenantId,
          role: "admin",
        },
      });

      for (const admin of admins) {
        if (
          appointment.professional &&
          admin.id === appointment.professional.userId
        ) {
          continue;
        }

        const message = reason
          ? `La cita de ${clientName} con ${professionalName} el ${dateStr} ha sido cancelada. Motivo: ${reason}`
          : `La cita de ${clientName} con ${professionalName} el ${dateStr} ha sido cancelada.`;

        await this.notificationsService.create({
          tenantId: appointment.tenantId,
          userId: admin.id,
          type: NotificationType.APPOINTMENT_CANCELLED,
          title: "Cita Cancelada",
          message,
          data: {
            appointmentId: appointment.id,
            clientId: appointment.clientId,
            clientName,
            professionalId: appointment.professionalId,
            professionalName,
            serviceId: appointment.serviceId,
            serviceName,
            reason,
          },
        });
      }

      this.logger.log(
        `Sent appointment cancelled notifications for appointment ${appointment.id}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to send appointment cancelled notifications: ${error.message}`,
      );
    }
  }

  /**
   * Send notifications when an appointment is rescheduled
   * Notifies: Client, Professional, Admin
   */
  private async sendAppointmentRescheduledNotifications(
    appointment: any,
    oldDate: Date,
    oldTime: string,
  ) {
    try {
      this.logger.log(
        `Sending appointment rescheduled notifications for appointment ${appointment.id}`,
      );

      const newDateStr = new Date(appointment.scheduledDate).toLocaleDateString(
        "es-ES",
        {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        },
      );

      const oldDateStr = new Date(oldDate).toLocaleDateString("es-ES", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });

      const clientName = appointment.client
        ? `${appointment.client.firstName} ${appointment.client.lastName}`.trim()
        : "Cliente";
      const professionalName = appointment.professional
        ? `${appointment.professional.firstName} ${appointment.professional.lastName}`.trim()
        : "Profesional";
      const serviceName = appointment.service?.name || "Servicio";
      const salonName = appointment.tenant?.name || "KiraRoom";

      // Check client notification preferences before sending
      const canSendEmail =
        appointment.clientId &&
        (await this.notificationsService.shouldSendNotification(
          appointment.clientId,
          "appointment_confirmed",
          "email",
        ));
      const canSendSms =
        appointment.clientId &&
        (await this.notificationsService.shouldSendNotification(
          appointment.clientId,
          "appointment_confirmed",
          "sms",
        ));

      // Send rescheduled email to client
      if (appointment.client?.email && canSendEmail) {
        try {
          await this.emailService.sendAppointmentRescheduled(
            {
              clientName,
              clientEmail: appointment.client.email,
              serviceName,
              professionalName,
              date: newDateStr,
              time: appointment.scheduledTime,
              salonName,
            },
            oldDateStr,
            oldTime,
          );
          this.logger.log(
            `Sent rescheduled email to client ${appointment.clientId}`,
          );
        } catch (error) {
          this.logger.error(
            `Failed to send rescheduled email: ${error.message}`,
          );
        }
      } else if (appointment.client?.email && !canSendEmail) {
        this.logger.log(
          `Skipping rescheduled email to client ${appointment.clientId} due to preferences`,
        );
      }

      // Send rescheduled SMS to client
      if (appointment.client?.phone && canSendSms) {
        try {
          await this.smsService.sendAppointmentRescheduled(
            {
              clientName,
              clientPhone: appointment.client.phone,
              serviceName,
              professionalName,
              date: newDateStr,
              time: appointment.scheduledTime,
              salonName,
            },
            oldDateStr,
            oldTime,
          );
          this.logger.log(
            `Sent rescheduled SMS to client ${appointment.clientId}`,
          );
        } catch (error) {
          this.logger.error(`Failed to send rescheduled SMS: ${error.message}`);
        }
      } else if (appointment.client?.phone && !canSendSms) {
        this.logger.log(
          `Skipping rescheduled SMS to client ${appointment.clientId} due to preferences`,
        );
      }

      // Send rescheduled WhatsApp to client
      const canSendWhatsapp =
        appointment.clientId &&
        (await this.notificationsService.shouldSendNotification(
          appointment.clientId,
          "appointment_confirmed",
          "whatsapp",
        ));
      if (appointment.client?.phone && canSendWhatsapp) {
        try {
          // The salon's template first (the free text is refused outside
          // WhatsApp's 24-hour window).
          if (!(await this.sendWhatsAppViaSalon("rescheduled", appointment))) {
            await this.whatsappService.sendAppointmentRescheduled(
              {
                clientName,
                clientPhone: appointment.client.phone,
                serviceName,
                professionalName,
                date: newDateStr,
                time: appointment.scheduledTime,
                salonName,
              },
              oldDateStr,
              oldTime,
            );
          }
          this.logger.log(
            `Sent rescheduled WhatsApp to client ${appointment.clientId}`,
          );
        } catch (error) {
          this.logger.error(
            `Failed to send rescheduled WhatsApp: ${error.message}`,
          );
        }
      } else if (appointment.client?.phone && !canSendWhatsapp) {
        this.logger.log(
          `Skipping rescheduled WhatsApp to client ${appointment.clientId} due to preferences`,
        );
      }

      // 1. Notify the client (in-app)
      if (appointment.client) {
        await this.notificationsService.create({
          tenantId: appointment.tenantId,
          clientId: appointment.clientId,
          type: NotificationType.APPOINTMENT_RESCHEDULED,
          title: "Cita Reprogramada",
          message: `Tu cita para ${serviceName} ha sido movida del ${oldDateStr} a las ${oldTime} al ${newDateStr} a las ${appointment.scheduledTime}.`,
          data: {
            appointmentId: appointment.id,
            serviceId: appointment.serviceId,
            serviceName,
            professionalId: appointment.professionalId,
            professionalName,
            oldDate: oldDate,
            oldTime: oldTime,
            newDate: appointment.scheduledDate,
            newTime: appointment.scheduledTime,
          },
        });
      }

      // 2. Notify the professional (in-app)
      if (appointment.professional && appointment.professional.userId) {
        await this.notificationsService.create({
          tenantId: appointment.tenantId,
          userId: appointment.professional.userId,
          type: NotificationType.APPOINTMENT_RESCHEDULED,
          title: "Cita Reprogramada",
          message: `La cita con ${clientName} ha sido movida del ${oldDateStr} a las ${oldTime} al ${newDateStr} a las ${appointment.scheduledTime}.`,
          data: {
            appointmentId: appointment.id,
            clientId: appointment.clientId,
            clientName,
            serviceId: appointment.serviceId,
            serviceName,
            oldDate: oldDate,
            oldTime: oldTime,
            newDate: appointment.scheduledDate,
            newTime: appointment.scheduledTime,
          },
        });
      }

      // 3. Notify admins
      const admins = await this.prisma.user.findMany({
        where: {
          tenantId: appointment.tenantId,
          role: "admin",
        },
      });

      for (const admin of admins) {
        if (
          appointment.professional &&
          admin.id === appointment.professional.userId
        ) {
          continue;
        }

        await this.notificationsService.create({
          tenantId: appointment.tenantId,
          userId: admin.id,
          type: NotificationType.APPOINTMENT_RESCHEDULED,
          title: "Cita Reprogramada",
          message: `La cita de ${clientName} con ${professionalName} ha sido movida del ${oldDateStr} a las ${oldTime} al ${newDateStr} a las ${appointment.scheduledTime}.`,
          data: {
            appointmentId: appointment.id,
            clientId: appointment.clientId,
            clientName,
            professionalId: appointment.professionalId,
            professionalName,
            serviceId: appointment.serviceId,
            serviceName,
            oldDate: oldDate,
            oldTime: oldTime,
            newDate: appointment.scheduledDate,
            newTime: appointment.scheduledTime,
          },
        });
      }

      this.logger.log(
        `Sent appointment rescheduled notifications for appointment ${appointment.id}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to send appointment rescheduled notifications: ${error.message}`,
      );
    }
  }

  /**
   * Send notifications when an appointment is marked as no-show
   * Notifies: Professional, Admin
   */
  private async sendAppointmentNoShowNotifications(appointment: any) {
    try {
      this.logger.log(
        `Sending appointment no-show notifications for appointment ${appointment.id}`,
      );

      const dateStr = new Date(appointment.scheduledDate).toLocaleDateString(
        "es-ES",
        {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        },
      );

      const clientName = appointment.client
        ? `${appointment.client.firstName} ${appointment.client.lastName}`.trim()
        : "Cliente";
      const professionalName = appointment.professional
        ? `${appointment.professional.firstName} ${appointment.professional.lastName}`.trim()
        : "Profesional";
      const serviceName = appointment.service?.name || "Servicio";

      // 1. Notify the professional (in-app)
      if (appointment.professional && appointment.professional.userId) {
        await this.notificationsService.create({
          tenantId: appointment.tenantId,
          userId: appointment.professional.userId,
          type: NotificationType.APPOINTMENT_NO_SHOW,
          title: "Cliente No Presentado",
          message: `${clientName} no se presentó a la cita de ${serviceName} el ${dateStr} a las ${appointment.scheduledTime}.`,
          data: {
            appointmentId: appointment.id,
            clientId: appointment.clientId,
            clientName,
            serviceId: appointment.serviceId,
            serviceName,
            date: appointment.scheduledDate,
            time: appointment.scheduledTime,
          },
        });
      }

      // 2. Notify admins
      const admins = await this.prisma.user.findMany({
        where: {
          tenantId: appointment.tenantId,
          role: "admin",
        },
      });

      for (const admin of admins) {
        if (
          appointment.professional &&
          admin.id === appointment.professional.userId
        ) {
          continue;
        }

        await this.notificationsService.create({
          tenantId: appointment.tenantId,
          userId: admin.id,
          type: NotificationType.APPOINTMENT_NO_SHOW,
          title: "Cliente No Presentado",
          message: `${clientName} no se presentó a la cita con ${professionalName} el ${dateStr} a las ${appointment.scheduledTime}.`,
          data: {
            appointmentId: appointment.id,
            clientId: appointment.clientId,
            clientName,
            professionalId: appointment.professionalId,
            professionalName,
            serviceId: appointment.serviceId,
            serviceName,
            date: appointment.scheduledDate,
            time: appointment.scheduledTime,
          },
        });
      }

      this.logger.log(
        `Sent appointment no-show notifications for appointment ${appointment.id}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to send appointment no-show notifications: ${error.message}`,
      );
    }
  }

  /**
   * Send notifications when an appointment is confirmed
   * Notifies: Client, Professional, Admin
   */
  private async sendAppointmentConfirmedNotifications(appointment: any) {
    try {
      this.logger.log(
        `Sending appointment confirmed notifications for appointment ${appointment.id}`,
      );

      const dateStr = new Date(appointment.scheduledDate).toLocaleDateString(
        "es-ES",
        {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        },
      );

      const clientName = appointment.client
        ? `${appointment.client.firstName} ${appointment.client.lastName}`.trim()
        : "Cliente";
      const professionalName = appointment.professional
        ? `${appointment.professional.firstName} ${appointment.professional.lastName}`.trim()
        : "Profesional";
      const serviceName = appointment.service?.name || "Servicio";
      const salonName = appointment.tenant?.name || "KiraRoom";

      // Check client notification preferences before sending
      const canSendEmail =
        appointment.clientId &&
        (await this.notificationsService.shouldSendNotification(
          appointment.clientId,
          "appointment_confirmed",
          "email",
        ));
      const canSendSms =
        appointment.clientId &&
        (await this.notificationsService.shouldSendNotification(
          appointment.clientId,
          "appointment_confirmed",
          "sms",
        ));

      // Send confirmation email to client
      if (appointment.client?.email && canSendEmail) {
        try {
          await this.emailService.sendAppointmentConfirmation({
            clientName,
            clientEmail: appointment.client.email,
            serviceName,
            professionalName,
            date: dateStr,
            time: appointment.scheduledTime,
            salonName,
          });
          this.logger.log(
            `Sent confirmation email to client ${appointment.clientId}`,
          );
        } catch (error) {
          this.logger.error(
            `Failed to send confirmation email: ${error.message}`,
          );
        }
      } else if (appointment.client?.email && !canSendEmail) {
        this.logger.log(
          `Skipping confirmation email to client ${appointment.clientId} due to preferences`,
        );
      }

      // Send confirmation SMS to client
      if (appointment.client?.phone && canSendSms) {
        try {
          // Like the email: failure comes back in the result, not as a throw.
          const sent: any = await this.smsService.sendAppointmentConfirmation({
            clientName,
            clientPhone: appointment.client.phone,
            serviceName,
            professionalName,
            date: dateStr,
            time: appointment.scheduledTime,
            salonName,
          });
          if (sent?.success === false) {
            this.logger.warn(
              `Confirmation SMS to client ${appointment.clientId} was not sent: ${sent.error}`,
            );
          } else {
            this.logger.log(`Sent confirmation SMS to client ${appointment.clientId}`);
          }
        } catch (error) {
          this.logger.error(
            `Failed to send confirmation SMS: ${error.message}`,
          );
        }
      } else if (appointment.client?.phone && !canSendSms) {
        this.logger.log(
          `Skipping confirmation SMS to client ${appointment.clientId} due to preferences`,
        );
      }

      // Send confirmation WhatsApp to client
      const canSendWhatsapp =
        appointment.clientId &&
        (await this.notificationsService.shouldSendNotification(
          appointment.clientId,
          "appointment_confirmed",
          "whatsapp",
        ));
      if (appointment.client?.phone && canSendWhatsapp) {
        try {
          // The salon's template first (the free text is refused outside
          // WhatsApp's 24-hour window).
          if (!(await this.sendWhatsAppViaSalon("confirmed", appointment))) {
            await this.whatsappService.sendAppointmentConfirmation({
              clientName,
              clientPhone: appointment.client.phone,
              serviceName,
              professionalName,
              date: dateStr,
              time: appointment.scheduledTime,
              salonName,
            });
          }
          this.logger.log(
            `Sent confirmation WhatsApp to client ${appointment.clientId}`,
          );
        } catch (error) {
          this.logger.error(
            `Failed to send confirmation WhatsApp: ${error.message}`,
          );
        }
      } else if (appointment.client?.phone && !canSendWhatsapp) {
        this.logger.log(
          `Skipping confirmation WhatsApp to client ${appointment.clientId} due to preferences`,
        );
      }

      // 1. Notify the client (in-app)
      if (appointment.client) {
        await this.notificationsService.create({
          tenantId: appointment.tenantId,
          clientId: appointment.clientId,
          type: NotificationType.APPOINTMENT_CONFIRMED,
          title: "Cita Confirmada",
          message: `Tu cita para ${serviceName} el ${dateStr} a las ${appointment.scheduledTime} ha sido confirmada.`,
          data: {
            appointmentId: appointment.id,
            serviceId: appointment.serviceId,
            serviceName,
            professionalId: appointment.professionalId,
            professionalName,
            date: appointment.scheduledDate,
            time: appointment.scheduledTime,
          },
        });
      }

      // 2. Notify the professional (in-app)
      if (appointment.professional && appointment.professional.userId) {
        await this.notificationsService.create({
          tenantId: appointment.tenantId,
          userId: appointment.professional.userId,
          type: NotificationType.APPOINTMENT_CONFIRMED,
          title: "Cita Confirmada",
          message: `La cita con ${clientName} para ${serviceName} el ${dateStr} a las ${appointment.scheduledTime} ha sido confirmada.`,
          data: {
            appointmentId: appointment.id,
            clientId: appointment.clientId,
            clientName,
            serviceId: appointment.serviceId,
            serviceName,
            date: appointment.scheduledDate,
            time: appointment.scheduledTime,
          },
        });
      }

      // 3. Notify admins
      const admins = await this.prisma.user.findMany({
        where: {
          tenantId: appointment.tenantId,
          role: "admin",
        },
      });

      for (const admin of admins) {
        if (
          appointment.professional &&
          admin.id === appointment.professional.userId
        ) {
          continue;
        }

        await this.notificationsService.create({
          tenantId: appointment.tenantId,
          userId: admin.id,
          type: NotificationType.APPOINTMENT_CONFIRMED,
          title: "Cita Confirmada",
          message: `La cita de ${clientName} con ${professionalName} el ${dateStr} a las ${appointment.scheduledTime} ha sido confirmada.`,
          data: {
            appointmentId: appointment.id,
            clientId: appointment.clientId,
            clientName,
            professionalId: appointment.professionalId,
            professionalName,
            serviceId: appointment.serviceId,
            serviceName,
            date: appointment.scheduledDate,
            time: appointment.scheduledTime,
          },
        });
      }

      this.logger.log(
        `Sent appointment confirmed notifications for appointment ${appointment.id}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to send appointment confirmed notifications: ${error.message}`,
      );
    }
  }
}
