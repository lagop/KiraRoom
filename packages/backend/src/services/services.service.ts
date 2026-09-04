import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateServiceDto, UpdateServiceDto } from './dto';

@Injectable()
export class ServicesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(createServiceDto: CreateServiceDto) {
    return this.prisma.service.create({
      data: {
        tenantId: createServiceDto.tenantId,
        name: createServiceDto.name,
        description: createServiceDto.description,
        category: createServiceDto.category as any,
        duration: createServiceDto.duration,
        price: createServiceDto.price,
        currency: createServiceDto.currency || 'EUR',
        isActive: createServiceDto.isActive || true,
        requiresApproval: createServiceDto.requiresApproval || false,
        maxAdvanceBooking: createServiceDto.maxAdvanceBooking || 30,
        minAdvanceBooking: createServiceDto.minAdvanceBooking || 2,
        bufferTime: createServiceDto.bufferTime || 15,
        isOnlineBookable: createServiceDto.isOnlineBookable || true,
        isMobile: createServiceDto.isMobile || false,
        depositRequired: createServiceDto.depositRequired || false,
        depositAmount: createServiceDto.depositAmount,
        depositPercentage: createServiceDto.depositPercentage,
      },
    });
  }

  async findAll(tenantId?: string) {
    return this.prisma.service.findMany({
      where: tenantId ? { tenantId } : {},
    });
  }

  async findOne(id: string) {
    const service = await this.prisma.service.findUnique({
      where: { id },
    });

    if (!service) {
      throw new NotFoundException(`Service with ID ${id} not found`);
    }

    return service;
  }

  async update(id: string, updateServiceDto: UpdateServiceDto) {
    const service = await this.prisma.service.findUnique({
      where: { id },
    });

    if (!service) {
      throw new NotFoundException(`Service with ID ${id} not found`);
    }

    return this.prisma.service.update({
      where: { id },
      data: {
        name: updateServiceDto.name,
        description: updateServiceDto.description,
        category: updateServiceDto.category as any,
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

  async remove(id: string) {
    const service = await this.prisma.service.findUnique({
      where: { id },
    });

    if (!service) {
      throw new NotFoundException(`Service with ID ${id} not found`);
    }

    return this.prisma.service.delete({
      where: { id },
    });
  }
}
