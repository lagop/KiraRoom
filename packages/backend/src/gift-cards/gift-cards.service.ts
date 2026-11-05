import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { GiftCard, GiftCardTransaction, Prisma } from "@prisma/client";
import { randomBytes } from "crypto";
import { PrismaService } from "../common/prisma/prisma.service";
import { EmailService } from "../notifications/services/email.service";
import { CreateGiftCardDto } from "./dto/create-gift-card.dto";
import { RedeemGiftCardDto } from "./dto/redeem-gift-card.dto";
import { UpdateGiftCardDto } from "./dto/update-gift-card.dto";
import {
  defaultExpiryDay,
  endOfSalonDay,
  expiryDayOf,
  isPastDay,
  parseExpiryDay,
  safeTimeZone,
} from "./gift-card-expiry";
import { buildGiftCardEmail, formatEuros } from "./gift-card-email";

export interface ListGiftCardsParams {
  page?: number;
  limit?: number;
  isActive?: boolean;
}

/**
 * What the panel shows. `spent` and `expired` are derived: `isActive` is
 * only the salon's own switch.
 */
export type GiftCardStatus = "active" | "inactive" | "expired" | "spent";

type Tx = Prisma.TransactionClient;

/** Who and what a redemption is for. Give `code` (what the client shows) or `giftCardId`. */
export interface RedeemInTxInput {
  tenantId: string;
  code?: string;
  giftCardId?: string;
  amountCents: number;
  /** The sale payment the card pays (part of). */
  paymentId?: string | null;
  /** The team member at the till. */
  userId?: string | null;
  note?: string | null;
}

export interface RefundToCardInput {
  tenantId: string;
  giftCardId: string;
  amountCents: number;
  /** The payment the card paid: at most what it took from the card can go back. */
  paymentId: string;
  userId?: string | null;
  note?: string | null;
}

export interface SellInTxInput {
  tenantId: string;
  amountCents: number;
  /** The sale payment the client paid the card with. */
  paymentId: string;
  userId?: string | null;
  purchasedById?: string | null;
  recipientId?: string | null;
  recipientName?: string | null;
  recipientEmail?: string | null;
  message?: string | null;
  /** Last valid day ("YYYY-MM-DD", salon calendar). Left out: two years. `null`: never expires. */
  expiresOn?: string | null;
}

export interface GiftCardMovementResult {
  card: GiftCard;
  transaction: GiftCardTransaction;
}

const MAX_AMOUNT_CENTS = 1_000_000;

/** "a1b2 c3d4-e5f6" -> "A1B2C3D4E5F6": however the code was typed at the till. */
export function normalizeGiftCardCode(code: string): string {
  return String(code ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, "");
}

export function giftCardStatus(
  card: Pick<GiftCard, "isActive" | "currentBalance" | "expiresAt">,
  now: Date = new Date(),
): GiftCardStatus {
  if (card.currentBalance <= 0) return "spent";
  if (card.expiresAt && card.expiresAt.getTime() < now.getTime()) return "expired";
  if (!card.isActive) return "inactive";
  return "active";
}

