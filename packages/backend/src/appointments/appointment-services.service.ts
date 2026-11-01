import { Injectable, NotFoundException, BadRequestException, ForbiddenException, ConflictException, Logger } from '@nestjs/common';
import { assertCanReschedule, salonDayAndTime } from './reschedule-check';
import { PrismaService } from '../common/prisma/prisma.service';
import { AppointmentStatus } from '@prisma/client';
import { AppointmentsService } from './appointments.service';
import { canTransition } from './appointment-status';
import { syncVisitTotals } from './visit-sync';
import {
  VISIT_ROW_ORDER,
  VISIT_ROW_SELECT,
  VisitRow,
  clockOf,
  isLiveRow,
  plannedCleanup,
  visitSchedule,
} from './visit-totals';
import { salonInstant } from './salon-time';
import { CreateAppointmentServiceDto, UpdateAppointmentServiceDto, AppointmentServiceFiltersDto, AppointmentServiceType, AppointmentServiceStatus } from './dto/appointment-services.dto';

/** Whoever calls a route of this controller: req.user. */
export interface ServiceRowCaller {
  id: string;
  role: string;
  tenantId: string;
}

@Injectable()
export class AppointmentServicesService {
  private readonly logger = new Logger(AppointmentServicesService.name);

  constructor(
    private prisma: PrismaService,
    // Optional only for the specs that build the service by hand; Nest
    // provides it from this module.
    private readonly appointments?: AppointmentsService,
  ) {}

  /** The caller's own professional record, or null when the account has none. */
  private async ownProfessionalId(user: ServiceRowCaller): Promise<string | null> {
    const own = await this.prisma.professional.findFirst({
      where: { userId: user.id, tenantId: user.tenantId },
      select: { id: true },
    });
    return own?.id ?? null;
  }

  /**
   * The rows a caller may see and act on, as a filter: always this salon's
   * (the tenant filter adds it too; said here so it does not rest on that
   * alone). A professional (role staff) only their own rows, as for
   * appointments (findAll / findOne): the services they perform, or, for a
   * row with nobody on it (a colour's processing time), those of an
   * appointment that is theirs. The same rule `update` applies. Per row and
   * not per appointment: in a visit shared by two professionals each starts,
   * completes or cancels their own service, and neither touches the
   * other's. Null for a staff account not linked to a professional: nothing.
   */
  private async visibleRows(user: ServiceRowCaller): Promise<Record<string, any> | null> {
    const where: Record<string, any> = { appointment: { tenantId: user.tenantId } };
    if (user.role !== 'staff') return where;
    const own = await this.ownProfessionalId(user);
    if (!own) return null;
    where.OR = [{ professionalId: own }, { professionalId: null, appointment: { professionalId: own } }];
    return where;
  }

  /**
   * The appointment new rows go into. A professional adds services only to
   * an appointment of their own, and only for themselves: a row on a
   * colleague's appointment would also open that visit and its client to
   * them.
   */
  private async appointmentForNewRows(
    user: ServiceRowCaller,
    appointmentId: string,
    professionalIds: Array<string | null | undefined>,
  ) {
    const appointment = await this.prisma.appointment.findFirst({
      where: { id: appointmentId, tenantId: user.tenantId },
    });
    if (!appointment) {
      throw new NotFoundException('Appointment not found');
    }
    if (user.role === 'staff') {
      const own = await this.ownProfessionalId(user);
      if (!own || appointment.professionalId !== own) {
        throw new NotFoundException('Appointment not found');
      }
      if (professionalIds.some((id) => !!id && id !== own)) {
        throw new ForbiddenException('Solo puedes añadir a tu cita servicios que haces tú.');
      }
    }
    return appointment;
  }

