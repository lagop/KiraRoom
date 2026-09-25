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

interface AppointmentActivity {
  action: string;
  details: any;
  userId?: string;
}

export interface CreateAppointmentDto {
  tenantId: string;
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

  async create(createAppointmentDto: CreateAppointmentDto) {
    let clientId = createAppointmentDto.clientId;
    let tenantId = createAppointmentDto.tenantId;

    // Find or create client if clientInfo provided
    if (!clientId && createAppointmentDto.clientInfo) {
      // First, try to find an existing client by email
      const existingClient = await this.prisma.client.findFirst({
        where: {
          email: createAppointmentDto.clientInfo.email,
        },
      });

      if (existingClient) {
        clientId = existingClient.id;
        tenantId = existingClient.tenantId;
      } else {
        // Create a new client if not found - get tenantId from professional
        const professional = await this.prisma.professional.findFirst({
          where: { id: createAppointmentDto.professionalId },
        });
        if (!professional) {
          throw new NotFoundException("Profesional no encontrado");
        }
        tenantId = professional.tenantId;

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

    // Verify client exists and get tenantId
    const client = await this.prisma.client.findFirst({
      where: { id: clientId },
    });
    if (!client) {
      throw new NotFoundException("Cliente no encontrado");
    }

    // Use the client's tenantId if not provided
    if (!tenantId || tenantId === "default") {
      tenantId = client.tenantId;
    }

    // Verify professional exists
    const professional = await this.prisma.professional.findFirst({
      where: { id: createAppointmentDto.professionalId, tenantId: tenantId },
    });
    if (!professional) {
      throw new NotFoundException("Profesional no encontrado");
    }

    // Verify service exists
    const service = await this.prisma.service.findFirst({
      where: { id: createAppointmentDto.serviceId, tenantId: tenantId },
    });
    if (!service) {
      throw new NotFoundException("Servicio no encontrado");
    }

    // Calculate end time
    const endTime = this.calculateEndTime(
      createAppointmentDto.scheduledTime,
      service.duration,
    );

    // Convert scheduledDate to Date if it's a string
    const scheduledDate =
      typeof createAppointmentDto.scheduledDate === "string"
        ? new Date(createAppointmentDto.scheduledDate)
        : createAppointmentDto.scheduledDate;

    // Create appointment
    const dto = createAppointmentDto as any;
    const appointment = await this.prisma.appointment.create({
      data: {
        tenantId: tenantId,
        clientId: clientId,
        serviceId: dto.serviceId,
        professionalId: dto.professionalId,
        scheduledDate: scheduledDate,
        scheduledTime: dto.scheduledTime,
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

    // Send notifications for appointment creation
    await this.sendAppointmentCreatedNotifications(appointment);

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
      { source: createAppointmentDto.source ?? 'dashboard' },
    );

    return appointment;
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

    // Call the regular create method
    return this.create(createAppointmentDto);
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

  async cancel(user: any, id: string, reason?: string) {
    const appointment = await this.findOne(user, id);

    if (appointment.status === AppointmentStatus.cancelled) {
      throw new BadRequestException("La cita ya está cancelada");
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

    // Validate all professionals exist
    if (professionalsToCheck.length > 0) {
      const professionals = await this.prisma.professional.findMany({
        where: {
          id: { in: professionalsToCheck },
          tenantId,
        },
      });

      if (professionals.length !== professionalsToCheck.length) {
        throw new NotFoundException("One or more professionals not found");
      }
    }

    // Get the service duration if specified
    let serviceDuration = duration;
    if (serviceId) {
      const service = await this.prisma.service.findFirst({
        where: { id: serviceId, tenantId },
      });

      if (!service) {
        throw new NotFoundException("Service not found");
      }

      serviceDuration = service.duration;
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
        // No specific professionals, check any conflicts
        isAvailable = !existingAppointments.some((appointment) => {
          const [appointmentHour, appointmentMinute] = appointment.scheduledTime
            .split(":")
            .map(Number);
          const [slotHour, slotMinute] = slot.time.split(":").map(Number);

          const appointmentStart = appointmentHour * 60 + appointmentMinute;
          const appointmentEnd = appointmentStart + appointment.duration;
          const slotStart = slotHour * 60 + slotMinute;
          const slotEnd = slotStart + serviceDuration;

          // Check if the slot overlaps with any existing appointment
          return !(appointmentEnd <= slotStart || appointmentStart >= slotEnd);
        });
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

    return availableSlots.filter((slot) => slot.isAvailable);
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
  private async sendAppointmentCreatedNotifications(appointment: any) {
    try {
      this.logger.log(
        `Sending appointment created notifications for appointment ${appointment.id}`,
      );
      this.logger.debug(
        `Appointment details: clientId=${appointment.clientId}, client=${JSON.stringify(appointment.client)}`,
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
            `Sent confirmation email to client ${appointment.client.email}`,
          );
        } catch (error) {
          this.logger.error(
            `Failed to send confirmation email: ${error.message}`,
          );
        }
      } else if (appointment.client?.email && !canSendEmail) {
        this.logger.log(
          `Skipping confirmation email to client ${appointment.client.email} due to preferences`,
        );
      }

      // Send confirmation SMS to client
      if (appointment.client?.phone && canSendSms) {
        try {
          await this.smsService.sendAppointmentConfirmation({
            clientName,
            clientPhone: appointment.client.phone,
            serviceName,
            professionalName,
            date: dateStr,
            time: appointment.scheduledTime,
            salonName,
          });
          this.logger.log(
            `Sent confirmation SMS to client ${appointment.client.phone}`,
          );
        } catch (error) {
          this.logger.error(
            `Failed to send confirmation SMS: ${error.message}`,
          );
        }
      } else if (appointment.client?.phone && !canSendSms) {
        this.logger.log(
          `Skipping confirmation SMS to client ${appointment.client.phone} due to preferences`,
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
            `Sent confirmation WhatsApp to client ${appointment.client.phone}`,
          );
        } catch (error) {
          this.logger.error(
            `Failed to send confirmation WhatsApp: ${error.message}`,
          );
        }
      } else if (appointment.client?.phone && !canSendWhatsapp) {
        this.logger.log(
          `Skipping confirmation WhatsApp to client ${appointment.client.phone} due to preferences`,
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
            `Sent cancellation email to client ${appointment.client.email}`,
          );
        } catch (error) {
          this.logger.error(
            `Failed to send cancellation email: ${error.message}`,
          );
        }
      } else if (appointment.client?.email && !canSendEmail) {
        this.logger.log(
          `Skipping cancellation email to client ${appointment.client.email} due to preferences`,
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
            `Sent cancellation SMS to client ${appointment.client.phone}`,
          );
        } catch (error) {
          this.logger.error(
            `Failed to send cancellation SMS: ${error.message}`,
          );
        }
      } else if (appointment.client?.phone && !canSendSms) {
        this.logger.log(
          `Skipping cancellation SMS to client ${appointment.client.phone} due to preferences`,
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
            `Sent cancellation WhatsApp to client ${appointment.client.phone}`,
          );
        } catch (error) {
          this.logger.error(
            `Failed to send cancellation WhatsApp: ${error.message}`,
          );
        }
      } else if (appointment.client?.phone && !canSendWhatsapp) {
        this.logger.log(
          `Skipping cancellation WhatsApp to client ${appointment.client.phone} due to preferences`,
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
            `Sent rescheduled email to client ${appointment.client.email}`,
          );
        } catch (error) {
          this.logger.error(
            `Failed to send rescheduled email: ${error.message}`,
          );
        }
      } else if (appointment.client?.email && !canSendEmail) {
        this.logger.log(
          `Skipping rescheduled email to client ${appointment.client.email} due to preferences`,
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
            `Sent rescheduled SMS to client ${appointment.client.phone}`,
          );
        } catch (error) {
          this.logger.error(`Failed to send rescheduled SMS: ${error.message}`);
        }
      } else if (appointment.client?.phone && !canSendSms) {
        this.logger.log(
          `Skipping rescheduled SMS to client ${appointment.client.phone} due to preferences`,
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
            `Sent rescheduled WhatsApp to client ${appointment.client.phone}`,
          );
        } catch (error) {
          this.logger.error(
            `Failed to send rescheduled WhatsApp: ${error.message}`,
          );
        }
      } else if (appointment.client?.phone && !canSendWhatsapp) {
        this.logger.log(
          `Skipping rescheduled WhatsApp to client ${appointment.client.phone} due to preferences`,
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
            `Sent confirmation email to client ${appointment.client.email}`,
          );
        } catch (error) {
          this.logger.error(
            `Failed to send confirmation email: ${error.message}`,
          );
        }
      } else if (appointment.client?.email && !canSendEmail) {
        this.logger.log(
          `Skipping confirmation email to client ${appointment.client.email} due to preferences`,
        );
      }

      // Send confirmation SMS to client
      if (appointment.client?.phone && canSendSms) {
        try {
          await this.smsService.sendAppointmentConfirmation({
            clientName,
            clientPhone: appointment.client.phone,
            serviceName,
            professionalName,
            date: dateStr,
            time: appointment.scheduledTime,
            salonName,
          });
          this.logger.log(
            `Sent confirmation SMS to client ${appointment.client.phone}`,
          );
        } catch (error) {
          this.logger.error(
            `Failed to send confirmation SMS: ${error.message}`,
          );
        }
      } else if (appointment.client?.phone && !canSendSms) {
        this.logger.log(
          `Skipping confirmation SMS to client ${appointment.client.phone} due to preferences`,
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
            `Sent confirmation WhatsApp to client ${appointment.client.phone}`,
          );
        } catch (error) {
          this.logger.error(
            `Failed to send confirmation WhatsApp: ${error.message}`,
          );
        }
      } else if (appointment.client?.phone && !canSendWhatsapp) {
        this.logger.log(
          `Skipping confirmation WhatsApp to client ${appointment.client.phone} due to preferences`,
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
