import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import { CreateGiftCardDto } from "./dto/create-gift-card.dto";
import { RedeemGiftCardDto } from "./dto/redeem-gift-card.dto";
import { UpdateGiftCardDto } from "./dto/update-gift-card.dto";
import { randomBytes } from "crypto";

export interface ListGiftCardsParams {
  page?: number;
  limit?: number;
  isActive?: boolean;
}

@Injectable()
export class GiftCardsService {
  constructor(private readonly prisma: PrismaService) {}

  private generateCode(): string {
    return randomBytes(6).toString("hex").toUpperCase();
  }

  async create(tenantId: string, dto: CreateGiftCardDto) {
    const code = this.generateCode();
    return this.prisma.giftCard.create({
      data: {
        tenantId,
        code,
        initialAmount: dto.initialAmount,
        currentBalance: dto.initialAmount,
        purchasedById: dto.purchasedById,
        recipientId: dto.recipientId,
        recipientEmail: dto.recipientEmail,
        recipientName: dto.recipientName,
        message: dto.message,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
        transactions: {
          create: {
            type: "created",
            amount: dto.initialAmount,
            note: "Gift card issued",
          },
        },
      },
      include: { transactions: true },
    });
  }

  async findAll(tenantId: string, params: ListGiftCardsParams = {}) {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 20));
    const where: any = { tenantId };
    if (typeof params.isActive === "boolean") {
      where.isActive = params.isActive;
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.giftCard.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.giftCard.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findOne(tenantId: string, id: string) {
    const card = await this.prisma.giftCard.findFirst({
      where: { id, tenantId },
      include: { transactions: { orderBy: { createdAt: "desc" } } },
    });
    if (!card) {
      throw new NotFoundException(`Gift card ${id} not found`);
    }
    return card;
  }

  async lookupByCode(tenantId: string, code: string) {
    const card = await this.prisma.giftCard.findFirst({
      where: { tenantId, code: code.toUpperCase() },
    });
    if (!card) {
      throw new NotFoundException(`Gift card ${code} not found`);
    }
    return card;
  }

  async update(tenantId: string, id: string, dto: UpdateGiftCardDto) {
    await this.findOne(tenantId, id);
    return this.prisma.giftCard.update({
      where: { id },
      data: {
        isActive: dto.isActive,
        expiresAt:
          dto.expiresAt === undefined
            ? undefined
            : dto.expiresAt === null
              ? null
              : new Date(dto.expiresAt),
        message: dto.message,
      },
    });
  }

  async remove(tenantId: string, id: string) {
    await this.findOne(tenantId, id);
    return this.prisma.giftCard.update({
      where: { id },
      data: { isActive: false },
    });
  }

  async redeem(tenantId: string, dto: RedeemGiftCardDto) {
    return this.prisma.$transaction(async (tx) => {
      const card = await tx.giftCard.findFirst({
        where: { id: dto.giftCardId, tenantId },
      });
      if (!card) {
        throw new NotFoundException(`Gift card ${dto.giftCardId} not found`);
      }
      if (!card.isActive) {
        throw new BadRequestException(`Gift card ${card.code} is not active`);
      }
      if (card.expiresAt && card.expiresAt.getTime() < Date.now()) {
        throw new BadRequestException(`Gift card ${card.code} has expired`);
      }
      if (card.currentBalance < dto.amount) {
        throw new BadRequestException(
          `Insufficient balance on gift card ${card.code}`,
        );
      }

      const newBalance = card.currentBalance - dto.amount;
      const updated = await tx.giftCard.update({
        where: { id: card.id },
        data: {
          currentBalance: newBalance,
          isActive: newBalance > 0 ? card.isActive : false,
        },
      });

      await tx.giftCardTransaction.create({
        data: {
          giftCardId: card.id,
          type: "applied",
          amount: dto.amount,
          paymentId: dto.paymentId,
          note: dto.note,
        },
      });

      return updated;
    });
  }
}