  async create(createDto: CreateAppointmentServiceDto, user: ServiceRowCaller) {
    // The appointment is this salon's and, for a professional, theirs.
    await this.appointmentForNewRows(user, createDto.appointmentId, [createDto.professionalId]);

    // Verify service exists
    const service = await this.prisma.service.findFirst({
      where: { id: createDto.serviceId, tenantId: user.tenantId },
    });

    if (!service) {
      throw new NotFoundException('Service not found');
    }

    // If professional is provided, verify they exist
    if (createDto.professionalId) {
      const professional = await this.prisma.professional.findFirst({
        where: { id: createDto.professionalId, tenantId: user.tenantId },
      });

      if (!professional) {
        throw new NotFoundException('Professional not found');
      }
    }

    // If no order provided, get the next order number for this appointment
    let order = createDto.order;
    if (order === undefined) {
      const lastService = await this.prisma.appointmentService.findFirst({
        where: { appointmentId: createDto.appointmentId, appointment: { tenantId: user.tenantId } },
        orderBy: { order: 'desc' },
      });
      order = lastService ? lastService.order + 1 : 0;
    }

    const appointmentService = await this.prisma.appointmentService.create({
      data: {
        appointmentId: createDto.appointmentId,
        serviceId: createDto.serviceId,
        professionalId: createDto.professionalId,
        scheduledStart: createDto.scheduledStart,
        scheduledEnd: createDto.scheduledEnd,
        type: createDto.type || AppointmentServiceType.active,
        isParallel: createDto.isParallel || false,
        order: order,
        status: AppointmentServiceStatus.pending,
        notes: createDto.notes,
      },
      include: {
        service: true,
        professional: true,
        appointment: true,
      },
    });

    // The visit is longer and costs more now (visit-sync.ts).
    await syncVisitTotals(this.prisma, createDto.appointmentId);

    this.logger.log(`Created appointment service ${appointmentService.id} for appointment ${createDto.appointmentId}`);
    return appointmentService;
  }

  async findAll(filters: AppointmentServiceFiltersDto, user: ServiceRowCaller) {
    const visible = await this.visibleRows(user);
    if (!visible) return [];
    const where: any = { ...visible };

    if (filters.appointmentId) {
      where.appointmentId = filters.appointmentId;
    }

    if (filters.professionalId) {
      where.professionalId = filters.professionalId;
    }

    if (filters.serviceId) {
      where.serviceId = filters.serviceId;
    }

    if (filters.type) {
      where.type = filters.type;
    }

    if (filters.status) {
      where.status = filters.status;
    }

    if (filters.startDate || filters.endDate) {
      where.scheduledStart = {};
      if (filters.startDate) {
        where.scheduledStart.gte = filters.startDate;
      }
      if (filters.endDate) {
        where.scheduledStart.lte = filters.endDate;
      }
    }

    const appointmentServices = await this.prisma.appointmentService.findMany({
      where,
      include: {
        service: true,
        professional: true,
        appointment: {
          include: {
            client: true,
          },
        },
      },
      orderBy: [
        { scheduledStart: 'asc' },
        { order: 'asc' },
      ],
    });

    return appointmentServices;
  }

  async findByAppointment(appointmentId: string, user: ServiceRowCaller) {
    const visible = await this.visibleRows(user);
    if (!visible) return [];
    const appointmentServices = await this.prisma.appointmentService.findMany({
      where: { ...visible, appointmentId },
      include: {
        service: true,
        professional: true,
      },
      orderBy: { order: 'asc' },
    });

    return appointmentServices;
  }

  /**
   * One row the caller may see (visibleRows). Every route that acts on a row
   * reads it through here first: a row that is not theirs is "not found".
   */
  async findOne(id: string, user: ServiceRowCaller) {
    const visible = await this.visibleRows(user);
    if (!visible) throw new NotFoundException('Appointment service not found');
    const appointmentService = await this.prisma.appointmentService.findFirst({
      where: { ...visible, id },
      include: {
        service: true,
        professional: true,
        appointment: {
          include: {
            client: true,
          },
        },
      },
    });

    if (!appointmentService) {
      throw new NotFoundException('Appointment service not found');
    }

    return appointmentService;
  }

  /**
   * The cleanup time ("tiempo de limpieza") the moved service brings along:
   * its service's, when the visit ends with it once it sits at `start`-`end`
   * (visit-totals.ts plannedCleanup); otherwise 0.
   */
  private cleanupIfLast(
    appointment: { professionalId: string; scheduledDate?: Date | null; scheduledTime?: string | null; services?: VisitRow[] | null },
    rowId: string,
    start: Date,
    end: Date,
    timeZone: string,
  ): number {
    const live = (appointment.services ?? []).filter(isLiveRow);
    const clock = appointment.scheduledTime ? clockOf(appointment.scheduledTime, timeZone) : null;
    if (live.length === 0 || !appointment.scheduledDate || !clock) return 0;
    const schedule = visitSchedule(salonInstant(appointment.scheduledDate, clock, timeZone), appointment.professionalId, live).map(
      (s) => (s.id === rowId ? { ...s, start, end } : s),
    );
    const cleanup = plannedCleanup(schedule, live);
    return cleanup.index !== -1 && schedule[cleanup.index].id === rowId ? cleanup.minutes : 0;
  }

