import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';

export interface CreatePromotionDto {
  name: string;
  description?: string;
  code: string;
  type: 'PERCENTAGE' | 'FIXED' | 'BUY_X_GET_Y';
  value: number;
  minOrderValue?: number;
  maxUses?: number;
  maxUsesPerClient?: number;
  startDate: string;
  endDate?: string;
  serviceIds?: string[];
  productIds?: string[];
}

export interface UpdatePromotionDto {
  name?: string;
  description?: string;
  type?: 'PERCENTAGE' | 'FIXED' | 'BUY_X_GET_Y';
  value?: number;
  minOrderValue?: number;
  maxUses?: number;
  maxUsesPerClient?: number;
  startDate?: string;
  endDate?: string;
  isActive?: boolean;
  serviceIds?: string[];
  productIds?: string[];
}

export interface ApplyPromotionDto {
  code: string;
  clientId: string;
  orderValue: number;
  serviceIds?: string[];
  productIds?: string[];
}

@Injectable()
export class PromotionsService {
  constructor(private prisma: PrismaService) {}

  /**
   * Create a new promotion
   */
  async create(tenantId: string, dto: CreatePromotionDto) {
    // Check if code already exists for this tenant
    const existing = await this.prisma.promotion.findFirst({
      where: { 
        tenantId,
        code: dto.code.toUpperCase(),
      },
    });

    if (existing) {
      throw new BadRequestException('Promotion code already exists');
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
   * Get single promotion
   */
  async getOne(id: string, tenantId: string) {
    const promotion = await this.prisma.promotion.findFirst({
      where: { id, tenantId },
    });

    if (!promotion) {
      throw new NotFoundException('Promotion not found');
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
      throw new NotFoundException('Promotion not found');
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
      throw new NotFoundException('Promotion not found');
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
      throw new BadRequestException('Invalid promotion code');
    }

    if (!promotion.isActive) {
      throw new BadRequestException('Promotion is no longer active');
    }

    const now = new Date();
    if (now < promotion.startDate) {
      throw new BadRequestException('Promotion has not started yet');
    }

    if (promotion.endDate && now > promotion.endDate) {
      throw new BadRequestException('Promotion has expired');
    }

    if (promotion.maxUses && promotion.usedCount >= promotion.maxUses) {
      throw new BadRequestException('Promotion usage limit reached');
    }

    // Check min order value
    if (promotion.minOrderValue && dto.orderValue < Number(promotion.minOrderValue)) {
      throw new BadRequestException(`Minimum order value of €${promotion.minOrderValue} required`);
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
        throw new BadRequestException('You have reached the maximum uses for this promotion');
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
      return { valid: false, message: 'Invalid promotion code' };
    }

    if (!promotion.isActive) {
      return { valid: false, message: 'Promotion is no longer active' };
    }

    const now = new Date();
    if (now < promotion.startDate) {
      return { valid: false, message: 'Promotion has not started yet' };
    }

    if (promotion.endDate && now > promotion.endDate) {
      return { valid: false, message: 'Promotion has expired' };
    }

    if (promotion.maxUses && promotion.usedCount >= promotion.maxUses) {
      return { valid: false, message: 'Promotion usage limit reached' };
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
