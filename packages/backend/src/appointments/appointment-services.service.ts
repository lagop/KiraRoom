import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateAppointmentServiceDto, UpdateAppointmentServiceDto, AppointmentServiceFiltersDto, AppointmentServiceType, AppointmentServiceStatus } from './dto/appointment-services.dto';

@Injectable()
export class AppointmentServicesService {
  private readonly logger = new Logger(AppointmentServicesService.name);

  constructor(private prisma: PrismaService) {}

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

  async update(id: string, updateDto: UpdateAppointmentServiceDto) {
    // Check if exists
    await this.findOne(id);

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

    this.logger.log(`Updated appointment service ${id}`);
    return appointmentService;
  }

  async remove(id: string) {
    // Check if exists
    await this.findOne(id);

    await this.prisma.appointmentService.delete({
      where: { id },
    });

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

    if (pendingServices === 0) {
      // All services completed, update appointment
      await this.prisma.appointment.update({
        where: { id: appointmentId },
        data: {
          status: 'completed',
          completionTime: new Date(),
        },
      });
      this.logger.log(`All services completed for appointment ${appointmentId}, marking appointment as completed`);
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

    // Create processing block (professional is free during this time)
    const processingBlock = await this.prisma.appointmentService.create({
      data: {
        appointmentId: appointmentService.appointmentId,
        serviceId: appointmentService.serviceId,
        professionalId: null, // Professional is free during processing
        scheduledStart: applicationEnd,
        scheduledEnd: processingEnd,
        type: AppointmentServiceType.active,
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

    this.logger.log(`Created processing block for appointment service ${appointmentServiceId}`);
    return processingBlock;
  }

  // Reorder services for an appointment
  async reorderServices(appointmentId: string, serviceOrders: Array<{ serviceId: string; order: number }>) {
    // Verify appointment exists
    const appointment = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
    });

    if (!appointment) {
      throw new NotFoundException('Appointment not found');
    }

    // Get all services for this appointment
    const services = await this.prisma.appointmentService.findMany({
      where: { appointmentId },
      orderBy: { order: 'asc' },
    });

    if (services.length === 0) {
      throw new BadRequestException('No services found for this appointment');
    }

    // Create a map of serviceId to new order
    const orderMap = new Map(serviceOrders.map(so => [so.serviceId, so.order]));

    // Update each service's order
    const updatedServices = await this.prisma.$transaction(
      services.map(service => {
        const newOrder = orderMap.get(service.serviceId);
        if (newOrder === undefined) {
          throw new BadRequestException(`Service ${service.serviceId} not found in reorder request`);
        }
        return this.prisma.appointmentService.update({
          where: { id: service.id },
          data: { order: newOrder },
          include: {
            service: true,
            professional: true,
          },
        });
      }),
    );

    // Update appointment's scheduledTime to match the first service's scheduledStart
    const firstService = updatedServices[0];
    if (firstService && firstService.scheduledStart) {
      await this.prisma.appointment.update({
        where: { id: appointmentId },
        data: {
          scheduledTime: firstService.scheduledStart.toISOString(),
        },
      });
      this.logger.log(`Updated appointment ${appointmentId} scheduledTime to ${firstService.scheduledStart}`);
    }

    this.logger.log(`Reordered ${updatedServices.length} services for appointment ${appointmentId}`);
    return updatedServices;
  }

  // Update timing for a specific service
  async updateTiming(id: string, scheduledStart: Date, scheduledEnd: Date) {
    const appointmentService = await this.findOne(id);

    // Validate times
    if (scheduledEnd <= scheduledStart) {
      throw new BadRequestException('scheduledEnd must be after scheduledStart');
    }

    // Update the service timing
    const updatedService = await this.prisma.appointmentService.update({
      where: { id },
      data: {
        scheduledStart,
        scheduledEnd,
      },
      include: {
        service: true,
        professional: true,
        appointment: true,
      },
    });

    // If this is a serial service, cascade the update to subsequent services
    if (!updatedService.isParallel) {
      await this.cascadeTimingUpdate(updatedService.appointmentId, id, scheduledEnd);
    }

    // Update appointment's scheduledTime to match the first service's scheduledStart
    const allServices = await this.prisma.appointmentService.findMany({
      where: { appointmentId: updatedService.appointmentId },
      orderBy: { order: 'asc' },
    });
    const firstService = allServices[0];
    if (firstService && firstService.scheduledStart) {
      await this.prisma.appointment.update({
        where: { id: updatedService.appointmentId },
        data: {
          scheduledTime: firstService.scheduledStart.toISOString(),
        },
      });
      this.logger.log(`Updated appointment ${updatedService.appointmentId} scheduledTime to ${firstService.scheduledStart}`);
    }

    this.logger.log(`Updated timing for appointment service ${id}`);
    return updatedService;
  }

  // Cascade timing update to subsequent serial services
  private async cascadeTimingUpdate(appointmentId: string, currentServiceId: string, newEndTime: Date) {
    // Get all services for this appointment, ordered by order
    const services = await this.prisma.appointmentService.findMany({
      where: { appointmentId },
      orderBy: { order: 'asc' },
      include: {
        service: true,
      },
    });

    // Find the current service index
    const currentIndex = services.findIndex(s => s.id === currentServiceId);
    if (currentIndex === -1) {
      return;
    }

    // Update subsequent serial services
    let currentTime = newEndTime;
    for (let i = currentIndex + 1; i < services.length; i++) {
      const service = services[i];
      
      // Skip parallel services - they don't affect timing
      if (service.isParallel) {
        continue;
      }

      // Calculate new end time based on service duration
      const duration = service.service?.duration || 0;
      const newStartTime = currentTime;
      const newEndTime = new Date(currentTime.getTime() + duration * 60000);

      // Update the service
      await this.prisma.appointmentService.update({
        where: { id: service.id },
        data: {
          scheduledStart: newStartTime,
          scheduledEnd: newEndTime,
        },
      });

      currentTime = newEndTime;
    }
  }

  // Toggle parallel/serial mode for a service
  async toggleMode(id: string, isParallel: boolean) {
    const appointmentService = await this.findOne(id);

    // Update the mode
    const updatedService = await this.prisma.appointmentService.update({
      where: { id },
      data: { isParallel },
      include: {
        service: true,
        professional: true,
        appointment: true,
      },
    });

    // If toggling to serial, we may need to adjust timing
    if (!isParallel) {
      // Get all services for this appointment
      const services = await this.prisma.appointmentService.findMany({
        where: { appointmentId: updatedService.appointmentId },
        orderBy: { order: 'asc' },
        include: {
          service: true,
        },
      });

      // Find the previous serial service
      const currentIndex = services.findIndex(s => s.id === id);
      let previousSerialEndTime: Date | null = null;

      for (let i = currentIndex - 1; i >= 0; i--) {
        if (!services[i].isParallel) {
          previousSerialEndTime = services[i].scheduledEnd;
          break;
        }
      }

      // If there's a previous serial service, adjust this service's start time
      if (previousSerialEndTime) {
        const duration = updatedService.service?.duration || 0;
        const newStartTime = previousSerialEndTime;
        const newEndTime = new Date(previousSerialEndTime.getTime() + duration * 60000);

        await this.prisma.appointmentService.update({
          where: { id },
          data: {
            scheduledStart: newStartTime,
            scheduledEnd: newEndTime,
          },
        });

        // Cascade the timing update to subsequent services
        await this.cascadeTimingUpdate(updatedService.appointmentId, id, newEndTime);
      }
    }

    // Update the appointment's scheduledTime to match the first service's scheduledStart
    const allServices = await this.prisma.appointmentService.findMany({
      where: { appointmentId: updatedService.appointmentId },
      orderBy: { order: 'asc' },
    });

    if (allServices.length > 0) {
      const firstService = allServices[0];
      await this.prisma.appointment.update({
        where: { id: updatedService.appointmentId },
        data: { scheduledTime: firstService.scheduledStart.toISOString() },
      });
    }

    this.logger.log(`Toggled mode for appointment service ${id} to ${isParallel ? 'parallel' : 'serial'}`);
    return updatedService;
  }
}
