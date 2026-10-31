import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { deleteClientKeepingHistory } from '../../common/prisma/history-deletes';
import { CreateClientDto, UpdateClientDto } from './dto';
import { ClientStatus } from '@prisma/client';
import {
  CLIENT_APPOINTMENTS_LIMIT,
  CLIENT_APPOINTMENTS_SELECT,
  CLIENT_DETAIL_SELECT,
  CLIENT_LIST_SELECT,
} from '../../clients/client-select';
import {
  buildClientCreateData,
  buildClientUpdateData,
  rethrowClientWriteError,
} from '../../clients/client-write';

@Injectable()
export class AdminClientsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: string, createClientDto: CreateClientDto) {
    const data = buildClientCreateData(tenantId, {
      ...createClientDto,
      preferredLanguage: createClientDto.preferredLanguage || 'es',
    });
    try {
      return await this.prisma.client.create({ data, select: CLIENT_DETAIL_SELECT });
    } catch (error) {
      rethrowClientWriteError(error);
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
        select: {
          ...CLIENT_LIST_SELECT,
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
    const client = await this.prisma.client.findFirst({
      where: { id, tenantId },
      select: {
        ...CLIENT_DETAIL_SELECT,
        appointments: {
          select: CLIENT_APPOINTMENTS_SELECT,
          orderBy: [{ scheduledDate: 'desc' }, { scheduledTime: 'desc' }],
          take: CLIENT_APPOINTMENTS_LIMIT,
        },
      },
    });

    if (!client) {
      throw new NotFoundException('Cliente no encontrado');
    }

    return client;
  }

  async update(tenantId: string, id: string, updateClientDto: UpdateClientDto) {
    const current = await this.prisma.client.findFirst({
      where: { id, tenantId },
      select: { taxId: true, taxIdType: true },
    });
    if (!current) {
      throw new NotFoundException('Cliente no encontrado');
    }

    const data = buildClientUpdateData(updateClientDto, current);
    try {
      return await this.prisma.client.update({
        where: { id, tenantId },
        data,
        select: CLIENT_DETAIL_SELECT,
      });
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2025') {
        throw new NotFoundException('Cliente no encontrado');
      }
      rethrowClientWriteError(error);
    }
  }

  /** History survives the delete: see common/prisma/history-deletes.ts. */
  async remove(tenantId: string, id: string) {
    return deleteClientKeepingHistory(this.prisma, tenantId, id);
  }

  async search(tenantId: string, query: string) {
    return this.prisma.client.findMany({
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
      select: CLIENT_LIST_SELECT,
    });
  }
}