@Injectable()
export class GiftCardsService {
  private readonly logger = new Logger(GiftCardsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  private generateCode(): string {
    return randomBytes(6).toString("hex").toUpperCase();
  }

  private async timeZoneOf(db: Tx | PrismaService, tenantId: string): Promise<string> {
    const tenant = await db.tenant.findUnique({
      where: { id: tenantId },
      select: { timezone: true },
    });
    return safeTimeZone(tenant?.timezone);
  }

  /** The card as the panel reads it: plus `status` and the salon day it expires on. */
  private present<T extends GiftCard>(card: T, timeZone: string, now = new Date()) {
    return {
      ...card,
      status: giftCardStatus(card, now),
      expiresOn: expiryDayOf(card.expiresAt, timeZone),
    };
  }

  /**
   * The stored expiry for a requested day: the end of that day in the salon.
   * `undefined` gives the default validity, `null` no expiry. A day before
   * today is refused.
   */
  private expiryFor(requested: string | null | undefined, timeZone: string): Date | null {
    if (requested === null) return null;
    const day = requested === undefined ? defaultExpiryDay(timeZone) : parseExpiryDay(requested);
    if (!day) {
      throw new BadRequestException("La fecha de caducidad no es válida");
    }
    if (isPastDay(day, timeZone)) {
      throw new BadRequestException("La fecha de caducidad no puede ser anterior a hoy");
    }
    return endOfSalonDay(day, timeZone);
  }

  private checkAmount(amountCents: number) {
    if (!Number.isInteger(amountCents) || amountCents < 1) {
      throw new BadRequestException("El importe debe ser un número entero de céntimos mayor que 0");
    }
    if (amountCents > MAX_AMOUNT_CENTS) {
      throw new BadRequestException("El importe no puede pasar de 10.000 €");
    }
  }

  // ==================== Issue / sell ====================

  private async issueInTx(
    tx: Tx,
    input: Omit<SellInTxInput, "paymentId"> & { paymentId?: string | null; note: string },
  ): Promise<GiftCardMovementResult> {
    this.checkAmount(input.amountCents);
    const timeZone = await this.timeZoneOf(tx, input.tenantId);
    const expiresAt = this.expiryFor(input.expiresOn, timeZone);
    const card = await tx.giftCard.create({
      data: {
        tenantId: input.tenantId,
        code: this.generateCode(),
        initialAmount: input.amountCents,
        currentBalance: input.amountCents,
        purchasedById: input.purchasedById ?? undefined,
        recipientId: input.recipientId ?? undefined,
        recipientEmail: input.recipientEmail ?? undefined,
        recipientName: input.recipientName ?? undefined,
        message: input.message ?? undefined,
        expiresAt,
      },
    });
    const transaction = await tx.giftCardTransaction.create({
      data: {
        giftCardId: card.id,
        type: "created",
        amount: input.amountCents,
        balanceAfter: card.currentBalance,
        paymentId: input.paymentId ?? undefined,
        createdById: input.userId ?? undefined,
        note: input.note,
      },
    });
    return { card, transaction };
  }

  /**
   * For the POS: a card sold at the till, inside the sale's transaction and
   * linked to the payment it was paid with. Email it after the sale commits
   * with `sendCardEmail`.
   */
  async sellInTx(tx: Tx, input: SellInTxInput): Promise<GiftCardMovementResult> {
    if (!input.paymentId) {
      throw new BadRequestException("Falta el pago con el que se vende la tarjeta regalo");
    }
    return this.issueInTx(tx, { ...input, note: "Tarjeta regalo vendida" });
  }

  /** From the panel: a card issued by the salon, emailed to the recipient if asked. */
  async create(tenantId: string, dto: CreateGiftCardDto, userId?: string | null) {
    const { card, transaction } = await this.prisma.$transaction((tx) =>
      this.issueInTx(tx, {
        tenantId,
        amountCents: dto.initialAmount,
        userId,
        purchasedById: dto.purchasedById,
        recipientId: dto.recipientId,
        recipientName: dto.recipientName,
        recipientEmail: dto.recipientEmail,
        message: dto.message,
        expiresOn: dto.expiresAt,
        note: "Tarjeta regalo emitida",
      }),
    );

    // The card exists whatever happens to the email: the panel says whether it went.
    let emailSent: boolean | null = null;
    if (card.recipientEmail && dto.sendEmail !== false) {
      emailSent = (await this.sendCardEmail(tenantId, card.id)).sent;
    }

    const timeZone = await this.timeZoneOf(this.prisma, tenantId);
    return { ...this.present(card, timeZone), transactions: [transaction], emailSent };
  }

  /**
   * Emails the card (salon, amount, code, expiry, how to use it) to its
   * recipient. Never throws: a failed send is logged and reported as
   * `sent: false`.
   */
  async sendCardEmail(tenantId: string, giftCardId: string): Promise<{ sent: boolean; error?: string }> {
    try {
      const card = await this.prisma.giftCard.findFirst({
        where: { id: giftCardId, tenantId },
        include: {
          tenant: {
            select: { name: true, phone: true, street: true, city: true, email: true, timezone: true },
          },
        },
      });
      if (!card?.recipientEmail) return { sent: false, error: "no_recipient" };
      const tenant = card.tenant;
      const timeZone = safeTimeZone(tenant.timezone);
      const { subject, html, text } = buildGiftCardEmail({
        salonName: tenant.name,
        salonAddress: [tenant.street, tenant.city].filter(Boolean).join(", ") || null,
        salonPhone: tenant.phone,
        recipientName: card.recipientName,
        amountCents: card.currentBalance,
        code: card.code,
        expiresOn: expiryDayOf(card.expiresAt, timeZone),
        message: card.message,
      });
      const res = await this.email.sendEmail({
        to: card.recipientEmail,
        subject,
        html,
        text,
        replyTo: tenant.email || undefined,
        idempotencyKey: `gift-card-${card.id}`,
      });
      if (!res.success) {
        this.logger.warn(`Gift card ${card.id}: email not sent (${res.error ?? "unknown"})`);
      }
      return res.success ? { sent: true } : { sent: false, error: res.error };
    } catch (err) {
      this.logger.warn(`Gift card ${giftCardId}: email failed: ${(err as Error)?.message}`);
      return { sent: false, error: "send_failed" };
    }
  }

  // ==================== Read ====================

  async findAll(tenantId: string, params: ListGiftCardsParams = {}) {
    const page = Math.max(1, Math.floor(params.page ?? 1) || 1);
    const limit = Math.min(100, Math.max(1, Math.floor(params.limit ?? 20) || 20));
    const where: Prisma.GiftCardWhereInput = { tenantId };
    if (typeof params.isActive === "boolean") {
      where.isActive = params.isActive;
    }

    const [items, total, timeZone] = await Promise.all([
      this.prisma.giftCard.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.giftCard.count({ where }),
      this.timeZoneOf(this.prisma, tenantId),
    ]);

    const now = new Date();
    return {
      items: items.map((c) => this.present(c, timeZone, now)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /** A card with its movements (newest first), each with who made it. */
  async findOne(tenantId: string, id: string) {
    const card = await this.prisma.giftCard.findFirst({
      where: { id, tenantId },
      include: { transactions: { orderBy: { createdAt: "desc" } } },
    });
    if (!card) {
      throw new NotFoundException("Tarjeta regalo no encontrada");
    }
    const userIds = [
      ...new Set(card.transactions.map((t) => t.createdById).filter((v): v is string => !!v)),
    ];
    const users = userIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: userIds }, tenantId },
          select: { id: true, firstName: true, lastName: true },
        })
      : [];
    const names = new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));
    const timeZone = await this.timeZoneOf(this.prisma, tenantId);
    return {
      ...this.present(card, timeZone),
      transactions: card.transactions.map((t) => ({
        ...t,
        createdByName: t.createdById ? names.get(t.createdById) ?? null : null,
      })),
    };
  }

  /** The card behind the code the client shows at the till. */
  async lookupByCode(tenantId: string, code: string) {
    const card = await this.prisma.giftCard.findFirst({
      where: { tenantId, code: normalizeGiftCardCode(code) },
    });
    if (!card) {
      throw new NotFoundException("Tarjeta regalo no encontrada");
    }
    const timeZone = await this.timeZoneOf(this.prisma, tenantId);
    return this.present(card, timeZone);
  }

  // ==================== Manage ====================

  async update(tenantId: string, id: string, dto: UpdateGiftCardDto) {
    const card = await this.prisma.giftCard.findFirst({ where: { id, tenantId } });
    if (!card) {
      throw new NotFoundException("Tarjeta regalo no encontrada");
    }
    const timeZone = await this.timeZoneOf(this.prisma, tenantId);
    const expiresAt =
      dto.expiresAt === undefined ? card.expiresAt : this.expiryFor(dto.expiresAt, timeZone);

    if (dto.isActive === true && !card.isActive) {
      if (card.currentBalance <= 0) {
        throw new BadRequestException("No se puede reactivar una tarjeta regalo agotada");
      }
      if (expiresAt && expiresAt.getTime() < Date.now()) {
        throw new BadRequestException(
          "No se puede reactivar una tarjeta regalo caducada: cambia antes la fecha de caducidad",
        );
      }
    }

    const updated = await this.prisma.giftCard.update({
      where: { id: card.id },
      data: {
        isActive: dto.isActive,
        expiresAt: dto.expiresAt === undefined ? undefined : expiresAt,
        message: dto.message,
      },
    });
    return this.present(updated, timeZone);
  }

  /** Soft delete: the card stops working; its history stays. */
  async remove(tenantId: string, id: string) {
    const card = await this.prisma.giftCard.findFirst({ where: { id, tenantId } });
    if (!card) {
      throw new NotFoundException("Tarjeta regalo no encontrada");
    }
    const updated = card.isActive
      ? await this.prisma.giftCard.update({ where: { id: card.id }, data: { isActive: false } })
      : card;
    const timeZone = await this.timeZoneOf(this.prisma, tenantId);
    return this.present(updated, timeZone);
  }

  // ==================== Redeem / refund ====================

  /** Why a card cannot pay `amountCents` now, in the words the till shows. */
  private refusal(card: GiftCard, amountCents: number, now: Date): BadRequestException | ConflictException {
    if (card.currentBalance <= 0) {
      return new BadRequestException("La tarjeta regalo no tiene saldo");
    }
    if (card.expiresAt && card.expiresAt.getTime() < now.getTime()) {
      return new BadRequestException("La tarjeta regalo ha caducado");
    }
    if (!card.isActive) {
      return new BadRequestException("La tarjeta regalo no está activa");
    }
    if (card.currentBalance < amountCents) {
      return new BadRequestException(
        `Saldo insuficiente en la tarjeta regalo: quedan ${formatEuros(card.currentBalance)}`,
      );
    }
    // It could pay a moment ago: another change got there first.
    return new ConflictException("La tarjeta regalo acaba de cambiar; inténtalo de nuevo");
  }

  /**
   * For the POS (and the panel's own redeem): takes `amountCents` from the
   * card inside the caller's transaction.
   *
   * The balance is checked and taken in ONE conditional UPDATE, so two tills
   * redeeming the same card at once cannot both spend it: the second waits
   * for the first's row lock, re-checks the balance and matches nothing.
   */
  async redeemInTx(tx: Tx, input: RedeemInTxInput): Promise<GiftCardMovementResult> {
    this.checkAmount(input.amountCents);
    let id = input.giftCardId;
    if (!id) {
      const code = normalizeGiftCardCode(input.code ?? "");
      const found = code
        ? await tx.giftCard.findFirst({
            where: { tenantId: input.tenantId, code },
            select: { id: true },
          })
        : null;
      if (!found) throw new NotFoundException("Tarjeta regalo no encontrada");
      id = found.id;
    }

    const now = new Date();
    const { count } = await tx.giftCard.updateMany({
      where: {
        id,
        tenantId: input.tenantId,
        isActive: true,
        currentBalance: { gte: input.amountCents },
        OR: [{ expiresAt: null }, { expiresAt: { gte: now } }],
      },
      data: { currentBalance: { decrement: input.amountCents } },
    });

    // Our UPDATE holds the row lock until the caller commits, so this reads our own balance.
    const card = await tx.giftCard.findFirst({ where: { id, tenantId: input.tenantId } });
    if (!card) throw new NotFoundException("Tarjeta regalo no encontrada");
    if (count !== 1) throw this.refusal(card, input.amountCents, now);

    const transaction = await tx.giftCardTransaction.create({
      data: {
        giftCardId: card.id,
        type: "applied",
        amount: input.amountCents,
        balanceAfter: card.currentBalance,
        paymentId: input.paymentId ?? undefined,
        createdById: input.userId ?? undefined,
        note: input.note ?? undefined,
      },
    });
    return { card, transaction };
  }

  /**
   * For the POS: gives back to the card (part of) what `paymentId` took from
   * it, e.g. when that sale is refunded. Never more than the payment took,
   * net of earlier refunds.
   */
  async refundToCard(tx: Tx, input: RefundToCardInput): Promise<GiftCardMovementResult> {
    this.checkAmount(input.amountCents);
    if (!input.paymentId) {
      throw new BadRequestException("Falta el pago cuya devolución vuelve a la tarjeta regalo");
    }
    // Serialise refunds of the same card so two cannot both pass the check below.
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "gift_cards"
      WHERE "id" = ${input.giftCardId} AND "tenantId" = ${input.tenantId}
      FOR UPDATE`;
    if (!locked.length) throw new NotFoundException("Tarjeta regalo no encontrada");

    const card = await tx.giftCard.findFirst({
      where: { id: input.giftCardId, tenantId: input.tenantId },
    });
    if (!card) throw new NotFoundException("Tarjeta regalo no encontrada");

    const movements = await tx.giftCardTransaction.groupBy({
      by: ["type"],
      where: {
        giftCardId: card.id,
        paymentId: input.paymentId,
        type: { in: ["applied", "refunded"] },
      },
      _sum: { amount: true },
    });
    const sum = (type: string) => movements.find((m) => m.type === type)?._sum.amount ?? 0;
    const refundable = sum("applied") - sum("refunded");
    if (refundable <= 0) {
      throw new BadRequestException("Este pago no tiene nada que devolver a la tarjeta regalo");
    }
    if (input.amountCents > refundable) {
      throw new BadRequestException(
        `Solo se pueden devolver ${formatEuros(refundable)} a la tarjeta regalo por este pago`,
      );
    }
    if (card.expiresAt && card.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException("La tarjeta regalo ha caducado: devuelve el importe por otro medio");
    }
    // A card the salon switched off while it still had money stays off. One
    // that is off only because it was spent (cards used to switch themselves
    // off at 0) works again with the money back.
    if (!card.isActive && card.currentBalance > 0) {
      throw new BadRequestException("La tarjeta regalo no está activa: devuelve el importe por otro medio");
    }

    const updated = await tx.giftCard.update({
      where: { id: card.id },
      data: {
        currentBalance: { increment: input.amountCents },
        ...(card.isActive ? {} : { isActive: true }),
      },
    });
    const transaction = await tx.giftCardTransaction.create({
      data: {
        giftCardId: card.id,
        type: "refunded",
        amount: input.amountCents,
        balanceAfter: updated.currentBalance,
        paymentId: input.paymentId,
        createdById: input.userId ?? undefined,
        note: input.note ?? undefined,
      },
    });
    return { card: updated, transaction };
  }

  /** The panel's redeem (`POST /gift-cards/redeem`). */
  async redeem(tenantId: string, dto: RedeemGiftCardDto, userId?: string | null) {
    const { card } = await this.prisma.$transaction((tx) =>
      this.redeemInTx(tx, {
        tenantId,
        giftCardId: dto.giftCardId,
        amountCents: dto.amount,
        paymentId: dto.paymentId,
        userId,
        note: dto.note,
      }),
    );
    const timeZone = await this.timeZoneOf(this.prisma, tenantId);
    return this.present(card, timeZone);
  }
}
