import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateClientDto, UpdateClientDto } from './dto';
import { Client, ClientStatus } from '@prisma/client';

@Injectable()
export class AdminClientsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(createClientDto: CreateClientDto) {
    try {
      const client = await this.prisma.client.create({
        data: {
          tenantId: createClientDto.tenantId,
          firstName: createClientDto.firstName,
          lastName: createClientDto.lastName,
          email: createClientDto.email,
          phone: createClientDto.phone,
          dateOfBirth: createClientDto.dateOfBirth,
          gender: createClientDto.gender,
          status: createClientDto.status || ClientStatus.active,
          preferredLanguage: createClientDto.preferredLanguage || 'es',
          notes: createClientDto.notes,
          allergies: createClientDto.allergies,
          medicalConditions: createClientDto.medicalConditions,
          tags: createClientDto.tags,
        },
      });
      return client;
    } catch (error) {
      if (error.code === 'P2002') {
        throw new BadRequestException('Client with this email already exists');
      }
      throw new BadRequestException('Failed to create client');
    }
  }

  async findAll({ tenantId, page = 1, limit = 10, search = '', status }: { tenantId: string; page: number; limit: number; search: string; status?: string }) {
    const where: any = {
      tenantId,
      OR: [
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
      ],
    };

    if (status) {
      where.status = status as ClientStatus;
    }

    const [clients, total] = await Promise.all([
      this.prisma.client.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        // Only the counter: `include: { appointments: true }` dragged every
        // historical appointment of every row into a paginated list.
        include: {
          _count: { select: { appointments: true } },
        },
      }),
      this.prisma.client.count({ where }),
    ]);

    return {
      data: clients,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findOne(tenantId: string, id: string) {
    const client = await this.prisma.client.findUnique({
      where: { id, tenantId },
      include: {
        appointments: {
          include: {
            service: true,
            professional: true,
          },
        },
      },
    });

    if (!client) {
      throw new NotFoundException('Client not found');
    }

    return client;
  }

  async update(tenantId: string, id: string, updateClientDto: UpdateClientDto) {
    try {
      // Convert dateOfBirth string to proper DateTime format for Prisma
      const data: any = {
        firstName: updateClientDto.firstName,
        lastName: updateClientDto.lastName,
        email: updateClientDto.email,
        phone: updateClientDto.phone,
        dateOfBirth: updateClientDto.dateOfBirth ? new Date(updateClientDto.dateOfBirth) : undefined,
        gender: updateClientDto.gender,
        status: updateClientDto.status,
        preferredLanguage: updateClientDto.preferredLanguage,
        notes: updateClientDto.notes,
        allergies: updateClientDto.allergies,
        medicalConditions: updateClientDto.medicalConditions,
        tags: updateClientDto.tags,
      };
      
      const client = await this.prisma.client.update({
        where: { id, tenantId },
        data,
      });
      return client;
    } catch (error) {
      if (error.code === 'P2025') {
        throw new NotFoundException('Client not found');
      }
      if (error.code === 'P2002') {
        throw new BadRequestException('Client with this email already exists');
      }
      throw new BadRequestException('Failed to update client');
    }
  }

  async remove(tenantId: string, id: string) {
    try {
      return await this.prisma.client.delete({
        where: { id, tenantId },
      });
    } catch (error) {
      if (error.code === 'P2025') {
        throw new NotFoundException('Client not found');
      }
      throw new BadRequestException('Failed to delete client');
    }
  }

  async search(tenantId: string, query: string) {
    const clients = await this.prisma.client.findMany({
      where: {
        tenantId,
        OR: [
          { firstName: { contains: query, mode: 'insensitive' } },
          { lastName: { contains: query, mode: 'insensitive' } },
          { email: { contains: query, mode: 'insensitive' } },
          { phone: { contains: query, mode: 'insensitive' } },
        ],
      },
      take: 10,
      orderBy: { lastName: 'asc' },
    });

    return clients;
  }
}