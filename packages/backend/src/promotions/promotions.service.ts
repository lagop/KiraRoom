import { Injectable, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { usablePromotionWhere } from '../email-campaigns/campaign-content';
import { safeTimeZone } from '../gift-cards/gift-card-expiry';
import { CreatePromotionDto, UpdatePromotionDto } from './dto/promotion.dto';
import { normalizePromotionCode, promotionProblem, type TillPromotion } from './promotion-at-till';

export { CreatePromotionDto, UpdatePromotionDto };

/** A percentage over 100 would pay the client to come. */
function assertValue(type: string, value: number | undefined) {
  if (type === 'PERCENTAGE' && value !== undefined && value !== null && Number(value) > 100) {
    throw new BadRequestException('Un descuento en porcentaje no puede pasar del 100 %.');
  }
}

/**
 * The salon's promotions (Promociones). A code is used at the till only
 * (pos.service.ts with promotions/promotion-at-till.ts): there is no
 * endpoint here that records a use or changes a price.
 */
@Injectable()
export class PromotionsService {
  constructor(private prisma: PrismaService) {}

  /** The services a promotion is limited to: each one of this salon's (400 otherwise). */
  private async serviceIds(tenantId: string, ids: string[] | null | undefined): Promise<string[]> {
    const unique = [...new Set(ids ?? [])];
    if (unique.length === 0) return [];
    const found = await this.prisma.service.count({ where: { tenantId, id: { in: unique } } });
    if (found !== unique.length) throw new BadRequestException('Alguno de los servicios elegidos no es de tu salón.');
    return unique;
  }

  /**
   * Create a new promotion
   */
  async create(tenantId: string, dto: CreatePromotionDto) {
    assertValue(dto.type, dto.value);
    const code = normalizePromotionCode(dto.code);

    // The code is the salon's for good: an archived promotion keeps its own.
    const existing = await this.prisma.promotion.findFirst({
      where: { tenantId, code },
      select: { archivedAt: true },
    });
    if (existing) {
      throw new BadRequestException(
        existing.archivedAt
          ? 'Ese código ya se usó en una promoción que eliminaste: elige otro.'
          : 'Ya tienes una promoción con ese código.',
      );
    }
    const applicableServiceIds = await this.serviceIds(tenantId, dto.applicableServiceIds);

    return this.prisma.promotion.create({
      data: {
        tenantId,
        name: dto.name,
        description: dto.description,
        code,
        type: dto.type,
        value: dto.value,
        minOrderValue: dto.minOrderValue || 0,
        maxUses: dto.maxUses,
        maxUsesPerClient: dto.maxUsesPerClient,
        startDate: new Date(dto.startDate),
        endDate: dto.endDate ? new Date(dto.endDate) : null,
        isActive: true,
        applicableServiceIds,
      },
    });
  }

  /**
   * The salon's promotions, without the archived ones (deleted after use).
   */
  async getAll(tenantId: string) {
    return this.prisma.promotion.findMany({
      where: { tenantId, archivedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * The promotions a re-engagement campaign can link: active and not past
   * their end date (a code the salon no longer honours must not be offered).
   */
  async getUsable(tenantId: string) {
    return this.prisma.promotion.findMany({
      where: { tenantId, archivedAt: null, ...usablePromotionWhere() },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Get single promotion
   */
  async getOne(id: string, tenantId: string) {
    const promotion = await this.prisma.promotion.findFirst({
      where: { id, tenantId },
    });

    if (!promotion) {
      throw new NotFoundException('Promoción no encontrada');
    }

    return promotion;
  }

  /**
   * Update promotion
   */
  async update(id: string, tenantId: string, dto: UpdatePromotionDto) {
    const promotion = await this.prisma.promotion.findFirst({
      where: { id, tenantId, archivedAt: null },
    });

    if (!promotion) {
      throw new NotFoundException('Promoción no encontrada');
    }
    if (dto.type !== undefined || dto.value !== undefined) {
      assertValue(dto.type ?? promotion.type, dto.value ?? Number(promotion.value));
    }
    const applicableServiceIds =
      dto.applicableServiceIds !== undefined ? await this.serviceIds(tenantId, dto.applicableServiceIds) : undefined;

    return this.prisma.promotion.update({
      where: { id },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.type && { type: dto.type }),
        ...(dto.value && { value: dto.value }),
        ...(dto.minOrderValue !== undefined && { minOrderValue: dto.minOrderValue }),
        ...(dto.maxUses !== undefined && { maxUses: dto.maxUses }),
        ...(dto.maxUsesPerClient !== undefined && { maxUsesPerClient: dto.maxUsesPerClient }),
        ...(dto.startDate && { startDate: new Date(dto.startDate) }),
        ...(dto.endDate !== undefined && { endDate: dto.endDate ? new Date(dto.endDate) : null }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        ...(applicableServiceIds !== undefined && { applicableServiceIds }),
      },
    });
  }

  /**
   * Deletes a promotion. One already used at the till is archived instead
   * (switched off and hidden, `archivedAt`): its uses, its sales' discount
   * records and its invoices keep pointing at it. Answers which happened.
   */
  async delete(id: string, tenantId: string): Promise<{ id: string; deleted: boolean; archived: boolean }> {
    const promotion = await this.prisma.promotion.findFirst({
      where: { id, tenantId, archivedAt: null },
    });

    if (!promotion) {
      throw new NotFoundException('Promoción no encontrada');
    }

    // A re-engagement campaign that is running sends this code every day:
    // deleting the promotion under it would leave those emails without it.
    const linked = await this.prisma.emailCampaign.findFirst({
      where: { tenantId, linkedPromotionId: id, status: { in: ['active', 'scheduled', 'sending'] } },
      select: { name: true },
    });
    if (linked) {
      throw new ConflictException(
        `La promoción se usa en la campaña «${linked.name}», que está activa. Desactiva la campaña o quítale la promoción antes de eliminarla.`,
      );
    }

    // The promotion's row locked first: a sale claiming a use takes the same
    // lock (claimPromotionIn), so a use is never written under a delete.
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM promotions WHERE id = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`;
      const used = await tx.promotionUsage.count({ where: { promotionId: id } });
      if (used > 0) {
        await tx.promotion.update({
          where: { id },
          data: { archivedAt: new Date(), isActive: false },
        });
        return { id, deleted: false, archived: true };
      }
      await tx.promotion.delete({ where: { id } });
      return { id, deleted: true, archived: false };
    });
  }

  /**
   * Each promotion's uses at the till that still count (a fully refunded
   * sale released its use) and what they took off, in euros.
   */
  async getStatistics(tenantId: string, promotionId?: string) {
    const promotions = await this.prisma.promotion.findMany({
      where: { tenantId, archivedAt: null, ...(promotionId ? { id: promotionId } : {}) },
      select: { id: true, name: true, code: true, usedCount: true },
    });

    return Promise.all(
      promotions.map(async (promo) => {
        const usage = await this.prisma.promotionUsage.aggregate({
          where: { promotionId: promo.id, releasedAt: null },
          _sum: { discountAmount: true },
          _count: true,
        });

        return {
          id: promo.id,
          name: promo.name,
          code: promo.code,
          usedCount: promo.usedCount,
          totalDiscount: Number(usage._sum.discountAmount || 0),
          usageCount: usage._count,
        };
      }),
    );
  }

  /**
   * Whether a code can be used today (nothing is written): the same rules as
   * the till (promotion-at-till.ts), in the salon's clock. The till checks
   * again with the ticket (minimum order, services, the client's limit).
   */
  async validateCode(tenantId: string, code: string) {
    const promotion = await this.prisma.promotion.findFirst({
      where: {
        code: normalizePromotionCode(code),
        tenantId,
      },
    });

    if (!promotion) {
      return { valid: false, message: 'El código no es válido.' };
    }

    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
    const problem = promotionProblem(promotion as TillPromotion, new Date(), safeTimeZone(tenant?.timezone));
    if (problem) return { valid: false, message: problem };

    return {
      valid: true,
      name: promotion.name,
      description: promotion.description,
      type: promotion.type,
      value: Number(promotion.value),
      minOrderValue: Number(promotion.minOrderValue),
    };
  }
}
