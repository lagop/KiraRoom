import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  Logger,
  Optional,
} from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import {
  workingWindowFor,
  fitsInWindow,
  minutesOf,
} from "./working-hours";
import { ProductEventsService, PRODUCT_EVENTS } from "../common/telemetry/product-events.service";
import {
  AppointmentStatus,
  PaymentStatus,
  AppointmentSource,
} from "@prisma/client";
import { NotificationsService } from "../notifications/notifications.service";
import { ClientCadenceService } from "../rebooking/client-cadence.service";
import { WaitListService } from "../wait-list/wait-list.service";
import { InvoiceService } from "../invoices/invoices.service";
import { EmailService } from "../notifications/services/email.service";
import { SmsService } from "../notifications/services/sms.service";
import { WhatsAppService } from "../notifications/services/whatsapp.service";
import { NotificationType } from "../notifications/dto";
import { TranslationsService } from "../translations/translations.service";
import { ConsentService } from "../consent/consent.service";
import { salonInstant } from "./salon-time";
import type { OnlineBookingDto } from "./dto/book-appointment.dto";

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
    email: string;
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

export interface AuthenticatedUser {
  id: string;
  tenantId: string;
  role: string;
  professionalId?: string;
}

export interface UpdateAppointmentDto {
  serviceId?: string;
  professionalId?: string;
  scheduledDate?: string;
  scheduledTime?: string;
  notes?: string;
  status?: AppointmentStatus;
  cancellationReason?: string;
  addons?: Array<{
    addonId: string;
    quantity: number;
  }>;
  services?: Array<{
    serviceId: string;
    professionalId?: string | null;
    isParallel?: boolean;
  }>;
}

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