  async update(
    id: string,
    updateDto: UpdateAppointmentServiceDto,
    user: ServiceRowCaller,
  ) {
    // Check it exists and the caller may change it
    await this.findOne(id, user);
    const current = await this.prisma.appointmentService.findFirst({
      where: { id, appointment: { tenantId: user.tenantId } },
      select: {
        professionalId: true,
        scheduledStart: true,
        scheduledEnd: true,
        appointment: {
          select: {
            id: true,
            tenantId: true,
            professionalId: true,
            scheduledDate: true,
            scheduledTime: true,
            tenant: { select: { timezone: true } },
            // The whole visit: is this the service it ends with (its cleanup)?
            services: { select: VISIT_ROW_SELECT, orderBy: VISIT_ROW_ORDER as any },
          },
        },
      },
    });
    if (!current) throw new NotFoundException('Appointment service not found');
    const rowProfessional = current.professionalId ?? current.appointment.professionalId;

    // A professional moves only their own services, within their own agenda.
    // This route let any member of the team change anyone's.
    if (user.role === 'staff') {
      const own = await this.prisma.professional.findFirst({
        where: { userId: user.id, tenantId: user.tenantId },
        select: { id: true },
      });
      if (!own || rowProfessional !== own.id) {
        throw new NotFoundException('No tienes permiso para modificar esta cita');
      }
      if (updateDto.professionalId && updateDto.professionalId !== own.id) {
        throw new ForbiddenException('Solo puedes mover tus citas dentro de tu agenda.');
      }
    }

    // Moving it (time or professional) must land on a free slot: the same
    // rule as moving a whole appointment (reschedule-check.ts).
    const start = updateDto.scheduledStart ? new Date(updateDto.scheduledStart) : current.scheduledStart;
    const end = updateDto.scheduledEnd ? new Date(updateDto.scheduledEnd) : current.scheduledEnd;
    const professionalId = updateDto.professionalId ?? rowProfessional;
    const moved =
      (start && current.scheduledStart ? start.getTime() !== current.scheduledStart.getTime() : !!updateDto.scheduledStart) ||
      (end && current.scheduledEnd ? end.getTime() !== current.scheduledEnd.getTime() : !!updateDto.scheduledEnd) ||
      professionalId !== rowProfessional;
    if (moved && start && end && professionalId) {
      if (end <= start) throw new BadRequestException('scheduledEnd must be after scheduledStart');
      const timeZone = current.appointment.tenant?.timezone || 'Europe/Madrid';
      const { day, time } = salonDayAndTime(start, timeZone);
      await assertCanReschedule(this.prisma as any, {
        tenantId: current.appointment.tenantId,
        appointmentId: current.appointment.id,
        professionalId,
        day,
        time,
        durationMinutes: Math.round((end.getTime() - start.getTime()) / 60000),
        cleanupMinutes: this.cleanupIfLast(current.appointment as any, id, start, end, timeZone),
      });
    }

    // If professional is being updated, verify they exist
    if (updateDto.professionalId) {
      const professional = await this.prisma.professional.findFirst({
        where: { id: updateDto.professionalId, tenantId: user.tenantId },
      });

      if (!professional) {
        throw new NotFoundException('Professional not found');
      }
    }

    const appointmentService = await this.prisma.appointmentService.update({
      where: { id, appointment: { tenantId: user.tenantId } },
      data: {
        professionalId: updateDto.professionalId,
        scheduledStart: updateDto.scheduledStart,
        scheduledEnd: updateDto.scheduledEnd,
        actualStart: updateDto.actualStart,
        actualEnd: updateDto.actualEnd,
        type: updateDto.type,
        isParallel: updateDto.isParallel,
        order: updateDto.order,
        status: updateDto.status,
        notes: updateDto.notes,
      },
      include: {
        service: true,
        professional: true,
        appointment: true,
      },
    });

    // Its time or length may have moved the visit's start or end.
    await syncVisitTotals(this.prisma, appointmentService.appointmentId);

    this.logger.log(`Updated appointment service ${id}`);
    return appointmentService;
  }

