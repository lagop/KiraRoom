import { Injectable, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { usablePromotionWhere } from '../email-campaigns/campaign-content';
import { CreatePromotionDto, UpdatePromotionDto, ApplyPromotionDto } from './dto/promotion.dto';

export { CreatePromotionDto, UpdatePromotionDto, ApplyPromotionDto };

/** 5 -> "5,00 €". */
function euros(value: number): string {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(Number.isFinite(value) ? value : 0);
}

/** A percentage over 100 would pay the client to come. */
function assertValue(type: string, value: number | undefined) {
  if (type === 'PERCENTAGE' && value !== undefined && value !== null && Number(value) > 100) {
    throw new BadRequestException('Un descuento en porcentaje no puede pasar del 100 %.');
  }
}

@Injectable()
export class PromotionsService {
  constructor(private prisma: PrismaService) {}

  /**
   * Create a new promotion
   */
  async create(tenantId: string, dto: CreatePromotionDto) {
    assertValue(dto.type, dto.value);

    // Check if code already exists for this tenant
    const existing = await this.prisma.promotion.findFirst({
      where: { 
        tenantId,
        code: dto.code.toUpperCase(),
      },
    });

    if (existing) {
      throw new BadRequestException('Ya tienes una promoción con ese código.');
    }

    return this.prisma.promotion.create({
      data: {
        tenantId,
        name: dto.name,
        description: dto.description,
        code: dto.code.toUpperCase(),
        type: dto.type,
        value: dto.value,
        minOrderValue: dto.minOrderValue || 0,
        maxUses: dto.maxUses,
        maxUsesPerClient: dto.maxUsesPerClient,
        startDate: new Date(dto.startDate),
        endDate: dto.endDate ? new Date(dto.endDate) : null,
        isActive: true,
      },
    });
  }

  /**
   * Get all promotions for a tenant
   */
  async getAll(tenantId: string) {
    return this.prisma.promotion.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * The promotions a re-engagement campaign can link: active and not past
   * their end date (a code the salon no longer honours must not be offered).
   */
  async getUsable(tenantId: string) {
    return this.prisma.promotion.findMany({
      where: { tenantId, ...usablePromotionWhere() },
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
      where: { id, tenantId },
    });

    if (!promotion) {
      throw new NotFoundException('Promoción no encontrada');
    }
    if (dto.type !== undefined || dto.value !== undefined) {
      assertValue(dto.type ?? promotion.type, dto.value ?? Number(promotion.value));
    }

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
      },
    });
  }

  /**
   * Delete promotion
   */
  async delete(id: string, tenantId: string) {
    const promotion = await this.prisma.promotion.findFirst({
      where: { id, tenantId },
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

    return this.prisma.promotion.delete({
      where: { id },
    });
  }

  /**
   * Apply a promotion code
   */
  async applyPromotion(tenantId: string, dto: ApplyPromotionDto) {
    const promotion = await this.prisma.promotion.findFirst({
      where: {
        code: dto.code.toUpperCase(),
        tenantId,
      },
    });

    if (!promotion) {
      throw new BadRequestException('El código no es válido.');
    }

    // The usage is recorded against this client: it must be one of the salon's.
    const client = await this.prisma.client.findFirst({
      where: { id: dto.clientId, tenantId },
      select: { id: true },
    });
    if (!client) {
      throw new NotFoundException('Cliente no encontrado');
    }

    if (!promotion.isActive) {
      throw new BadRequestException('La promoción ya no está activa.');
    }

    const now = new Date();
    if (now < promotion.startDate) {
      throw new BadRequestException('La promoción todavía no ha empezado.');
    }

    if (promotion.endDate && now > promotion.endDate) {
      throw new BadRequestException('La promoción ha terminado.');
    }

    if (promotion.maxUses && promotion.usedCount >= promotion.maxUses) {
      throw new BadRequestException('La promoción ya ha llegado a su máximo de usos.');
    }

    // Check min order value
    if (promotion.minOrderValue && dto.orderValue < Number(promotion.minOrderValue)) {
      throw new BadRequestException(`El importe mínimo para usar la promoción es ${euros(Number(promotion.minOrderValue))}.`);
    }

    // Check per-client usage
    if (promotion.maxUsesPerClient) {
      const clientUsage = await this.prisma.promotionUsage.count({
        where: {
          promotionId: promotion.id,
          clientId: dto.clientId,
        },
      });

      if (clientUsage >= promotion.maxUsesPerClient) {
        throw new BadRequestException('Esta clienta ya ha usado la promoción las veces permitidas.');
      }
    }

    // Calculate discount
    let discount = 0;
    if (promotion.type === 'PERCENTAGE') {
      discount = (dto.orderValue * Number(promotion.value)) / 100;
    } else if (promotion.type === 'FIXED') {
      discount = Math.min(Number(promotion.value), dto.orderValue);
    }

    // Record usage
    await this.prisma.promotionUsage.create({
      data: {
        promotionId: promotion.id,
        clientId: dto.clientId,
        discountAmount: discount,
      },
    });

    // Increment usage count
    await this.prisma.promotion.update({
      where: { id: promotion.id },
      data: { usedCount: { increment: 1 } },
    });

    return {
      success: true,
      discount,
      finalValue: dto.orderValue - discount,
      promotionName: promotion.name,
    };
  }

  /**
   * Get promotion usage statistics
   */
  async getStatistics(tenantId: string, promotionId?: string) {
    const where = { tenantId };
    if (promotionId) {
      (where as any).id = promotionId;
    }

    const promotions = await this.prisma.promotion.findMany({
      where,
    });

    const stats = await Promise.all(
      promotions.map(async (promo) => {
        const usage = await this.prisma.promotionUsage.aggregate({
          where: { promotionId: promo.id },
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
      })
    );

    return stats;
  }

  /**
   * Validate promotion code (without applying)
   */
  async validateCode(tenantId: string, code: string) {
    const promotion = await this.prisma.promotion.findFirst({
      where: {
        code: code.toUpperCase(),
        tenantId,
      },
    });

    if (!promotion) {
      return { valid: false, message: 'El código no es válido.' };
    }

    if (!promotion.isActive) {
      return { valid: false, message: 'La promoción ya no está activa.' };
    }

    const now = new Date();
    if (now < promotion.startDate) {
      return { valid: false, message: 'La promoción todavía no ha empezado.' };
    }

    if (promotion.endDate && now > promotion.endDate) {
      return { valid: false, message: 'La promoción ha terminado.' };
    }

    if (promotion.maxUses && promotion.usedCount >= promotion.maxUses) {
      return { valid: false, message: 'La promoción ya ha llegado a su máximo de usos.' };
    }

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
