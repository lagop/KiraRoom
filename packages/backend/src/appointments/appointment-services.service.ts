import { Injectable, NotFoundException, BadRequestException, ForbiddenException, ConflictException, Logger } from '@nestjs/common';
import { assertCanReschedule, salonDayAndTime } from './reschedule-check';
import { PrismaService } from '../common/prisma/prisma.service';
import { AppointmentStatus } from '@prisma/client';
import { AppointmentsService } from './appointments.service';
import { canTransition } from './appointment-status';
import { syncVisitTotals } from './visit-sync';
import { CreateAppointmentServiceDto, UpdateAppointmentServiceDto, AppointmentServiceFiltersDto, AppointmentServiceType, AppointmentServiceStatus } from './dto/appointment-services.dto';

@Injectable()
export class AppointmentServicesService {
  private readonly logger = new Logger(AppointmentServicesService.name);

  constructor(
    private prisma: PrismaService,
    // Optional only for the specs that build the service by hand; Nest
    // provides it from this module.
    private readonly appointments?: AppointmentsService,
  ) {}

  async create(createDto: CreateAppointmentServiceDto) {
    // Verify appointment exists
    const appointment = await this.prisma.appointment.findUnique({
      where: { id: createDto.appointmentId },
    });

    if (!appointment) {
      throw new NotFoundException('Appointment not found');
    }

    // Verify service exists
    const service = await this.prisma.service.findUnique({
      where: { id: createDto.serviceId },
    });

    if (!service) {
      throw new NotFoundException('Service not found');
    }

    // If professional is provided, verify they exist
    if (createDto.professionalId) {
      const professional = await this.prisma.professional.findUnique({
        where: { id: createDto.professionalId },
      });

      if (!professional) {
        throw new NotFoundException('Professional not found');
      }
    }

    // If no order provided, get the next order number for this appointment
    let order = createDto.order;
    if (order === undefined) {
      const lastService = await this.prisma.appointmentService.findFirst({
        where: { appointmentId: createDto.appointmentId },
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

  async findAll(filters: AppointmentServiceFiltersDto) {
    const where: any = {};

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

  async findByAppointment(appointmentId: string) {
    const appointmentServices = await this.prisma.appointmentService.findMany({
      where: { appointmentId },
      include: {
        service: true,
        professional: true,
      },
      orderBy: { order: 'asc' },
    });

    return appointmentServices;
  }

  async findOne(id: string) {
    const appointmentService = await this.prisma.appointmentService.findUnique({
      where: { id },
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

  async update(
    id: string,
    updateDto: UpdateAppointmentServiceDto,
    user?: { id: string; role: string; tenantId: string },
  ) {
    // Check if exists
    await this.findOne(id);
    const current = await this.prisma.appointmentService.findUnique({
      where: { id },
      select: {
        professionalId: true,
        scheduledStart: true,
        scheduledEnd: true,
        appointment: {
          select: { id: true, tenantId: true, professionalId: true, tenant: { select: { timezone: true } } },
        },
      },
    });
    if (!current) throw new NotFoundException('Appointment service not found');
    const rowProfessional = current.professionalId ?? current.appointment.professionalId;

    // A professional moves only their own services, within their own agenda.
    // This route let any member of the team change anyone's.
    if (user?.role === 'staff') {
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
      const { day, time } = salonDayAndTime(start, current.appointment.tenant?.timezone || 'Europe/Madrid');
      await assertCanReschedule(this.prisma as any, {
        tenantId: current.appointment.tenantId,
        appointmentId: current.appointment.id,
        professionalId,
        day,
        time,
        durationMinutes: Math.round((end.getTime() - start.getTime()) / 60000),
      });
    }

    // If professional is being updated, verify they exist
    if (updateDto.professionalId) {
      const professional = await this.prisma.professional.findUnique({
        where: { id: updateDto.professionalId },
      });

      if (!professional) {
        throw new NotFoundException('Professional not found');
      }
    }

    const appointmentService = await this.prisma.appointmentService.update({
      where: { id },
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

  async remove(id: string) {
    // Check if exists
    const row = await this.findOne(id);
    // A service already done is part of what the client is charged for.
    if (row.status === AppointmentServiceStatus.completed) {
      throw new ConflictException('Este servicio ya está completado: no se puede quitar de la cita.');
    }

    await this.prisma.appointmentService.delete({
      where: { id },
    });
    await syncVisitTotals(this.prisma, row.appointmentId);

    this.logger.log(`Deleted appointment service ${id}`);
    return { success: true };
  }

  async updateStatus(id: string, status: AppointmentServiceStatus) {
    const appointmentService = await this.prisma.appointmentService.update({
      where: { id },
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
      await this.checkAppointmentCompletion(appointmentService.appointmentId);
    }

    this.logger.log(`Updated status of appointment service ${id} to ${status}`);
    return appointmentService;
  }

  async startService(id: string) {
    return this.updateStatus(id, AppointmentServiceStatus.active);
  }

  async completeService(id: string) {
    return this.updateStatus(id, AppointmentServiceStatus.completed);
  }

  async cancelService(id: string) {
    return this.updateStatus(id, AppointmentServiceStatus.cancelled);
  }

  private async checkAppointmentCompletion(appointmentId: string) {
    const pendingServices = await this.prisma.appointmentService.count({
      where: {
        appointmentId,
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
    const appointment = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
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
  async bulkCreate(appointmentId: string, services: CreateAppointmentServiceDto[]) {
    // Verify appointment exists
    const appointment = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
    });

    if (!appointment) {
      throw new NotFoundException('Appointment not found');
    }

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
  async getServicesWithProcessingTime(appointmentId: string) {
    const services = await this.prisma.appointmentService.findMany({
      where: {
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
  async createProcessingBlocks(appointmentServiceId: string, processingDuration?: number) {
    const appointmentService = await this.findOne(appointmentServiceId);
    
    const service = await this.prisma.service.findUnique({
      where: { id: appointmentService.serviceId },
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
      where: { id: appointmentServiceId },
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
