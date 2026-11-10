import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { deleteServiceKeepingHistory } from '../common/prisma/history-deletes';
import { CreateServiceDto, UpdateServiceDto } from './dto';
import { publicPrice, publicPriceSettings, PublicPriceSettings } from '../common/public-price';
import { PlatformStripeConfigService } from '../platform/platform-stripe-config.service';
import { onlinePaymentSettingsProblem } from '../payments/online-payment-policy';
import { onlinePaymentContextFor, withOnlinePayment } from '../payments/online-payment-context';

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
  // Not shown as such: turned into `onlinePayment` (what the client may pay now).
  depositRequired: true,
  depositAmount: true,
  depositPercentage: true,
  allowPrepay: true,
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

/** The deposit settings as stored, whatever shape the caller or the row holds them in. */
type DepositSettings = {
  price?: unknown;
  depositRequired?: boolean | null;
  depositAmount?: unknown;
  depositPercentage?: unknown;
  allowPrepay?: boolean | null;
};

@Injectable()
export class ServicesService {
  constructor(
    private readonly prisma: PrismaService,
    // Whether the platform's Stripe keys are set, and their mode: a salon's
    // connected account only counts for the mode it was created in.
    @Optional() private readonly platformStripe?: PlatformStripeConfigService,
  ) {}

  /** 400 with the reason when a service's online-payment settings make no sense. */
  private assertPaymentSettings(s: DepositSettings) {
    const problem = onlinePaymentSettingsProblem({
      price: Number(s.price ?? 0),
      depositRequired: s.depositRequired,
      depositAmount: s.depositAmount as number | string | null | undefined,
      depositPercentage: s.depositPercentage as number | string | null | undefined,
      allowPrepay: s.allowPrepay,
    });
    if (problem) throw new BadRequestException(problem);
  }

  async create(tenantId: string, createServiceDto: CreateServiceDto) {
    this.assertPaymentSettings(createServiceDto);
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
        allowPrepay: createServiceDto.allowPrepay ?? false,
      },
    });
  }

  /**
   * The salon's catalogue. Its own staff get every service, active or not,
   * in full; anyone else (the client portal, an anonymous caller) only what
   * can be booked online, in the public projection: what she may pay online
   * (not the deposit settings themselves), no internal lists (staff, equipment, products...). See PublicViewerService.
   */
  async findAll(tenantId: string, viewer: { staff: boolean } = { staff: true }) {
    if (!viewer.staff) {
      const [services, prices, payment] = await Promise.all([
        this.prisma.service.findMany({
          where: { tenantId, ...PUBLIC_SERVICE_WHERE },
          select: PUBLIC_SERVICE_SELECT,
          orderBy: SERVICE_ORDER,
        }),
        this.publicPrices(tenantId),
        this.onlinePaymentContext(tenantId),
      ]);
      return services.map((s) => withOnlinePayment(withPublicPrice(s, prices), payment));
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
    const [service, prices, payment] = await Promise.all([
      this.prisma.service.findFirst({
        where: { id, tenantId, ...PUBLIC_SERVICE_WHERE },
        select: PUBLIC_SERVICE_SELECT,
      }),
      this.publicPrices(tenantId),
      this.onlinePaymentContext(tenantId),
    ]);

    if (!service) {
      throw new NotFoundException(`Service with ID ${id} not found`);
    }

    return withOnlinePayment(withPublicPrice(service, prices), payment);
  }

  private onlinePaymentContext(tenantId: string) {
    return onlinePaymentContextFor(this.prisma, this.platformStripe, tenantId);
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
    const existing = await this.findOne(tenantId, id);
    // The settings as they will be once saved: what was sent over what is stored.
    const sent = <K extends keyof DepositSettings>(key: K) =>
      (updateServiceDto as DepositSettings)[key] !== undefined ? (updateServiceDto as DepositSettings)[key] : (existing as DepositSettings)[key];
    this.assertPaymentSettings({
      price: sent('price'),
      depositRequired: sent('depositRequired') as boolean | null,
      depositAmount: sent('depositAmount'),
      depositPercentage: sent('depositPercentage'),
      allowPrepay: sent('allowPrepay') as boolean | null,
    });

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
        allowPrepay: updateServiceDto.allowPrepay,
      },
    });
  }

  /** History survives the delete: see common/prisma/history-deletes.ts. */
  async remove(tenantId: string, id: string) {
    return deleteServiceKeepingHistory(this.prisma, tenantId, id);
  }
}