export interface PendingPaymentFiltersDto {
  searchQuery?: string;
  dateFrom?: string;
  dateTo?: string;
  status?: string;
}

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
  ) {}

  /**
   * Enrich appointment data with computed totalAmount (in cents) and amountDue.
   * The database totalAmount field is not set on creation, so we compute it from service price.
   */
  private enrichAppointment(apt: any): any {
    const servicePrice = Number(apt.service?.price || 0);
    const totalAmount = apt.totalAmount && Number(apt.totalAmount) > 0
      ? Number(apt.totalAmount)
      : Math.round(servicePrice * 100); // Convert dollars to cents
    const amountPaid = Number(apt.amountPaid || 0);
    return {
      ...apt,
      totalAmount,
      amountDue: Math.max(0, totalAmount - amountPaid),
    };
  }

  /**
   * A booking made from outside the salon: the public site, the widget, the
   * client portal. The route is @Public(), so nothing the caller sends about
   * the tenant can be trusted, and nothing stops a direct POST from asking
   * for 03:00, for yesterday, or for a slot already taken.
   *
   * - The salon is the chosen professional's -- or, for the widget's "any
   *   professional", the widget's.
   * - The start must be inside the service's booking window
   *   (minAdvanceBooking hours to maxAdvanceBooking days from now).
   * - The slot must be one getAvailableSlots offers: on the professional's
   *   shift, inside opening hours, and not overlapping another booking.
   * - Check and insert run under a per-salon, per-day advisory lock, so two
   *   concurrent requests for the same slot cannot both pass the check.
   *   Notifications are sent after the lock is released.
   */
  async createOnline(dto: OnlineBookingDto) {
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

    return this.bookOnline(tenantId, dto, widgetProfessionals);
  }

  /**
   * The online booking itself, for a salon the caller has already
   * established: createOnline (from the professional or the widget) and the
   * virtual receptionist (the salon it answers for). Window, availability,
   * lock and insert; notifications after the lock.
   *
   * `allowedProfessionals` limits "any professional" to a widget's list.
   */
  async bookOnline(
    tenantId: string,
    dto: OnlineBookingDto,
    allowedProfessionals: string[] = [],
  ) {
    const professionalId = dto.professionalId || undefined;
    const widgetProfessionals = allowedProfessionals;
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
        // sees it.
        return this.insertAppointment({ ...dto, professionalId: assigned }, tenantId);
      },
      { timeout: 15_000 },
    );

    const notified = await this.afterAppointmentCreated(appointment, dto.source);
    // Not a column: tells the chat receptionist whether it may say the
    // confirmation email was sent.
    return Object.assign(appointment, { confirmationEmailSent: notified?.emailSent === true });
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

  /** Validate and insert. No side effects beyond creating the client. */
  private async insertAppointment(createAppointmentDto: CreateAppointmentDto, tenantId: string) {
    if (!createAppointmentDto.professionalId) {
      throw new BadRequestException("Professional ID is required");
    }

    // Professional and service first: a booking that fails on them must not
    // leave a new client record behind.
    const professional = await this.prisma.professional.findFirst({
      where: { id: createAppointmentDto.professionalId, tenantId: tenantId },
    });
    if (!professional) {
      throw new NotFoundException("Profesional no encontrado");
    }

    const service = await this.prisma.service.findFirst({
      where: { id: createAppointmentDto.serviceId, tenantId: tenantId },
    });
    if (!service) {
      throw new NotFoundException("Servicio no encontrado");
    }

    let clientId = createAppointmentDto.clientId;

    // Find or create client if clientInfo provided
    if (!clientId && createAppointmentDto.clientInfo) {
      if (!createAppointmentDto.clientInfo.email) {
        // An undefined filter is dropped by Prisma: this would match the
        // salon's first client.
        throw new BadRequestException("Client email is required");
      }
      // Look the email up in THIS salon. Searching every salon meant a client
      // of salon A could not book on salon B's site: they were matched to
      // their salon-A record, the tenant switched to A, and B's professional
      // was then "not found".
      const existingClient = await this.prisma.client.findFirst({
        where: {
          email: createAppointmentDto.clientInfo.email,
          tenantId,
        },
      });

      if (existingClient) {
        clientId = existingClient.id;
      } else {
        const newClient = await this.prisma.client.create({
          data: {
            tenantId: tenantId,
            firstName: createAppointmentDto.clientInfo.firstName,
            lastName: createAppointmentDto.clientInfo.lastName,
            email: createAppointmentDto.clientInfo.email,
            phone: createAppointmentDto.clientInfo.phone || null,
            status: "active",
          },
        });
        clientId = newClient.id;
      }
    }

    if (!clientId) {
      throw new BadRequestException("Client ID is required");
    }

    // The client must belong to the same salon as the appointment.
    const client = await this.prisma.client.findFirst({
      where: { id: clientId, tenantId },
    });
    if (!client) {
      throw new NotFoundException("Cliente no encontrado");
    }

    // Calculate end time
    const endTime = this.calculateEndTime(
      createAppointmentDto.scheduledTime,
      service.duration,
    );

    const tenantRow = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { timezone: true },
    });

    // Convert scheduledDate to Date if it's a string
    const scheduledDate =
      typeof createAppointmentDto.scheduledDate === "string"
        ? new Date(createAppointmentDto.scheduledDate)
        : createAppointmentDto.scheduledDate;

    // Create appointment
    const dto = createAppointmentDto as any;
    return this.prisma.appointment.create({
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
        duration: service.duration,
        endTime: endTime,
        status: AppointmentStatus.pending,
        price: service.price,
        totalAmount: Math.round(Number(service.price) * 100), // Store in cents
        currency: service.currency,
        paymentStatus: PaymentStatus.pending,
        notes: dto.notes || null,
        source: (dto.source as AppointmentSource) || AppointmentSource.online,
        widgetInstanceId: dto.widgetInstanceId || null,
        // Commission rate can be set by admin/owner
        ...(dto.commissionRate !== undefined && {
          commissionRate: dto.commissionRate,
        }),
      },
      include: {
        client: true,
        professional: true,
        service: true,
        tenant: true,
      },
    });
  }

  /** Notifications, rebooking cleanup and telemetry for a new appointment. */
  private async afterAppointmentCreated(
    appointment: any,
    source?: string,
  ): Promise<{ emailSent: boolean }> {
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

  async createByStaff(
    createAppointmentDto: CreateAppointmentDto,
    user: AuthenticatedUser,
  ) {
    // Staff users can ALWAYS only create appointments for themselves
    if (user.role === "staff") {
      if (createAppointmentDto.professionalId !== user.professionalId) {
        throw new ForbiddenException(
          "Los profesionales solo pueden crear citas para sí mismos",
        );
      }
    }

    // The staff member's own salon, from the token.
    return this.create(createAppointmentDto, user.tenantId);
  }

  async findAll(user: any, filters?: AppointmentFiltersDto) {
    const where: any = {};

    // Aplicar filtro automático para usuarios STAFF - solo ven sus propias citas
    if (user.role === "staff") {
      const professional = await this.prisma.professional.findFirst({
        where: { userId: user.id, tenantId: user.tenantId },
        select: { id: true },
      });

      if (professional) {
        where.professionalId = professional.id;
        // Ignorar cualquier professionalId enviado por el cliente para evitar bypass
        filters.professionalId = professional.id;
      }
    }

    if (filters) {
      if (filters.tenantId) where.tenantId = filters.tenantId;
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
          where: { email: filters.clientEmail },
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

    const appointments = await (this.prisma.appointment.findMany as any)({
      where,
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
      orderBy: {
        scheduledDate: "asc",
      },
    });

    return appointments.map((apt: any) => this.enrichAppointment(apt));
  }

  async findOne(user: any, id: string) {
    const appointment = await (this.prisma.appointment.findUnique as any)({
      where: { id },
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

    return this.enrichAppointment(appointment);
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
    const oldStatus = appointment.status;

    // Parse scheduledDate to Date if provided
    const parsedDto = { ...updateAppointmentDto };
    if (parsedDto.scheduledDate) {
      const date = new Date(parsedDto.scheduledDate);
      if (isNaN(date.getTime())) {
        throw new BadRequestException("Invalid scheduledDate provided");
      }
      parsedDto.scheduledDate = date as any;
    }

    // Build update data including foreign keys
    const updateData: any = {
      ...parsedDto,
      updatedAt: new Date(),
    };

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

    // Update endTime if scheduledTime is provided
    if (updateAppointmentDto.scheduledTime) {
      updateData.endTime = this.calculateEndTime(
        updateAppointmentDto.scheduledTime,
        appointment.duration,
      );
    }

    // Update scheduledTime if provided
    if (updateAppointmentDto.scheduledTime) {
      updateData.scheduledTime = updateAppointmentDto.scheduledTime;
    }

    // A reschedule moves the instant the reminder jobs select on, and the
    // reminders already sent were for the old time.
    if (updateAppointmentDto.scheduledDate || updateAppointmentDto.scheduledTime) {
      const tenant = (appointment as any).tenant as { timezone?: string } | undefined;
      const newStart = salonInstant(
        updateData.scheduledDate ?? appointment.scheduledDate,
        updateData.scheduledTime ?? appointment.scheduledTime,
        tenant?.timezone || "Europe/Madrid",
      );
      const oldStart = (appointment as any).startTime as Date | null | undefined;
      // The drawer sends date and time on every full edit, so only a real move
      // re-arms the reminders: resetting on any edit re-sent ones already sent.
      if (!oldStart || new Date(oldStart).getTime() !== newStart.getTime()) {
        updateData.startTime = newStart;
        updateData.reminder24hSent = false;
        updateData.reminder1hSent = false;
      }
    }

    // Handle addons update if provided
    if (updateAppointmentDto.addons && updateAppointmentDto.addons.length > 0) {
      updateData.addons = {
        set: updateAppointmentDto.addons.map((addon) => ({
          addonId: addon.addonId,
          quantity: addon.quantity,
        })),
      };
    }

    // Handle services update for multi-service appointments
    if (
      updateAppointmentDto.services &&
      updateAppointmentDto.services.length > 0
    ) {
      // First, disconnect all existing services
      await this.prisma.appointmentService.deleteMany({
        where: { appointmentId: id },
      });

      // Then create new service records
      const serviceRecords = updateAppointmentDto.services.map((svc) => ({
        appointmentId: id,
        serviceId: svc.serviceId,
        professionalId: svc.professionalId || null,
        isParallel: svc.isParallel || false,
      }));

      await this.prisma.appointmentService.createMany({
        data: serviceRecords,
      });

      // Remove services from updateData as it's handled separately
      delete updateData.services;
    }

    try {
      // Get current appointment for activity logging
      const currentAppointment = await this.prisma.appointment.findUnique({
        where: { id },
        include: {
          client: true,
          professional: true,
          service: true,
          tenant: true,
        },
      });

      const updatedAppointment = await this.prisma.appointment.update({
        where: { id },
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
          },
        },
      });

      // Log activity for this update
      await this.logAppointmentActivity(id, "appointment_updated", user, {
        changes: updateData,
      });

      // Check if appointment was rescheduled (date or time changed)
      const isRescheduled =
        (updateAppointmentDto.scheduledDate &&
          new Date(updateAppointmentDto.scheduledDate).getTime() !==
            new Date(oldDate).getTime()) ||
        (updateAppointmentDto.scheduledTime &&
          updateAppointmentDto.scheduledTime !== oldTime);

      if (isRescheduled) {
        await this.sendAppointmentRescheduledNotifications(
          updatedAppointment,
          oldDate,
          oldTime,
        );
      }

      // Check if status changed to confirmed
      if (
        updateAppointmentDto.status === AppointmentStatus.confirmed &&
        oldStatus !== AppointmentStatus.confirmed
      ) {
        // P0 — Consent gate: if the tenant has active consent forms bound to
        // this service, ensure the client has signed them before confirming.
        if (this.consentService) {
          const ok = await this.consentService.hasValidConsent(
            appointment.tenantId,
            appointment.clientId,
            appointment.serviceId,
          );
          if (!ok) {
            const required =
              await this.consentService.getRequiredForms(
                appointment.tenantId,
                appointment.serviceId,
              );
            throw new ConflictException({
              code: "CONSENT_REQUIRED",
              message:
                "Client must sign required consent forms before confirming",
              appointmentId: id,
              requiredConsents: required.map((f) => ({
                id: f.id,
                name: f.name,
                version: f.version,
              })),
            });
          }
        }
        await this.sendAppointmentConfirmedNotifications(updatedAppointment);
      }

      return this.enrichAppointment(updatedAppointment);
    } catch (error) {
      console.error("Error updating appointment:", error);
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
    const appointment = await this.findOne(user, id);

    if (appointment.status === AppointmentStatus.cancelled) {
      throw new BadRequestException("La cita ya está cancelada");
    }

    // A client cancelling their own appointment is held to the salon's
    // minimum notice -- the same rule the virtual receptionist quotes. Staff
    // are not: the salon may always cancel.
    if (user.role === "client") {
      const tenant = (appointment as any).tenant as
        | { minCancelHours?: number; timezone?: string }
        | undefined;
      const minHours = tenant?.minCancelHours ?? 24;
      const startsAt = salonInstant(
        appointment.scheduledDate as any,
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

    const cancelledAppointment = await this.prisma.appointment.update({
      where: { id },
      data: {
        status: AppointmentStatus.cancelled,
        cancellationReason: reason || null,
        updatedAt: new Date(),
      },
      include: {
        client: true,
        professional: true,
        service: true,
        tenant: true,
      },
    });

    // Log cancellation activity
    await this.logAppointmentActivity(id, "appointment_cancelled", user, {
      reason: reason,
    });

    // Send cancellation notifications
    await this.sendAppointmentCancelledNotifications(
      cancelledAppointment,
      reason,
    );

    // P2A-receptionist-v2 H-1: free the slot by notifying any
    // wait-listed clients whose window covers the freed time.
    // Fire-and-forget; the wait-list service persists the notification
    // marker so a future re-cancel doesn't spam the same waiter.
    if (
      cancelledAppointment.serviceId &&
      cancelledAppointment.professionalId
    ) {
      void this.waitListService?.notifyMatchesForCancelledSlot({
          tenantId: cancelledAppointment.tenantId,
          serviceId: cancelledAppointment.serviceId,
          professionalId: cancelledAppointment.professionalId,
          windowStart: cancelledAppointment.scheduledDate,
          windowEnd: new Date(
            (cancelledAppointment.scheduledDate?.getTime?.() ?? Date.now()) +
              24 * 60 * 60 * 1000,
          ),
        })?.catch((err) =>
          this.logger.warn(
            `wait-list notification failed for cancelled appointment ${cancelledAppointment.id}: ${err.message}`,
          ),
        );
    }

    return this.enrichAppointment(cancelledAppointment);
  }

  async complete(user: any, id: string, notes?: string) {
    const appointment = await this.findOne(user, id);

    if (appointment.status === AppointmentStatus.cancelled) {
      throw new BadRequestException("No se puede completar una cita cancelada");
    }

    const completedAppointment = await this.prisma.appointment.update({
      where: { id },
      data: {
        status: AppointmentStatus.completed,
        notes: notes || appointment.notes,
        updatedAt: new Date(),
      },
      include: {
        client: true,
        professional: true,
        service: true,
        tenant: true,
      },
    });

    // Log completion activity
    await this.logAppointmentActivity(id, "appointment_completed", user, {
      notes: notes,
    });

    // Send notifications for appointment completion
    await this.sendAppointmentCompletedNotifications(completedAppointment);

    // P1.4 — Recompute cadence for this client after the visit completes.
    if (this.clientCadenceService) {
      this.clientCadenceService
        .computeForClient(completedAppointment.clientId)
        .catch((err) => {
          this.logger.warn(
            `computeForClient failed for client ${completedAppointment.clientId}: ${(err as Error).message}`,
          );
        });
    }

    // P2A — Auto-invoice the appointment if the tenant has opted in.
    if (this.invoiceService) {
      this.invoiceService
        .fromAppointment(completedAppointment.id)
        .catch((err) => {
          this.logger.warn(
            `auto-invoice from appointment failed for ${completedAppointment.id}: ${(err as Error).message}`,
          );
        });
    }

    return this.enrichAppointment(completedAppointment);
  }

  async markNoShow(user: any, id: string) {
    const appointment = await this.findOne(user, id);

    if (appointment.status === AppointmentStatus.cancelled) {
      throw new BadRequestException(
        "No se puede marcar como no presentado una cita cancelada",
      );
    }

    const noShowAppointment = await this.prisma.appointment.update({
      where: { id },
      data: {
        status: AppointmentStatus.no_show,
        updatedAt: new Date(),
      },
      include: {
        client: true,
        professional: true,
        service: true,
        tenant: true,
      },
    });

    // Log no-show activity
    await this.logAppointmentActivity(id, "appointment_no_show", user, {});

    // Send no-show notifications
    await this.sendAppointmentNoShowNotifications(noShowAppointment);

    return this.enrichAppointment(noShowAppointment);
  }

  async findPendingPayment(
    user: any,
    filters: PendingPaymentFiltersDto,
  ) {
    const where: any = {};

    // Apply user role filtering
    if (user.role === "staff") {
      const professional = await this.prisma.professional.findFirst({
        where: { userId: user.id, tenantId: user.tenantId },
        select: { id: true },
      });

      if (professional) {
        where.professionalId = professional.id;
      }
    }

    // Apply search query (client name or appointment ID)
    if (filters.searchQuery) {
      const client = await this.prisma.client.findFirst({
        where: {
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

    // Apply date range filter
    if (filters.dateFrom || filters.dateTo) {
      where.scheduledDate = {};
      if (filters.dateFrom) {
        where.scheduledDate.gte = new Date(filters.dateFrom);
      }
      if (filters.dateTo) {
        where.scheduledDate.lte = new Date(filters.dateTo);
      }
    }

    // Apply status filter
    if (filters.status) {
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
    });

    return appointments.map((apt: any) => this.enrichAppointment(apt));
  }

  async updatePaymentStatus(
    user: any,
    id: string,
    data: { status: string; amountPaid: number; paymentMethod: string },
  ) {
    const appointment = await this.findOne(user, id);

    const updatedAppointment = await this.prisma.appointment.update({
      where: { id },
      data: {
        paymentStatus: data.status as PaymentStatus,
        amountPaid: data.amountPaid,
        paymentMethod: data.paymentMethod,
        updatedAt: new Date(),
      },
      include: {
        client: true,
        professional: true,
        service: true,
        tenant: true,
      },
    });

    return this.enrichAppointment(updatedAppointment);
  }

  async remove(user: any, id: string) {
    const appointment = await this.findOne(user, id);
    await this.prisma.appointment.delete({
      where: { id },
    });
  }

  async getAppointmentActivity(user: any, appointmentId: string) {
    // Validar que el usuario tenga acceso a esta cita
    await this.findOne(user, appointmentId);

    return this.prisma.appointmentActivity.findMany({
      where: { appointmentId },
      orderBy: { createdAt: "desc" },
    });
  }

  private calculateEndTime(startTime: string, durationMinutes: number): string {
    const [hoursStr, minutesStr] = startTime.split(":");
    const hours = parseInt(hoursStr);
    const minutes = parseInt(minutesStr);

    const startDateTime = new Date();
    startDateTime.setHours(hours, minutes, 0, 0);

    const endDateTime = new Date(
      startDateTime.getTime() + durationMinutes * 60000,
    );
    return endDateTime.toTimeString().slice(0, 5); // HH:MM format
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
    let serviceRow: { isActive: boolean; minAdvanceBooking: number | null; maxAdvanceBooking: number | null } | null = null;
    if (serviceId) {
      const service = await this.prisma.service.findFirst({
        where: { id: serviceId, tenantId },
      });

      if (!service) {
        throw new NotFoundException("Service not found");
      }

      serviceDuration = service.duration;
      serviceRow = service as any;
    }

    // Generate time slots for the day using the tenant's configured
    // working hours. Previously this was hardcoded 9:00–18:00, which
    // made the suggestion engine miss every appointment past 17:30
    // regardless of the salon's actual closing time.
    const openingHours = (tenant.openingHours as { open?: string; close?: string }) ?? {};
    const timeSlots = this.generateTimeSlots(
      openingHours.open ?? "09:00",
      openingHours.close ?? "20:00",
      30,
    );

    // Get existing appointments for the date and professionals
    // Use date range to avoid timezone issues with date comparison
    const dateString = date.toISOString().split('T')[0];
    const startOfDay = new Date(dateString + 'T00:00:00.000Z');
    const endOfDay = new Date(dateString + 'T23:59:59.999Z');

    const existingAppointments = await this.prisma.appointment.findMany({
      where: {
        tenantId,
        scheduledDate: {
          gte: startOfDay,
          lte: endOfDay,
        },
        ...(professionalsToCheck.length > 0
          ? { professionalId: { in: professionalsToCheck } }
          : {}),
        status: { not: AppointmentStatus.cancelled },
      },
    });

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
          const row = professionalRows.find((p) => p.id === profId);
          const window = workingWindowFor(row?.workingHours, date);
          const slotMinutes = minutesOf(slot.time);

          if (window === null) {
            // Has a schedule and does not work this weekday.
            isAvailable = false;
            break;
          }
          if (
            window &&
            slotMinutes !== null &&
            !fitsInWindow(slotMinutes, serviceDuration, window)
          ) {
            isAvailable = false;
            break;
          }

          const profAppointments = existingAppointments.filter(
            (apt) => apt.professionalId === profId,
          );

          const hasConflict = profAppointments.some((appointment) => {
            const [appointmentHour, appointmentMinute] =
              appointment.scheduledTime.split(":").map(Number);
            const [slotHour, slotMinute] = slot.time.split(":").map(Number);

            const appointmentStart = appointmentHour * 60 + appointmentMinute;
            const appointmentEnd = appointmentStart + appointment.duration;
            const slotStart = slotHour * 60 + slotMinute;
            const slotEnd = slotStart + serviceDuration;

            // Check if the slot overlaps with this professional's appointment
            return !(
              appointmentEnd <= slotStart || appointmentStart >= slotEnd
            );
          });

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
        const overlaps = (appointment: { scheduledTime: string; duration: number }) => {
          const [appointmentHour, appointmentMinute] = appointment.scheduledTime
            .split(":")
            .map(Number);
          const [slotHour, slotMinute] = slot.time.split(":").map(Number);
          const appointmentStart = appointmentHour * 60 + appointmentMinute;
          const appointmentEnd = appointmentStart + appointment.duration;
          const slotStart = slotHour * 60 + slotMinute;
          const slotEnd = slotStart + serviceDuration;
          return !(appointmentEnd <= slotStart || appointmentStart >= slotEnd);
        };

        if (anyProfessionalRows.length === 0) {
          // No professionals recorded at all: impose no shift limit, and the
          // salon is free when nothing overlaps.
          isAvailable = !existingAppointments.some(overlaps);
        } else {
          // Somebody who is on shift for the whole slot AND has nothing of
          // their own overlapping it. This used to ask "is anyone on shift"
          // and then "does ANY appointment overlap" -- so one stylist's 11:00
          // took 10:30 away from the four who were free.
          isAvailable = anyProfessionalRows.some((p) => {
            const window = workingWindowFor(p.workingHours, date);
            if (window === null) return false;
            if (
              window &&
              !(slotMinutes !== null && fitsInWindow(slotMinutes, serviceDuration, window))
            ) {
              return false;
            }
            return !existingAppointments.some(
              (appointment) => appointment.professionalId === p.id && overlaps(appointment),
            );
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

    if (serviceRow && serviceRow.isActive === false) return [];
    const window = {
      timeZone: (tenant as any).timezone || "Europe/Madrid",
      minHours: serviceRow?.minAdvanceBooking ?? 0,
      maxHours: serviceRow ? (serviceRow.maxAdvanceBooking ?? 30) * 24 : Infinity,
    };
    const now = Date.now();
    return free.filter((slot) => this.fitsOnlineWindow(dateString, slot.time, window, now) === "ok");
  }

  /**
   * Generate candidate half-hour slots from `open` to `close` for a
   * given salon. Defaults to 09:00–20:00, 30-minute increments.
   *
   * The previous version was hardcoded to 09:00–18:00, which made the
   * suggestion engine return nothing past 17:30 regardless of the
   * tenant's configured `openingHours` (or the dashboard's
   * `salonHours.close`).
   */
  private generateTimeSlots(
    open: string = "09:00",
    close: string = "20:00",
    incrementMinutes: number = 30,
  ): { time: string }[] {
    const slots: { time: string }[] = [];
    let startMinutes = this.parseHhmmToMinutes(open);
    let endMinutes = this.parseHhmmToMinutes(close);
    if (!Number.isFinite(startMinutes) || startMinutes < 0) startMinutes = 9 * 60;
    if (!Number.isFinite(endMinutes) || endMinutes <= startMinutes) {
      endMinutes = startMinutes + 11 * 60; // 11h window fallback
    }

    // Inclusive of the last slot that still has room for a 30-min
    // appointment so the user never sees a suggestion that would be
    // pruned by duration-overlap downstream.
    const lastStartMinute = endMinutes - incrementMinutes;

    for (let minute = startMinutes; minute <= lastStartMinute; minute += incrementMinutes) {
      const hh = Math.floor(minute / 60).toString().padStart(2, "0");
      const mm = (minute % 60).toString().padStart(2, "0");
      slots.push({ time: `${hh}:${mm}` });
    }

    return slots;
  }

  private parseHhmmToMinutes(value: string): number {
    const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
    if (!m) return Number.NaN;
    const hh = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    if (hh < 0 || hh > 24 || mm < 0 || mm >= 60) return Number.NaN;
    return hh * 60 + mm;
  }

  /**
   * Send notifications when an appointment is created
   * Notifies: Client, Professional, Admin
   */
  private async sendAppointmentCreatedNotifications(
    appointment: any,
  ): Promise<{ emailSent: boolean }> {
    // Whether the client's confirmation email actually went out. The chat
    // receptionist said "te hemos enviado la confirmación" either way.
    let emailSent = false;
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
      if (appointment.client?.phone && canSendWhatsapp) {
        try {
          await this.whatsappService.sendAppointmentConfirmation({
            clientName,
            clientPhone: appointment.client.phone,
            serviceName,
            professionalName,
            date: dateStr,
            time: appointment.scheduledTime,
            salonName,
          });
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
    return { emailSent };
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
          await this.whatsappService.sendAppointmentConfirmation({
            clientName,
            clientPhone: appointment.client.phone,
            serviceName,
            professionalName,
            date: dateStr,
            time: appointment.scheduledTime,
            salonName,
          });
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