  async remove(id: string, user: ServiceRowCaller) {
    // Check it exists and the caller may remove it
    const row = await this.findOne(id, user);
    // A service already done is part of what the client is charged for.
    if (row.status === AppointmentServiceStatus.completed) {
      throw new ConflictException('Este servicio ya está completado: no se puede quitar de la cita.');
    }

    await this.prisma.appointmentService.delete({
      where: { id, appointment: { tenantId: user.tenantId } },
    });
    await syncVisitTotals(this.prisma, row.appointmentId);

    this.logger.log(`Deleted appointment service ${id}`);
    return { success: true };
  }

  async updateStatus(id: string, status: AppointmentServiceStatus, user: ServiceRowCaller) {
    // Only a row the caller may act on (visibleRows).
    await this.findOne(id, user);
    const appointmentService = await this.prisma.appointmentService.update({
      where: { id, appointment: { tenantId: user.tenantId } },
      data: { status },
      include: {
        service: true,
        professional: true,
      },
    });

    // A cancelled service leaves the visit: shorter, and not charged.
    if (status === AppointmentServiceStatus.cancelled) {
      await syncVisitTotals(this.prisma, appointmentService.appointmentId);
    }

    // If service is completed, check if all services for the appointment are done
    if (status === AppointmentServiceStatus.completed) {
      await this.checkAppointmentCompletion(appointmentService.appointmentId, user.tenantId);
    }

    this.logger.log(`Updated status of appointment service ${id} to ${status}`);
    return appointmentService;
  }

  async startService(id: string, user: ServiceRowCaller) {
    return this.updateStatus(id, AppointmentServiceStatus.active, user);
  }

  async completeService(id: string, user: ServiceRowCaller) {
    return this.updateStatus(id, AppointmentServiceStatus.completed, user);
  }

  async cancelService(id: string, user: ServiceRowCaller) {
    return this.updateStatus(id, AppointmentServiceStatus.cancelled, user);
  }

  private async checkAppointmentCompletion(appointmentId: string, tenantId: string) {
    const pendingServices = await this.prisma.appointmentService.count({
      where: {
        appointmentId,
        appointment: { tenantId },
        status: {
          notIn: [AppointmentServiceStatus.completed, AppointmentServiceStatus.cancelled],
        },
      },
    });

    if (pendingServices > 0) return;

    // Every service is done, so the visit is: completed by the same path as
    // the panel's "Completar" (notice, invoice, cadence, points). It used
    // to be a bare status write: no invoice, and a cancelled visit could
    // become completed. Only when the transition table allows it -- a
    // completed visit is not completed (and invoiced) twice.
    const appointment = await this.prisma.appointment.findFirst({
      where: { id: appointmentId, tenantId },
      select: { status: true, tenantId: true },
    });
    if (!appointment || !this.appointments) return;
    if (!canTransition(appointment.status, AppointmentStatus.completed)) return;
    try {
      await this.appointments.changeStatus(
        { role: 'system', tenantId: appointment.tenantId },
        appointmentId,
        AppointmentStatus.completed,
      );
      this.logger.log(`All services completed for appointment ${appointmentId}, marking appointment as completed`);
    } catch (err) {
      // Consent forms still unsigned, or the status changed meanwhile: the
      // service is done, the visit stays as it is for the team to finish.
      this.logger.warn(`appointment ${appointmentId} not completed with its services: ${(err as Error).message}`);
    }
  }

