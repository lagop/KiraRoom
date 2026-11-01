import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { deleteServiceKeepingHistory } from '../common/prisma/history-deletes';
import { CreateServiceDto, UpdateServiceDto } from './dto';
import { publicPrice, publicPriceSettings, PublicPriceSettings } from '../common/public-price';

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

/**
 * The public projection with the price a client pays: tax included, as a
 * number (36.3 for a 30.00 net service at 21 %), and `taxLabel` naming the
 * tax it includes. The salon's own staff get the catalogue price as entered.
 * Bookings never take a price from here: the server prices them from the
 * catalogue.
 */
function withPublicPrice<T extends { price: unknown }>(
  service: T,
  prices: PublicPriceSettings,
): Omit<T, 'price'> & { price: number; taxLabel: string } {
  return { ...service, price: publicPrice(service.price, prices), taxLabel: prices.taxLabel };
}

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
        bufferTime: createServiceDto.bufferTime ?? 15,
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
      const [services, prices] = await Promise.all([
        this.prisma.service.findMany({
          where: { tenantId, ...PUBLIC_SERVICE_WHERE },
          select: PUBLIC_SERVICE_SELECT,
          orderBy: SERVICE_ORDER,
        }),
        this.publicPrices(tenantId),
      ]);
      return services.map((s) => withPublicPrice(s, prices));
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
    const [service, prices] = await Promise.all([
      this.prisma.service.findFirst({
        where: { id, tenantId, ...PUBLIC_SERVICE_WHERE },
        select: PUBLIC_SERVICE_SELECT,
      }),
      this.publicPrices(tenantId),
    ]);

    if (!service) {
      throw new NotFoundException(`Service with ID ${id} not found`);
    }

    return withPublicPrice(service, prices);
  }

  /** How this salon's catalogue prices become what clients pay (common/public-price.ts). */
  private async publicPrices(tenantId: string): Promise<PublicPriceSettings> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { fiscalSettings: true },
    });
    return publicPriceSettings(tenant?.fiscalSettings);
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
