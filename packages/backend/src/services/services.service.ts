import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { deleteServiceKeepingHistory } from '../common/prisma/history-deletes';
import { CreateServiceDto, UpdateServiceDto } from './dto';

/** By category, then by name: the order the panel and the pickers list them. */
const SERVICE_ORDER = [{ category: 'asc' as const }, { name: 'asc' as const }];

/** What a client may book: active, and offered online. */
const PUBLIC_SERVICE_WHERE = { isActive: true, isOnlineBookable: true };

/** A service as anyone outside the salon sees it. */
export const PUBLIC_SERVICE_SELECT = {
  id: true,
  tenantId: true,
  name: true,
  description: true,
  category: true,
  duration: true,
  price: true,
  currency: true,
  isActive: true,
  isOnlineBookable: true,
} as const;

@Injectable()
export class ServicesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: string, createServiceDto: CreateServiceDto) {
    // `??`, not `||`: with `||` an explicit false fell through to the
    // default, so a service could never be created inactive or offline-only.
    return this.prisma.service.create({
      data: {
        tenantId,
        name: createServiceDto.name,
        description: createServiceDto.description,
        category: createServiceDto.category,
        duration: createServiceDto.duration,
        price: createServiceDto.price,
        currency: createServiceDto.currency || 'EUR',
        isActive: createServiceDto.isActive ?? true,
        requiresApproval: createServiceDto.requiresApproval ?? false,
        maxAdvanceBooking: createServiceDto.maxAdvanceBooking ?? 30,
        minAdvanceBooking: createServiceDto.minAdvanceBooking ?? 2,
        // Cleanup time after each appointment: none unless the salon sets it.
        bufferTime: createServiceDto.bufferTime ?? 0,
        isOnlineBookable: createServiceDto.isOnlineBookable ?? true,
        isMobile: createServiceDto.isMobile ?? false,
        depositRequired: createServiceDto.depositRequired ?? false,
        depositAmount: createServiceDto.depositAmount,
        depositPercentage: createServiceDto.depositPercentage,
      },
    });
  }

  /**
   * The salon's catalogue. Its own staff get every service, active or not,
   * in full; anyone else (the client portal, an anonymous caller) only what
   * can be booked online, in the public projection: no deposit settings, no
   * internal lists (staff, equipment, products...). See PublicViewerService.
   */
  async findAll(tenantId: string, viewer: { staff: boolean } = { staff: true }) {
    if (!viewer.staff) {
      return this.prisma.service.findMany({
        where: { tenantId, ...PUBLIC_SERVICE_WHERE },
        select: PUBLIC_SERVICE_SELECT,
        orderBy: SERVICE_ORDER,
      });
    }
    return this.prisma.service.findMany({
      where: { tenantId },
      orderBy: SERVICE_ORDER,
    });
  }

  /** One of the salon's services, in full; 404 for another salon's. */
  async findOne(tenantId: string, id: string) {
    const service = await this.prisma.service.findFirst({
      where: { id, tenantId },
    });

    if (!service) {
      throw new NotFoundException(`Service with ID ${id} not found`);
    }

    return service;
  }

  /** findOne for someone outside the salon, by findAll's public rules. */
  async findPublicOne(tenantId: string, id: string) {
    const service = await this.prisma.service.findFirst({
      where: { id, tenantId, ...PUBLIC_SERVICE_WHERE },
      select: PUBLIC_SERVICE_SELECT,
    });

    if (!service) {
      throw new NotFoundException(`Service with ID ${id} not found`);
    }

    return service;
  }

  async update(tenantId: string, id: string, updateServiceDto: UpdateServiceDto) {
    // Another salon's service is a 404, never an edit.
    await this.findOne(tenantId, id);

    return this.prisma.service.update({
      where: { id, tenantId },
      data: {
        name: updateServiceDto.name,
        description: updateServiceDto.description,
        category: updateServiceDto.category,
        duration: updateServiceDto.duration,
        price: updateServiceDto.price,
        currency: updateServiceDto.currency,
        isActive: updateServiceDto.isActive,
        requiresApproval: updateServiceDto.requiresApproval,
        maxAdvanceBooking: updateServiceDto.maxAdvanceBooking,
        minAdvanceBooking: updateServiceDto.minAdvanceBooking,
        bufferTime: updateServiceDto.bufferTime,
        isOnlineBookable: updateServiceDto.isOnlineBookable,
        isMobile: updateServiceDto.isMobile,
        depositRequired: updateServiceDto.depositRequired,
        depositAmount: updateServiceDto.depositAmount,
        depositPercentage: updateServiceDto.depositPercentage,
      },
    });
  }

  /** History survives the delete: see common/prisma/history-deletes.ts. */
  async remove(tenantId: string, id: string) {
    return deleteServiceKeepingHistory(this.prisma, tenantId, id);
  }
}
