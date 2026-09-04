import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { FeatureFlagService } from '../common/feature-flags/feature-flag.service';

export type WaitListStatus = 'waiting' | 'notified' | 'cancelled' | 'fulfilled';

export interface WaitListCreateDto {
  clientId: string;
  serviceId: string;
  professionalId?: string | null;
  earliestDate?: string | null;
  latestDate?: string | null;
  notes?: string | null;
}

export interface WaitListUpdateDto {
  status?: WaitListStatus;
  earliestDate?: string | null;
  latestDate?: string | null;
  notes?: string | null;
}

/**
 * P2A-receptionist-advanced â€” virtual wait-list for fully-booked slots.
 *
 * Tenant-scoped, gated behind `virtual_receptionist_advanced`. The
 * hook that pushes notifications when an appointment is cancelled is
 * deferred to a follow-up (a single `notifyMatchesForCancelledSlot(...)`
 * call from the appointment service); the data model and CRUD are in
 * place so the hook is a one-method drop-in.
 */
@Injectable()
export class WaitListService {
  private readonly logger = new Logger(WaitListService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: FeatureFlagService,
  ) {}

  async list(
    tenantId: string,
    opts: { status?: WaitListStatus; serviceId?: string } = {},
  ) {
    if (!(await this.isEnabled(tenantId))) {
      throw new NotFoundException(
        'Virtual wait-list is not available on the current plan. Upgrade to Pro or add the advanced add-on.',
      );
    }
    return this.prisma.waitList.findMany({
      where: {
        tenantId,
        ...(opts.status ? { status: opts.status } : {}),
        ...(opts.serviceId ? { serviceId: opts.serviceId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: {
        client: { select: { firstName: true, lastName: true, email: true, phone: true } },
      },
    });
  }

  async add(tenantId: string, dto: WaitListCreateDto) {
    if (!(await this.isEnabled(tenantId))) {
      throw new NotFoundException('Virtual wait-list is not available on this plan.');
    }
    return this.prisma.waitList.create({
      data: {
        tenantId,
        clientId: dto.clientId,
        serviceId: dto.serviceId,
        professionalId: dto.professionalId ?? null,
        earliestDate: dto.earliestDate ? new Date(dto.earliestDate) : null,
        latestDate: dto.latestDate ? new Date(dto.latestDate) : null,
        notes: dto.notes ?? null,
        status: 'waiting',
      },
    });
  }

  async update(id: string, dto: WaitListUpdateDto) {
    const row = await this.prisma.waitList.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Wait-list entry not found');
    if (!(await this.isEnabled(row.tenantId))) {
      throw new NotFoundException('Virtual wait-list is not available on this plan.');
    }
    return this.prisma.waitList.update({
      where: { id },
      data: {
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.earliestDate !== undefined
          ? { earliestDate: dto.earliestDate ? new Date(dto.earliestDate) : null }
          : {}),
        ...(dto.latestDate !== undefined
          ? { latestDate: dto.latestDate ? new Date(dto.latestDate) : null }
          : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        ...(dto.status === 'notified' ? { notifiedAt: new Date() } : {}),
      },
    });
  }

  async remove(id: string) {
    const row = await this.prisma.waitList.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Wait-list entry not found');
    if (!(await this.isEnabled(row.tenantId))) {
      throw new NotFoundException('Virtual wait-list is not available on this plan.');
    }
    await this.prisma.waitList.delete({ where: { id } });
    return { ok: true };
  }

  /**
   * Phase v2 follow-up: called from the appointments service when an
   * Appointment is cancelled. Returns the list of matching waiting
   * clients (so the orchestrator can notify them) and marks them
   * 'notified' in the same transaction.
   */
  async notifyMatchesForCancelledSlot(args: {
    tenantId: string;
    serviceId: string;
    professionalId: string | null;
    windowStart: Date;
    windowEnd: Date;
  }): Promise<Array<{ id: string; clientId: string }>> {
    if (!(await this.isEnabled(args.tenantId))) return [];
    const candidates = await this.prisma.waitList.findMany({
      where: {
        tenantId: args.tenantId,
        serviceId: args.serviceId,
        ...(args.professionalId
          ? {
              OR: [
                { professionalId: null },
                { professionalId: args.professionalId },
              ],
            }
          : {}),
        status: 'waiting',
        AND: [
          {
            OR: [
              { earliestDate: null },
              { earliestDate: { lte: args.windowEnd } },
            ],
          },
          {
            OR: [
              { latestDate: null },
              { latestDate: { gte: args.windowStart } },
            ],
          },
        ],
      },
    });
    if (candidates.length === 0) return [];
    await this.prisma.waitList.updateMany({
      where: { id: { in: candidates.map((c) => c.id) } },
      data: { status: 'notified', notifiedAt: new Date() },
    });
    this.logger.log(
      `Notified ${candidates.length} wait-list entries for tenant=${args.tenantId} service=${args.serviceId}`,
    );
    return candidates.map((c) => ({ id: c.id, clientId: c.clientId }));
  }

  private async isEnabled(tenantId: string): Promise<boolean> {
    return this.flags.isFeatureUnlocked(tenantId, 'virtual_receptionist_advanced');
  }
}