  // Bulk create services for an appointment (for multi-service bookings)
  async bulkCreate(appointmentId: string, services: CreateAppointmentServiceDto[], user: ServiceRowCaller) {
    // The appointment is this salon's and, for a professional, theirs; and a
    // professional adds only services they do.
    const appointment = await this.appointmentForNewRows(
      user,
      appointmentId,
      Array.isArray(services) ? services.map((s) => s?.professionalId) : [],
    );

    // The body is not validated item by item, and rows on this model are not
    // stamped with the tenant: another salon's service or professional id
    // linked it here and returned its record whole.
    if (!Array.isArray(services) || services.length === 0 || services.length > 20) {
      throw new BadRequestException('Between 1 and 20 services');
    }
    const serviceIds = [...new Set(services.map((s) => s?.serviceId))];
    const professionalIds = [...new Set(services.map((s) => s?.professionalId).filter((id): id is string => !!id))];
    const [ownServices, ownProfessionals] = await Promise.all([
      this.prisma.service.count({ where: { tenantId: appointment.tenantId, id: { in: serviceIds.filter((id): id is string => typeof id === 'string') } } }),
      professionalIds.length
        ? this.prisma.professional.count({ where: { tenantId: appointment.tenantId, id: { in: professionalIds } } })
        : Promise.resolve(0),
    ]);
    if (ownServices !== serviceIds.length || ownProfessionals !== professionalIds.length) {
      throw new NotFoundException('Service or professional not found');
    }

    // Create all services in a transaction
    const createdServices = await this.prisma.$transaction(
      services.map((service, index) =>
        this.prisma.appointmentService.create({
          data: {
            appointmentId,
            serviceId: service.serviceId,
            professionalId: service.professionalId,
            scheduledStart: service.scheduledStart,
            scheduledEnd: service.scheduledEnd,
            type: service.type || AppointmentServiceType.active,
            isParallel: service.isParallel || false,
            order: service.order ?? index,
            status: AppointmentServiceStatus.pending,
            notes: service.notes,
          },
          include: {
            service: true,
            professional: true,
          },
        }),
      ),
    );

    // The appointment covers the whole visit and charges for all of it.
    await syncVisitTotals(this.prisma, appointmentId);

    this.logger.log(`Created ${createdServices.length} appointment services for appointment ${appointmentId}`);
    return createdServices;
  }

  // Get services that need processing time decomposition
  async getServicesWithProcessingTime(appointmentId: string, user: ServiceRowCaller) {
    const visible = await this.visibleRows(user);
    if (!visible) return [];
    const services = await this.prisma.appointmentService.findMany({
      where: {
        ...visible,
        appointmentId,
        service: {
          hasProcessingTime: true,
        },
      },
      include: {
        service: true,
      },
    });

    return services;
  }

  // Create processing time blocks for a service
  async createProcessingBlocks(appointmentServiceId: string, user: ServiceRowCaller, processingDuration?: number) {
    const appointmentService = await this.findOne(appointmentServiceId, user);

    const service = await this.prisma.service.findFirst({
      where: { id: appointmentService.serviceId, tenantId: user.tenantId },
    });

    if (!service || !service.hasProcessingTime) {
      throw new BadRequestException('Service does not have processing time');
    }

    const processingMins = processingDuration || service.processingDuration || service.duration;
    
    // Calculate times
    const applicationEnd = appointmentService.scheduledEnd;
    const processingEnd = new Date(applicationEnd.getTime() + processingMins * 60000);

    // Create processing block (professional is free during this time).
    // Typed "processing": as "active" it was charged as a second service and
    // kept the professional busy (visit-totals.ts).
    const processingBlock = await this.prisma.appointmentService.create({
      data: {
        appointmentId: appointmentService.appointmentId,
        serviceId: appointmentService.serviceId,
        professionalId: null, // Professional is free during processing
        scheduledStart: applicationEnd,
        scheduledEnd: processingEnd,
        type: AppointmentServiceType.processing,
        isParallel: false,
      },
      include: {
        service: true,
      },
    });

    // Update original service to end when processing starts
    await this.prisma.appointmentService.update({
      where: { id: appointmentServiceId, appointment: { tenantId: user.tenantId } },
      data: {
        scheduledEnd: applicationEnd,
        type: AppointmentServiceType.active,
      },
    });

    await syncVisitTotals(this.prisma, appointmentService.appointmentId);

    this.logger.log(`Created processing block for appointment service ${appointmentServiceId}`);
    return processingBlock;
  }

  // Reordering a visit's services and switching one between serial and
  // parallel live in AppointmentsService (reorderVisitServices,
  // setVisitServiceMode): they move the visit, so they take the same checks
  // and writes as a drag. These versions wrote an ISO instant into the
  // appointment's "HH:MM" time and checked nothing.
}
