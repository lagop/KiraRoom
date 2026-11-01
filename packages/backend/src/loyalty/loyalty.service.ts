import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma/prisma.service";
import { FeatureFlagService } from "../common/feature-flags/feature-flag.service";
import {
  AdjustPointsDto,
  LoyaltyProgramSettingsDto,
  LoyaltyRewardDto,
  LoyaltyTierDto,
  UpdateLoyaltyRewardDto,
  UpdateLoyaltyTierDto,
  discountValueProblem,
} from "./loyalty.dto";
import { expiryRun, graceAfterChange } from "./loyalty-expiry";

type TxType = "earn" | "redeem" | "reversal" | "redeem_reversal" | "welcome" | "adjust" | "expire";

interface PointsChange {
  type: TxType;
  /** Signed. */
  points: number;
  source: string;
  sourceId: string | null;
  description: string;
  metadata?: Record<string, unknown>;
  actorId?: string | null;
  /**
   * For a negative change: "strict" (the default) refuses when the balance
   * is short -- a redemption, a manual deduction; "allowNegative" takes it
   * all, the balance going below zero -- a reversal of points the client
   * already spent (earn, redeem, refund). The reward stays used; her next
   * earnings pay the debt off, and she cannot redeem meanwhile. Reversals
   * used to stop at zero, so earn, spend, refund kept the reward for free.
   */
  shortfall?: "strict" | "allowNegative";
}

export interface SaleItem {
  serviceId?: string;
  price: number;
  quantity: number;
}

const HISTORY_LIMIT = 30;
const SWEEP_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;
const SWEEP_BATCH = 1000;
const MEMBER_BATCH = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A reward handed over at the desk rather than taken off the ticket: a
 * product of the catalogue (its stock goes down) or "otro regalo" (a
 * description only). The till records it as a zero-price line.
 */
export interface RewardGift {
  kind: "product" | "other";
  /** The product given (kind "product"). */
  productId: string | null;
  /** What the line says: the reward's description, else its name. */
  description: string;
}

/**
 * The gift of a product or "otro regalo" (voucher) reward, else null. A
 * product reward with no product chosen (made before rewards could name
 * one) is recorded as "otro regalo": a line without a stock movement.
 */
export function giftOf(reward: {
  type: string;
  name: string;
  description?: string | null;
  productId?: string | null;
}): RewardGift | null {
  if (reward.type !== "product" && reward.type !== "voucher") return null;
  const description = (reward.description?.trim() || reward.name).slice(0, 160);
  if (reward.type === "product" && reward.productId) {
    return { kind: "product", productId: reward.productId, description };
  }
  return { kind: "other", productId: null, description };
}

/** The member changed between the expiry's read and its write: skipped. */
class ExpiryRaced extends Error {}

/** A Prisma unique-constraint violation: the change was applied before. */
function isDuplicate(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  ) || (err as any)?.code === "P2002";
}

/**
 * The money a visit's share of the till's loyalty reward covered
 * (`Appointment.discount.loyalty.moneyCents`, pos.service.ts), else 0.
 */
function ownRewardMoneyCents(discount: unknown): number {
  const loyalty = (discount as { loyalty?: { moneyCents?: unknown } } | null | undefined)?.loyalty;
  const cents = Number(loyalty?.moneyCents);
  return Number.isFinite(cents) && cents > 0 ? Math.round(cents) : 0;
}

/**
 * The salon's loyalty programme: configuration, members and points.
 *
 * Points used to move only when someone typed them in, and no client could
 * join. Now they follow the money: a paid, completed appointment or a till
 * sale earns them, a refund or cancellation takes them back, and the till
 * spends them as a discount. Every movement is a LoyaltyTransaction with a
 * unique (member, type, source, sourceId) key, so the hooks below can be
 * called from every code path that completes, pays or refunds -- and the
 * hourly sweep can re-run them -- without ever counting a visit twice.
 */
@Injectable()
export class LoyaltyService {
  private readonly logger = new Logger(LoyaltyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: FeatureFlagService,
  ) {}

  // ---------------------------------------------------------------- config

  async getProgram(tenantId: string) {
    return this.prisma.loyaltyProgram.findFirst({
      where: { tenantId },
      include: {
        tiers: { orderBy: { minPoints: "asc" } },
        rewards: { orderBy: { pointsCost: "asc" } },
        _count: { select: { members: true } },
      },
    });
  }

  async saveProgram(tenantId: string, dto: LoyaltyProgramSettingsDto) {
    const data = {
      name: dto.name,
      description: dto.description,
      isActive: dto.isActive,
      earnMode: dto.earnMode,
      pointsPerEuro: dto.pointsPerEuro,
      pointsPerVisit: dto.pointsPerVisit,
      minPointsRedemption: dto.minPointsRedemption,
      welcomePoints: dto.welcomePoints,
      autoEnroll: dto.autoEnroll,
      allowSelfEnroll: dto.allowSelfEnroll,
      pointsExpirationDays: dto.pointsExpirationDays,
      showPointsInReviewEmail: dto.showPointsInReviewEmail,
    };
    // Expiry switched on or shortened: nothing expires for 30 days, so no
    // member loses points the night after the change.
    const before = await this.prisma.loyaltyProgram.findFirst({
      where: { tenantId },
      select: { pointsExpirationDays: true, pointsExpiryStartsAt: true },
    });
    const grace = before ? graceAfterChange(before, dto.pointsExpirationDays) : undefined;
    if (grace !== undefined) (data as Record<string, unknown>).pointsExpiryStartsAt = grace;
    await this.prisma.loyaltyProgram.upsert({
      where: { tenantId },
      create: { tenantId, ...data, name: dto.name || "Programa de fidelización" },
      update: data,
    });
    return this.getProgram(tenantId);
  }

  private async requireProgram(tenantId: string) {
    const program = await this.prisma.loyaltyProgram.findFirst({ where: { tenantId } });
    if (!program) throw new NotFoundException("El salón aún no ha configurado su programa de fidelización");
    return program;
  }

  async createReward(tenantId: string, dto: LoyaltyRewardDto) {
    const program = await this.requireProgram(tenantId);
    await this.checkFreeService(tenantId, dto.type, dto.freeServiceId);
    await this.checkProduct(tenantId, dto.type, dto.productId, true);
    const value = this.checkDiscountValue(dto.type, dto.discountPercent, dto.discountAmount);
    return this.prisma.loyaltyReward.create({
      data: {
        programId: program.id,
        name: dto.name,
        description: dto.description,
        type: dto.type,
        pointsCost: dto.pointsCost,
        ...value,
        freeServiceId: dto.freeServiceId ?? null,
        productId: dto.type === "product" ? dto.productId ?? null : null,
        isActive: dto.isActive ?? true,
        maxRedemptions: dto.maxRedemptions ?? null,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      },
    });
  }

  /**
   * Edits a reward. The discount is checked as it will stand (what is sent
   * over what is stored); null clears the limit or the expiry.
   */
  async updateReward(tenantId: string, id: string, dto: UpdateLoyaltyRewardDto) {
    const reward = await this.ownReward(tenantId, id);
    const type = dto.type ?? reward.type;
    await this.checkFreeService(tenantId, type, dto.freeServiceId ?? reward.freeServiceId);
    // Only when the edit is about it: switching a reward off sends neither.
    if (dto.type !== undefined || dto.productId !== undefined) {
      await this.checkProduct(tenantId, type, dto.productId !== undefined ? dto.productId : reward.productId, true);
    }
    const touchesValue = dto.type !== undefined || dto.discountPercent !== undefined || dto.discountAmount !== undefined;
    const value = touchesValue
      ? this.checkDiscountValue(
          type,
          dto.discountPercent !== undefined ? dto.discountPercent : reward.discountPercent,
          dto.discountAmount !== undefined ? dto.discountAmount : reward.discountAmount,
        )
      : {};
    if (
      dto.maxRedemptions != null &&
      dto.maxRedemptions < reward.currentRedemptions
    ) {
      throw new BadRequestException(
        `Ya se ha canjeado ${reward.currentRedemptions} veces: el límite no puede ser menor.`,
      );
    }
    return this.prisma.loyaltyReward.update({
      where: { id },
      data: {
        name: dto.name,
        description: dto.description,
        type: dto.type,
        pointsCost: dto.pointsCost,
        ...value,
        freeServiceId: dto.freeServiceId,
        ...(dto.type !== undefined || dto.productId !== undefined
          ? { productId: type === "product" ? (dto.productId !== undefined ? dto.productId : reward.productId) ?? null : null }
          : {}),
        isActive: dto.isActive,
        ...(dto.maxRedemptions !== undefined ? { maxRedemptions: dto.maxRedemptions } : {}),
        ...(dto.expiresAt !== undefined ? { expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null } : {}),
      },
    });
  }

  /**
   * A discount reward takes exactly one thing off: a percent or an amount,
   * above zero (one of 0 % and 0,00 EUR used to be accepted, and gave
   * nothing). The other is stored empty. Other types keep neither.
   */
  private checkDiscountValue(
    type: string,
    percent?: number | null,
    amount?: number | null,
  ): { discountPercent: number | null; discountAmount: number | null } {
    const problem = discountValueProblem(type, percent, amount);
    if (problem) throw new BadRequestException(problem);
    if (type !== "discount") return { discountPercent: null, discountAmount: null };
    return {
      discountPercent: percent && percent > 0 ? percent : null,
      discountAmount: amount && amount > 0 ? amount : null,
    };
  }

  async deleteReward(tenantId: string, id: string) {
    await this.ownReward(tenantId, id);
    // A reward already used stays in the members' history: switch it off.
    const used = await this.prisma.loyaltyRedemption.count({ where: { rewardId: id } });
    if (used > 0) {
      await this.prisma.loyaltyReward.update({ where: { id }, data: { isActive: false } });
      return { ok: true, deactivated: true };
    }
    await this.prisma.loyaltyReward.delete({ where: { id } });
    return { ok: true, deactivated: false };
  }

  private async ownReward(tenantId: string, id: string) {
    const reward = await this.prisma.loyaltyReward.findFirst({
      where: { id, program: { tenantId } },
    });
    if (!reward) throw new NotFoundException("Recompensa no encontrada");
    return reward;
  }

  /**
   * A product reward names the product handed over: the till takes it out
   * of stock when it is redeemed (a zero-price line, "regalo fidelidad").
   */
  private async checkProduct(tenantId: string, type: string, productId: string | null | undefined, required: boolean) {
    if (type !== "product") return;
    if (!productId) {
      if (required) throw new BadRequestException("Elige el producto que regala la recompensa");
      return;
    }
    const product = await this.prisma.product.findFirst({ where: { id: productId, tenantId }, select: { id: true } });
    if (!product) throw new BadRequestException("Ese producto no es de este salón");
  }

  private async checkFreeService(tenantId: string, type: string, serviceId?: string | null) {
    if (type !== "free_service") return;
    if (!serviceId) throw new BadRequestException("Elige el servicio que regala la recompensa");
    const service = await this.prisma.service.findFirst({ where: { id: serviceId, tenantId } });
    if (!service) throw new BadRequestException("Ese servicio no es de este salón");
  }

  /**
   * A new level. The members it reaches (by the most points they ever
   * accumulated) move up to it now; nobody moves down (retierProgram).
   */
  async createTier(tenantId: string, dto: LoyaltyTierDto) {
    const program = await this.requireProgram(tenantId);
    let tier;
    try {
      tier = await this.prisma.loyaltyTier.create({
        data: {
          programId: program.id,
          name: dto.name,
          minPoints: dto.minPoints,
          pointsMultiplier: dto.pointsMultiplier,
        },
      });
    } catch (err) {
      // (programId, name) is unique: a second "Oro" used to be a 500.
      if (isDuplicate(err)) throw new ConflictException(`Ya hay un nivel llamado «${dto.name}». Elige otro nombre.`);
      throw err;
    }
    await this.retierProgram(program.id);
    return tier;
  }

  /** Edits a level; members move up to what it now reaches, never down. */
  async updateTier(tenantId: string, id: string, dto: UpdateLoyaltyTierDto) {
    const tier = await this.prisma.loyaltyTier.findFirst({ where: { id, program: { tenantId } } });
    if (!tier) throw new NotFoundException("Nivel no encontrado");
    let updated;
    try {
      updated = await this.prisma.loyaltyTier.update({
        where: { id },
        data: { name: dto.name, minPoints: dto.minPoints, pointsMultiplier: dto.pointsMultiplier },
      });
    } catch (err) {
      if (isDuplicate(err)) throw new ConflictException(`Ya hay un nivel llamado «${dto.name}». Elige otro nombre.`);
      throw err;
    }
    await this.retierProgram(tier.programId);
    return updated;
  }

  /**
   * Removes a level. Its members (left with none: onDelete SetNull) take the
   * highest level that remains within their reach.
   */
  async deleteTier(tenantId: string, id: string) {
    const tier = await this.prisma.loyaltyTier.findFirst({ where: { id, program: { tenantId } } });
    if (!tier) throw new NotFoundException("Nivel no encontrado");
    await this.prisma.loyaltyTier.delete({ where: { id } });
    await this.retierProgram(tier.programId);
    return { ok: true };
  }

  /**
   * Levels never go down (owner decision 2026-11-02): every member of the
   * programme is moved UP to the highest level their peak lifetime points
   * reach, and nobody is moved down. In batches, level by level from the
   * lowest, so a member ends on the highest one that applies.
   */
  async retierProgram(programId: string): Promise<number> {
    const tiers = await this.prisma.loyaltyTier.findMany({
      where: { programId },
      orderBy: { minPoints: "asc" },
      select: { id: true, minPoints: true },
    });
    let moved = 0;
    for (const tier of tiers) {
      const below = {
        programId,
        peakLifetimePoints: { gte: tier.minPoints },
        OR: [{ tierId: null }, { tier: { minPoints: { lt: tier.minPoints } } }],
      };
      for (;;) {
        const batch = await this.prisma.loyaltyMember.findMany({ where: below, select: { id: true }, take: MEMBER_BATCH });
        if (batch.length === 0) break;
        const { count } = await this.prisma.loyaltyMember.updateMany({
          where: { ...below, id: { in: batch.map((m) => m.id) } },
          data: { tierId: tier.id },
        });
        moved += count;
        if (count === 0) break;
      }
    }
    return moved;
  }

  // --------------------------------------------------------------- members

  async listMembers(tenantId: string, search?: string) {
    const program = await this.prisma.loyaltyProgram.findFirst({ where: { tenantId } });
    if (!program) return [];
    const q = search?.trim();
    return this.prisma.loyaltyMember.findMany({
      where: {
        programId: program.id,
        client: {
          tenantId,
          ...(q
            ? {
                OR: [
                  { firstName: { contains: q, mode: "insensitive" } },
                  { lastName: { contains: q, mode: "insensitive" } },
                  { email: { contains: q, mode: "insensitive" } },
                  { phone: { contains: q } },
                ],
              }
            : {}),
        },
      },
      include: {
        client: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
        tier: { select: { name: true } },
      },
      orderBy: { currentPoints: "desc" },
      take: 500,
    });
  }

  /**
   * Signs a client up. Idempotent: an existing member is returned as is
   * (the welcome points are keyed to the member, so they are never given
   * twice either).
   */
  async enroll(
    tenantId: string,
    clientId: string,
    via: "staff" | "auto" | "portal",
    actorId?: string | null,
  ) {
    const program = await this.prisma.loyaltyProgram.findFirst({ where: { tenantId } });
    if (!program || !program.isActive) {
      throw new BadRequestException("El programa de fidelización no está activo");
    }
    const client = await this.prisma.client.findFirst({ where: { id: clientId, tenantId }, select: { id: true } });
    if (!client) throw new NotFoundException("Cliente no encontrado");
    return this.enrollInProgram(tenantId, program, clientId, via, actorId);
  }

  private async enrollInProgram(
    tenantId: string,
    program: { id: string; welcomePoints: number },
    clientId: string,
    via: "staff" | "auto" | "portal",
    actorId?: string | null,
  ) {
    let member = await this.prisma.loyaltyMember.findUnique({
      where: { clientId_programId: { clientId, programId: program.id } },
    });
    if (!member) {
      try {
        member = await this.prisma.loyaltyMember.create({
          // Signing up starts the expiry clock.
          data: { clientId, programId: program.id, enrolledVia: via, pointsRenewedAt: new Date() },
        });
      } catch (err) {
        // Two hooks enrolling the same client at once: the other one won.
        if (!isDuplicate(err)) throw err;
        member = await this.prisma.loyaltyMember.findUnique({
          where: { clientId_programId: { clientId, programId: program.id } },
        });
        if (!member) throw err;
      }
    }
    if (program.welcomePoints > 0) {
      await this.applyChange(tenantId, program.id, member.id, clientId, {
        type: "welcome",
        points: program.welcomePoints,
        source: "enrollment",
        sourceId: member.id,
        description: "Puntos de bienvenida",
        actorId,
      });
    }
    return this.prisma.loyaltyMember.findUnique({ where: { id: member.id } });
  }

  /** The loyalty block of a client's file (and of the till). */
  async clientSummary(tenantId: string, clientId: string) {
    const client = await this.prisma.client.findFirst({ where: { id: clientId, tenantId }, select: { id: true } });
    if (!client) throw new NotFoundException("Cliente no encontrado");
    const program = await this.prisma.loyaltyProgram.findFirst({
      where: { tenantId },
      include: { rewards: { where: { isActive: true }, orderBy: { pointsCost: "asc" } } },
    });
    if (!program) return { program: null, member: null, rewards: [], history: [] };
    const member = await this.prisma.loyaltyMember.findUnique({
      where: { clientId_programId: { clientId, programId: program.id } },
      include: { tier: { select: { name: true, pointsMultiplier: true } } },
    });
    const history = member
      ? await this.prisma.loyaltyTransaction.findMany({
          where: { memberId: member.id },
          orderBy: { createdAt: "desc" },
          take: HISTORY_LIMIT,
        })
      : [];
    const { rewards, ...programFields } = program;
    return {
      program: programFields,
      member: member ? { ...member, pointsExpireOn: this.expiryDateOf(program, member) } : null,
      rewards: rewards.map((r) => ({
        ...r,
        // A negative balance (a refund of points already spent) redeems nothing.
        redeemable:
          !!member &&
          program.isActive &&
          member.currentPoints >= 0 &&
          member.currentPoints >= r.pointsCost &&
          member.currentPoints >= program.minPointsRedemption,
      })),
      history,
    };
  }

  /**
   * When the member's balance expires if she does not come back: her last
   * visit plus the programme's period, never before the grace. Null when
   * points never expire or there is nothing to lose.
   */
  private expiryDateOf(
    program: { pointsExpirationDays?: number | null; pointsExpiryStartsAt?: Date | null },
    member: { currentPoints: number; pointsRenewedAt?: Date | null; joinedAt?: Date | null },
  ): Date | null {
    const days = program.pointsExpirationDays;
    if (!days || member.currentPoints <= 0) return null;
    const from = member.pointsRenewedAt ?? member.joinedAt;
    if (!from) return null;
    const at = new Date(new Date(from).getTime() + days * DAY_MS);
    const grace = program.pointsExpiryStartsAt ? new Date(program.pointsExpiryStartsAt) : null;
    return grace && grace > at ? grace : at;
  }

  async adjust(tenantId: string, memberId: string, dto: AdjustPointsDto, actorId?: string) {
    const member = await this.prisma.loyaltyMember.findFirst({
      where: { id: memberId, program: { tenantId } },
    });
    if (!member) throw new NotFoundException("Socio no encontrado");
    await this.applyChange(tenantId, member.programId, member.id, member.clientId, {
      type: "adjust",
      points: dto.points,
      source: "manual",
      sourceId: null,
      description: dto.reason,
      actorId,
      shortfall: "strict",
    });
    return this.prisma.loyaltyMember.findUnique({ where: { id: memberId } });
  }

  // --------------------------------------------------------------- earning

  /**
   * An appointment earns once it is both completed and paid IN FULL. Called
   * after every change that can make that true; does nothing until it is,
   * and nothing the second time.
   *
   * In full: its paymentStatus is "paid", which the till sets exactly when
   * the money (and the reward) cover what the visit costs, in money, with
   * the salon's tax basis (recordAppointmentPayment). A first partial
   * payment used to earn on what it was, once, and the rest paid later
   * earned nothing: one earn per visit, on its whole money, keeps every
   * refund and reversal (which work from that one entry's basis) exact.
   */
  async settleAppointment(tenantId: string, appointmentId: string): Promise<{ awarded: number } | null> {
    const program = await this.activeProgram(tenantId);
    if (!program) return null;
    const apt = await this.prisma.appointment.findFirst({
      where: { id: appointmentId, tenantId },
      select: {
        id: true,
        clientId: true,
        status: true,
        paymentStatus: true,
        amountPaid: true,
        totalAmount: true,
        servicePrice: true,
        discount: true,
        startTime: true,
        completionTime: true,
        service: { select: { price: true } },
        payments: { where: { status: "paid" }, select: { amount: true, method: true } },
      },
    });
    if (!apt?.clientId || apt.status !== "completed") return null;
    if (apt.paymentStatus !== "paid") return null;
    // A completed, paid visit renews all her points (they expire after
    // pointsExpirationDays without one), from when the visit was: a hook
    // called again months later does not stretch it.
    const now = Date.now();
    const visitMs = (apt.completionTime ?? apt.startTime)?.getTime?.() ?? now;
    const renewAt = new Date(Math.min(now, visitMs));
    // Paid means a payment recorded against the appointment (the till, the
    // payments screen, Stripe). The appointment's paymentStatus flag alone
    // used to be enough, and staff could set it by hand, for any amount.
    const moneyRows = (apt.payments ?? []).filter((p) => p.method !== "loyalty_points");
    if (moneyRows.length === 0) {
      // Paid in full with points (a free service): no points, but a visit.
      await this.renewExisting(program.id, apt.clientId, renewAt);
      return null;
    }
    const moneyCents = moneyRows.reduce((s, p) => s + p.amount, 0);

    const member = await this.memberForEarning(tenantId, program, apt.clientId);
    if (!member) return null;
    await this.renewMember(member.id, renewAt);

    let basis = Number(apt.amountPaid ?? 0);
    if (!(basis > 0)) basis = moneyCents;
    if (!(basis > 0)) basis = Number(apt.totalAmount ?? 0);
    if (!(basis > 0)) basis = Math.round(Number(apt.servicePrice ?? apt.service?.price ?? 0) * 100);
    // The part paid with points is not money spent: it earns nothing. The
    // visit's own share of the reward (the till records it on the visit);
    // the reward's whole value only for a visit charged before that record
    // existed. The whole value over-took when the reward also covered other
    // lines of the ticket, which now earn on their own (earnForSale).
    let pointsPaid = ownRewardMoneyCents(apt.discount);
    if (!pointsPaid) {
      const discounted = await this.prisma.loyaltyRedemption.aggregate({
        where: { appointmentId, status: { not: "cancelled" } },
        _sum: { valueReceived: true },
      });
      pointsPaid = discounted._sum.valueReceived ?? 0;
    }
    basis = Math.max(0, Math.round(basis - pointsPaid));
    // Never more than the money actually recorded for it.
    basis = Math.min(basis, moneyCents);

    const points = this.pointsFor(program, basis, member.tier?.pointsMultiplier ?? 1);
    if (points <= 0) return { awarded: 0 };
    const applied = await this.applyChange(tenantId, program.id, member.id, apt.clientId, {
      type: "earn",
      points,
      source: "appointment",
      sourceId: appointmentId,
      description: "Puntos por tu visita",
      metadata: { basisCents: basis },
    }, basis);
    return { awarded: applied ?? 0 };
  }

  /**
   * A cancelled or refunded appointment gives its points back: what it
   * earned less what partial refunds of it took back already
   * (onPartialRefund), so the two never take more than it earned.
   */
  async reverseAppointment(tenantId: string, appointmentId: string, reason: string): Promise<number> {
    const earned = await this.prisma.loyaltyTransaction.findFirst({
      where: { tenantId, type: "earn", source: "appointment", sourceId: appointmentId },
      include: { member: { select: { clientId: true } } },
    });
    if (!earned) return 0;
    const basis = Number((earned.metadata as any)?.basisCents ?? 0);
    const back = await this.takenBackByRefunds(earned.memberId, { appointmentId });
    const due = Math.max(0, earned.points - back.points);
    const taken = await this.applyChange(tenantId, earned.programId, earned.memberId, earned.member.clientId, {
      type: "reversal",
      points: -due,
      source: "appointment",
      sourceId: appointmentId,
      description: reason,
      shortfall: "allowNegative",
    }, -Math.max(0, basis - back.cents));
    return taken ?? 0;
  }

  /**
   * Points taken back of a visit or a till sale by refunds so far (reversal
   * rows of source "refund", one per refund: takeBackRefund), and the cents
   * they were for. Rows of source "payment" are full refunds of a sale's
   * payment recorded before refunds had their own entry; they count too.
   */
  private async takenBackByRefunds(
    memberId: string,
    of: { appointmentId?: string; posSaleId?: string },
  ): Promise<{ points: number; cents: number }> {
    const key = of.appointmentId
      ? { path: ["appointmentId"], equals: of.appointmentId }
      : { path: ["posSaleId"], equals: of.posSaleId as string };
    const rows = await this.prisma.loyaltyTransaction.findMany({
      where: {
        memberId,
        type: "reversal",
        source: { in: ["refund", "payment"] },
        metadata: key,
      },
      select: { points: true, metadata: true },
    });
    return {
      points: rows.reduce((s, t) => s - t.points, 0),
      cents: rows.reduce((s, t) => s + Number((t.metadata as any)?.refundCents ?? 0), 0),
    };
  }

  /**
   * A till sale with no appointment behind it. `isVisit` is false for a
   * products-only ticket, which earns nothing in per-visit mode.
   */
  async earnForSale(
    tenantId: string,
    args: { clientId?: string | null; saleId: string; basisCents: number; isVisit: boolean },
  ): Promise<number> {
    if (!args.clientId || args.basisCents <= 0) return 0;
    const program = await this.activeProgram(tenantId);
    if (!program) return 0;
    if (program.earnMode === "per_visit" && !args.isVisit) return 0;
    const member = await this.memberForEarning(tenantId, program, args.clientId);
    if (!member) return 0;
    // A purchase at the salon renews her points too (she came in).
    await this.renewMember(member.id, new Date());
    const points = this.pointsFor(program, args.basisCents, member.tier?.pointsMultiplier ?? 1);
    if (points <= 0) return 0;
    const applied = await this.applyChange(tenantId, program.id, member.id, args.clientId, {
      type: "earn",
      points,
      source: "pos_sale",
      sourceId: args.saleId,
      description: "Puntos por tu compra",
      metadata: { basisCents: args.basisCents },
    }, args.basisCents);
    return applied ?? 0;
  }

  /**
   * A payment refunded in full (what was left of it, `refund`) takes back
   * its share of what the payment paid for, like any refund
   * (takeBackRefund): a visit's row only that visit's points, in proportion;
   * a sale's own row only the sale's. The other visits and the other
   * clients of the ticket are not touched: every row used to carry all the
   * ticket's appointments, and refunding a shampoo took back every visit.
   *
   * A visit loses all its points (what is left of them) only when it is
   * itself refunded (paymentStatus "refunded": no money left on it) or
   * cancelled. When every payment of a sale is refunded, the points spent
   * on it come back too.
   */
  async onPaymentRefunded(
    tenantId: string,
    payment: { id: string; amount: number; type?: string | null; appointmentId?: string | null; metadata?: unknown },
    refund: { id: string; amount: number },
  ): Promise<void> {
    await this.takeBackRefund(tenantId, payment, refund, "Devolución del pago");

    if (payment.appointmentId) {
      const apt = await this.prisma.appointment.findFirst({
        where: { id: payment.appointmentId, tenantId },
        select: { status: true, paymentStatus: true },
      });
      if (apt && (apt.paymentStatus === "refunded" || apt.status === "cancelled")) {
        await this.reverseAppointment(
          tenantId,
          payment.appointmentId,
          apt.status === "cancelled" ? "Cita cancelada" : "Devolución del pago de la cita",
        );
      }
    }

    const saleId = ((payment.metadata ?? {}) as { posSaleId?: string }).posSaleId;
    if (!saleId) return;
    const stillPaid = await this.prisma.payment.count({
      where: { tenantId, status: "paid", metadata: { path: ["posSaleId"], equals: saleId } },
    });
    if (stillPaid === 0) {
      // The whole sale given back: what is left of its points (a refund
      // from before balances could go negative may have taken less than
      // its share) goes too, and the points spent on it come back.
      await this.reverseSale(tenantId, saleId);
      await this.cancelSaleRedemption(tenantId, saleId, "Devolución de la compra");
    }
  }

  /** A till sale refunded in full: what is left of the points its own lines earned. */
  private async reverseSale(tenantId: string, saleId: string): Promise<number> {
    const earned = await this.prisma.loyaltyTransaction.findFirst({
      where: { tenantId, type: "earn", source: "pos_sale", sourceId: saleId },
      include: { member: { select: { clientId: true } } },
    });
    if (!earned) return 0;
    const back = await this.takenBackByRefunds(earned.memberId, { posSaleId: saleId });
    const due = earned.points - back.points;
    if (due <= 0) return 0;
    const basis = Number((earned.metadata as any)?.basisCents ?? 0);
    const taken = await this.applyChange(tenantId, earned.programId, earned.memberId, earned.member.clientId, {
      type: "reversal",
      points: -due,
      source: "pos_sale",
      sourceId: saleId,
      description: "Devolución de la compra",
      metadata: { posSaleId: saleId },
      shortfall: "allowNegative",
    }, -Math.max(0, basis - back.cents));
    return taken ?? 0;
  }

  /**
   * A partial refund (the payment stays paid) takes back its share of the
   * points (takeBackRefund). The points spent on the sale stay spent: the
   * sale still stands.
   */
  async onPartialRefund(
    tenantId: string,
    payment: { id: string; type?: string | null; appointmentId?: string | null; metadata?: unknown },
    refund: { id: string; amount: number },
  ): Promise<number> {
    return this.takeBackRefund(tenantId, payment, refund, "Devolución parcial");
  }

  /**
   * One refund takes back its share of the points of what the refunded
   * payment paid for, and nothing else:
   *
   *   - a visit's row (appointmentId): that visit's points;
   *   - a sale's own row (no appointment): the points the sale's own lines
   *     earned (earnForSale), products included;
   *   - the row that paid for a gift card sold: nothing, it earned nothing.
   *
   * Its share is points x refunded / the cents that earned them, rounded,
   * never more than is left to take back of it (so a later full refund
   * takes back only what remains). When she has spent the points already,
   * the balance goes negative ("allowNegative"): it used to stop at zero,
   * and earn, spend, refund kept the reward for free. One ledger entry per
   * refund (source "refund", the refund's id: a retry is a no-op).
   */
  private async takeBackRefund(
    tenantId: string,
    payment: { id: string; type?: string | null; appointmentId?: string | null; metadata?: unknown },
    refund: { id: string; amount: number },
    description: string,
  ): Promise<number> {
    if (!(refund.amount > 0)) return 0;
    const saleId = ((payment.metadata ?? {}) as { posSaleId?: string }).posSaleId;
    const of = payment.appointmentId
      ? { source: "appointment", sourceId: payment.appointmentId, key: { appointmentId: payment.appointmentId } }
      : saleId && payment.type !== "gift_card"
        ? { source: "pos_sale", sourceId: saleId, key: { posSaleId: saleId } }
        : null;
    if (!of) return 0;
    const earned = await this.prisma.loyaltyTransaction.findFirst({
      where: { tenantId, type: "earn", source: of.source, sourceId: of.sourceId },
      include: { member: { select: { clientId: true } } },
    });
    if (!earned || earned.points <= 0) return 0;
    // A visit already reversed in full (cancelled, refunded) has nothing left to take.
    if (of.source === "appointment") {
      const whole = await this.prisma.loyaltyTransaction.findFirst({
        where: { memberId: earned.memberId, type: "reversal", source: "appointment", sourceId: of.sourceId },
        select: { id: true },
      });
      if (whole) return 0;
    }
    const basis = Number((earned.metadata as any)?.basisCents ?? 0);
    if (!(basis > 0)) return 0;
    const share = Math.round((earned.points * Math.min(refund.amount, basis)) / basis);
    const back = await this.takenBackByRefunds(earned.memberId, of.key);
    const due = Math.min(share, earned.points - back.points);
    if (due <= 0) return 0;
    const taken = await this.applyChange(tenantId, earned.programId, earned.memberId, earned.member.clientId, {
      type: "reversal",
      points: -due,
      source: "refund",
      sourceId: refund.id,
      description,
      metadata: { ...of.key, paymentId: payment.id, refundCents: refund.amount },
      shortfall: "allowNegative",
    }, -Math.min(refund.amount, basis));
    return taken ?? 0;
  }

  // ------------------------------------------------------------ redemption

  /**
   * Spends a member's points on a reward at the till and returns the
   * discount to take off the ticket, in cents. Throws, spending nothing,
   * when the client cannot use that reward.
   */
  async redeemAtSale(
    tenantId: string,
    args: {
      clientId?: string | null;
      rewardId: string;
      saleId: string;
      items: SaleItem[];
      subtotalCents: number;
      appointmentId?: string | null;
      actorId?: string | null;
    },
  ): Promise<{
    discountCents: number;
    pointsSpent: number;
    rewardName: string;
    redemptionId: string;
    /** A product or "otro regalo" handed over: the till records it as a zero-price line (RewardGift). */
    gift: RewardGift | null;
  }> {
    const { program, member, reward, discountCents } = await this.checkRedemption(tenantId, args);
    // The reward's limit, claimed in one conditional write: two tills
    // redeeming its last use at once cannot both get it (the check above
    // and a separate increment used to let both through).
    const { count } = await this.prisma.loyaltyReward.updateMany({
      where: {
        id: reward.id,
        OR: [
          { maxRedemptions: null },
          { currentRedemptions: { lt: this.prisma.loyaltyReward.fields.maxRedemptions } },
        ],
      },
      data: { currentRedemptions: { increment: 1 } },
    });
    if (count !== 1) throw new BadRequestException("Esta recompensa ya no está disponible");
    try {
      await this.applyChange(tenantId, program.id, member.id, args.clientId as string, {
        type: "redeem",
        points: -reward.pointsCost,
        source: "pos_sale",
        sourceId: args.saleId,
        description: `Canje: ${reward.name}`,
        metadata: { rewardId: reward.id, discountCents },
        actorId: args.actorId,
        shortfall: "strict",
      });
    } catch (err) {
      // No points spent: the use claimed goes back.
      await this.prisma.loyaltyReward.updateMany({
        where: { id: reward.id, currentRedemptions: { gt: 0 } },
        data: { currentRedemptions: { decrement: 1 } },
      });
      throw err;
    }
    const redemption = await this.prisma.loyaltyRedemption.create({
      data: {
        memberId: member.id,
        rewardId: reward.id,
        pointsSpent: reward.pointsCost,
        valueReceived: discountCents,
        status: "completed",
        usedAt: new Date(),
        appointmentId: args.appointmentId ?? null,
        posSaleId: args.saleId,
      },
    });
    return {
      discountCents,
      pointsSpent: reward.pointsCost,
      rewardName: reward.name,
      redemptionId: redemption.id,
      gift: giftOf(reward),
    };
  }

  /**
   * What a reward would take off a ticket, checked like redeemAtSale but
   * spending nothing: the till's quote (POST /pos/quote).
   */
  async previewSaleDiscount(
    tenantId: string,
    args: { clientId?: string | null; rewardId: string; items: SaleItem[]; subtotalCents: number },
  ): Promise<{ discountCents: number; pointsSpent: number; rewardName: string }> {
    const { reward, discountCents } = await this.checkRedemption(tenantId, args);
    return { discountCents, pointsSpent: reward.pointsCost, rewardName: reward.name };
  }

  /** Throws when the client cannot use the reward now; else what it takes off. */
  private async checkRedemption(
    tenantId: string,
    args: { clientId?: string | null; rewardId: string; items: SaleItem[]; subtotalCents: number },
  ) {
    if (!args.clientId) throw new BadRequestException("Elige el cliente para canjear sus puntos");
    const program = await this.activeProgram(tenantId);
    if (!program) throw new BadRequestException("El programa de fidelización no está activo");
    const member = await this.prisma.loyaltyMember.findUnique({
      where: { clientId_programId: { clientId: args.clientId, programId: program.id } },
    });
    if (!member) throw new BadRequestException("El cliente no es socio del programa de fidelización");
    const reward = await this.prisma.loyaltyReward.findFirst({
      where: { id: args.rewardId, programId: program.id, isActive: true },
    });
    if (!reward) throw new NotFoundException("Recompensa no encontrada o desactivada");
    // A negative balance (a refund took back points already spent) is a
    // debt: her next visits pay it off before she can redeem again.
    if (member.currentPoints < 0) {
      throw new BadRequestException(
        `Tiene un saldo de puntos negativo (${member.currentPoints}): no puede canjear hasta recuperarlo con sus próximas visitas`,
      );
    }
    if (reward.expiresAt && reward.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException("Esta recompensa ha caducado");
    }
    if (reward.maxRedemptions != null && reward.currentRedemptions >= reward.maxRedemptions) {
      throw new BadRequestException("Esta recompensa ya no está disponible");
    }
    if (member.currentPoints < program.minPointsRedemption) {
      throw new BadRequestException(
        `Hacen falta al menos ${program.minPointsRedemption} puntos para canjear (tiene ${member.currentPoints})`,
      );
    }
    if (member.currentPoints < reward.pointsCost) {
      throw new BadRequestException(
        `Puntos insuficientes: la recompensa cuesta ${reward.pointsCost} y tiene ${member.currentPoints}`,
      );
    }
    const discountCents = this.discountFor(reward, args.items, args.subtotalCents);
    return { program, member, reward, discountCents };
  }

  /** Gives back the points spent on a sale (it failed, or was refunded). */
  async cancelSaleRedemption(tenantId: string, saleId: string, reason: string): Promise<void> {
    const spent = await this.prisma.loyaltyTransaction.findFirst({
      where: { tenantId, type: "redeem", source: "pos_sale", sourceId: saleId },
      include: { member: { select: { clientId: true } } },
    });
    if (!spent) return;
    const restored = await this.applyChange(tenantId, spent.programId, spent.memberId, spent.member.clientId, {
      type: "redeem_reversal",
      points: -spent.points,
      source: "pos_sale",
      sourceId: saleId,
      description: reason,
    });
    if (restored === null) return;
    const redemptions = await this.prisma.loyaltyRedemption.findMany({
      where: { posSaleId: saleId, memberId: spent.memberId, status: { not: "cancelled" } },
      select: { id: true, rewardId: true },
    });
    for (const r of redemptions) {
      await this.prisma.loyaltyRedemption.update({ where: { id: r.id }, data: { status: "cancelled" } });
      await this.prisma.loyaltyReward.updateMany({
        where: { id: r.rewardId, currentRedemptions: { gt: 0 } },
        data: { currentRedemptions: { decrement: 1 } },
      });
    }
  }

  /** How much a reward takes off a ticket, in cents, never more than the ticket. */
  discountFor(
    reward: { type: string; name: string; discountPercent: number | null; discountAmount: number | null; freeServiceId: string | null },
    items: SaleItem[],
    subtotalCents: number,
  ): number {
    let discount = 0;
    if (reward.type === "discount") {
      if (reward.discountPercent && reward.discountPercent > 0) {
        discount = Math.round((subtotalCents * reward.discountPercent) / 100);
      } else if (reward.discountAmount && reward.discountAmount > 0) {
        discount = reward.discountAmount;
      }
    } else if (reward.type === "free_service") {
      const item = items.find((i) => i.serviceId && i.serviceId === reward.freeServiceId);
      if (!item) {
        throw new BadRequestException(`"${reward.name}" regala un servicio que no está en el ticket`);
      }
      discount = item.price;
    }
    // product / voucher: handed over at the desk, nothing comes off the ticket.
    return Math.max(0, Math.min(discount, subtotalCents));
  }

  // ----------------------------------------------------------------- sweep

  /**
   * Safety net. The hooks run on the paths the panel uses; a visit completed
   * or paid some other way (a Stripe webhook, the copilot, a bulk edit) is
   * picked up here. Idempotent, so re-running it is harmless.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async sweepRecentAppointments(): Promise<{ settled: number; reversed: number }> {
    const since = new Date(Date.now() - SWEEP_LOOKBACK_MS);
    let settled = 0;
    let reversed = 0;
    try {
      const completed = await this.prisma.appointment.findMany({
        where: {
          status: "completed",
          updatedAt: { gte: since },
          // Paid in full, with money recorded (settleAppointment).
          paymentStatus: "paid",
          payments: { some: { status: "paid" } },
          tenant: { loyaltyPrograms: { some: { isActive: true } } },
        },
        select: { id: true, tenantId: true },
        take: SWEEP_BATCH,
      });
      const done = await this.settledIds(completed.map((a) => a.id), "earn");
      for (const a of completed) {
        if (done.has(a.id)) continue;
        const r = await this.settleAppointment(a.tenantId, a.id).catch(() => null);
        if (r?.awarded) settled++;
      }
      const undone = await this.prisma.appointment.findMany({
        where: {
          updatedAt: { gte: since },
          OR: [{ status: "cancelled" }, { paymentStatus: "refunded" }],
          tenant: { loyaltyPrograms: { some: {} } },
        },
        select: { id: true, tenantId: true },
        take: SWEEP_BATCH,
      });
      const earned = await this.settledIds(undone.map((a) => a.id), "earn");
      const alreadyBack = await this.settledIds(undone.map((a) => a.id), "reversal");
      for (const a of undone) {
        if (!earned.has(a.id) || alreadyBack.has(a.id)) continue;
        const n = await this.reverseAppointment(a.tenantId, a.id, "Cita cancelada").catch(() => 0);
        if (n) reversed++;
      }
    } catch (err) {
      this.logger.warn(`loyalty sweep failed: ${(err as Error).message}`);
    }
    if (settled || reversed) this.logger.log(`loyalty sweep: settled=${settled} reversed=${reversed}`);
    return { settled, reversed };
  }

  // ---------------------------------------------------------------- expiry

  /**
   * Points expire after `pointsExpirationDays` (12 months by default) with
   * no paid visit or purchase (owner decision 2026-11-02; audit L8: they
   * never did). Once a day per salon, from 03:00 in its timezone (the
   * hourly ticks before that, and after the day's run, find nothing): every
   * member whose last visit is before the day's cutoff loses the whole
   * balance, as one "Caducidad" ledger entry keyed by member and salon day,
   * so a second tick or a second instance is a no-op. Nothing expires
   * during the grace (pointsExpiryStartsAt: deploy + 30 days, or 30 days
   * after the salon switched expiry on or shortened it).
   */
  @Cron("0 20 * * * *")
  async expireInactivePoints(now: Date = new Date()): Promise<{ members: number; points: number }> {
    let members = 0;
    let points = 0;
    try {
      const programs = await this.prisma.loyaltyProgram.findMany({
        where: {
          isActive: true,
          pointsExpirationDays: { not: null },
          OR: [{ pointsExpiryStartsAt: null }, { pointsExpiryStartsAt: { lte: now } }],
        },
        select: { id: true, tenantId: true, pointsExpirationDays: true, tenant: { select: { timezone: true } } },
      });
      for (const program of programs) {
        try {
          const out = await this.expireProgram(program, now);
          members += out.members;
          points += out.points;
        } catch (err) {
          this.logger.warn(`loyalty expiry of programme ${program.id} failed: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      this.logger.warn(`loyalty expiry failed: ${(err as Error).message}`);
    }
    if (members) this.logger.log(`loyalty expiry: ${members} member(s), ${points} point(s)`);
    return { members, points };
  }

  private async expireProgram(
    program: { id: string; tenantId: string; pointsExpirationDays: number | null; tenant?: { timezone: string | null } | null },
    now: Date,
  ): Promise<{ members: number; points: number }> {
    const days = program.pointsExpirationDays;
    if (!days || days <= 0) return { members: 0, points: 0 };
    const run = expiryRun(now, program.tenant?.timezone, days);
    if (!run) return { members: 0, points: 0 };
    // The plan no longer includes loyalty: the salon cannot see or use the
    // points, so they are not taken either.
    const unlocked = await this.flags.isFeatureUnlocked(program.tenantId, "loyalty").catch(() => false);
    if (!unlocked) return { members: 0, points: 0 };

    const inactive = {
      programId: program.id,
      currentPoints: { gt: 0 },
      OR: [
        { pointsRenewedAt: { lt: run.cutoff } },
        { pointsRenewedAt: null, joinedAt: { lt: run.cutoff } },
      ],
    };
    let members = 0;
    let points = 0;
    let after: string | undefined;
    for (;;) {
      const batch = await this.prisma.loyaltyMember.findMany({
        where: { ...inactive, ...(after ? { id: { gt: after } } : {}) },
        select: { id: true, clientId: true, currentPoints: true, pointsRenewedAt: true, joinedAt: true },
        orderBy: { id: "asc" },
        take: MEMBER_BATCH,
      });
      if (batch.length === 0) break;
      after = batch[batch.length - 1].id;
      for (const m of batch) {
        const taken = await this.expireMember(program.tenantId, program.id, m, run, days).catch((err) => {
          this.logger.warn(`loyalty expiry of member ${m.id} failed: ${(err as Error).message}`);
          return 0;
        });
        if (taken > 0) {
          members++;
          points += taken;
        }
      }
      if (batch.length < MEMBER_BATCH) break;
    }
    return { members, points };
  }

  /**
   * One member's balance expires: the ledger entry (unique per member and
   * day) and the zero balance in one transaction, the balance written only
   * if it is still what was read and she has still not been back (a visit
   * or a sale in between wins). Returns the points taken, 0 if none.
   */
  private async expireMember(
    tenantId: string,
    programId: string,
    m: { id: string; clientId: string; currentPoints: number; pointsRenewedAt: Date | null; joinedAt: Date },
    run: { day: string; cutoff: Date },
    days: number,
  ): Promise<number> {
    const balance = m.currentPoints;
    if (!(balance > 0)) return 0;
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.loyaltyTransaction.create({
          data: {
            tenantId,
            programId,
            memberId: m.id,
            type: "expire",
            points: -balance,
            source: "expiry",
            sourceId: run.day,
            description: "Caducidad",
            metadata: {
              days,
              lastVisitAt: new Date(m.pointsRenewedAt ?? m.joinedAt).toISOString(),
            } as Prisma.InputJsonValue,
          },
        });
        const { count } = await tx.loyaltyMember.updateMany({
          where: {
            id: m.id,
            currentPoints: balance,
            OR: [{ pointsRenewedAt: { lt: run.cutoff } }, { pointsRenewedAt: null, joinedAt: { lt: run.cutoff } }],
          },
          // Expiry is not activity, and the points accumulated (the level) stay.
          data: { currentPoints: 0 },
        });
        if (count !== 1) throw new ExpiryRaced();
        await tx.client.update({ where: { id: m.clientId }, data: { loyaltyPoints: 0 } });
        return balance;
      });
    } catch (err) {
      // Done today already, or she came back meanwhile: nothing to take.
      if (isDuplicate(err) || err instanceof ExpiryRaced) return 0;
      throw err;
    }
  }

  // -------------------------------------------------------------- internals

  /** Which of these appointments already have a movement of this type. */
  private async settledIds(appointmentIds: string[], type: TxType): Promise<Set<string>> {
    if (appointmentIds.length === 0) return new Set();
    const rows = await this.prisma.loyaltyTransaction.findMany({
      where: { type, source: "appointment", sourceId: { in: appointmentIds } },
      select: { sourceId: true },
    });
    return new Set(rows.map((r) => r.sourceId as string));
  }

  /** Whether the salon's plan includes loyalty (the receipt's points block asks). */
  isUnlocked(tenantId: string): Promise<boolean> {
    return this.flags.isFeatureUnlocked(tenantId, "loyalty").catch(() => false);
  }

  /** The programme, if the salon has one switched on and its plan includes it. */
  private async activeProgram(tenantId: string) {
    const program = await this.prisma.loyaltyProgram.findFirst({ where: { tenantId, isActive: true } });
    if (!program) return null;
    const unlocked = await this.flags.isFeatureUnlocked(tenantId, "loyalty").catch(() => false);
    return unlocked ? program : null;
  }

  /** The client's membership, signing them up first when the salon auto-enrols. */
  private async memberForEarning(
    tenantId: string,
    program: { id: string; autoEnroll: boolean; welcomePoints: number },
    clientId: string,
  ) {
    const find = () =>
      this.prisma.loyaltyMember.findUnique({
        where: { clientId_programId: { clientId, programId: program.id } },
        include: { tier: { select: { pointsMultiplier: true } } },
      });
    const existing = await find();
    if (existing) return existing.status === "active" ? existing : null;
    if (!program.autoEnroll) return null;
    await this.enrollInProgram(tenantId, program, clientId, "auto");
    return find();
  }

  private pointsFor(
    program: { earnMode: string; pointsPerEuro: number; pointsPerVisit: number },
    basisCents: number,
    multiplier: number,
  ): number {
    const m = multiplier > 0 ? multiplier : 1;
    if (program.earnMode === "per_visit") return Math.floor(program.pointsPerVisit * m);
    return Math.floor((basisCents / 100) * program.pointsPerEuro * m);
  }

  /**
   * Renews the member's points from `at` (a paid visit or purchase): the
   * later of what is stored and `at`, so an old visit settled late never
   * moves it back.
   */
  private async renewMember(memberId: string, at: Date): Promise<void> {
    await this.prisma.loyaltyMember.updateMany({
      where: { id: memberId, OR: [{ pointsRenewedAt: null }, { pointsRenewedAt: { lt: at } }] },
      data: { pointsRenewedAt: at },
    });
  }

  /** renewMember for a client who is a member already (no sign-up). */
  private async renewExisting(programId: string, clientId: string, at: Date): Promise<void> {
    const member = await this.prisma.loyaltyMember.findUnique({
      where: { clientId_programId: { clientId, programId } },
      select: { id: true },
    });
    if (member) await this.renewMember(member.id, at);
  }

  /**
   * Records one movement and updates the member's counters in a single
   * transaction. Returns the points moved, or null when this exact movement
   * was recorded before. `spentCents` keeps the member's total spend in
   * step with earn/reversal.
   */
  private async applyChange(
    tenantId: string,
    programId: string,
    memberId: string,
    clientId: string,
    change: PointsChange,
    spentCents = 0,
  ): Promise<number | null> {
    const mayGoNegative = change.shortfall === "allowNegative";
    try {
      return await this.prisma.$transaction(async (tx) => {
        const points = change.points;
        if (points < 0 && !mayGoNegative) {
          const m = await tx.loyaltyMember.findUnique({ where: { id: memberId }, select: { currentPoints: true } });
          const balance = m?.currentPoints ?? 0;
          if (-points > balance) {
            throw new BadRequestException(`Puntos insuficientes (tiene ${balance})`);
          }
        }
        await tx.loyaltyTransaction.create({
          data: {
            tenantId,
            programId,
            memberId,
            type: change.type,
            points,
            source: change.source,
            sourceId: change.sourceId,
            description: change.description,
            metadata: (change.metadata ?? {}) as Prisma.InputJsonValue,
            createdById: change.actorId ?? null,
          },
        });

        const data: Prisma.LoyaltyMemberUpdateInput = {
          currentPoints: { increment: points },
          lastActivityAt: new Date(),
        };
        if (change.type === "earn" || change.type === "welcome" || change.type === "reversal" || (change.type === "adjust" && points > 0)) {
          data.lifetimePoints = { increment: points };
          data.totalEarned = { increment: points };
        }
        if (change.type === "redeem" || change.type === "redeem_reversal") {
          data.totalRedeemed = { increment: -points };
        }
        if (spentCents) data.totalSpent = { increment: spentCents / 100 };
        const updated = await tx.loyaltyMember.update({ where: { id: memberId }, data });

        // Strict debits are re-checked after the write: two tills spending
        // the same points at once cannot both succeed. Only a reversal may
        // leave the balance below zero.
        if (points < 0 && !mayGoNegative && updated.currentPoints < 0) {
          throw new BadRequestException("Puntos insuficientes");
        }

        // The client record carries a copy that campaigns and lists read.
        await tx.client.update({ where: { id: clientId }, data: { loyaltyPoints: updated.currentPoints } });

        await this.raiseTier(tx, programId, updated);
        return points;
      });
    } catch (err) {
      if (isDuplicate(err)) return null;
      throw err;
    }
  }

  /**
   * Levels never go down (owner decision 2026-11-02). The level follows the
   * most points the member ever accumulated (peakLifetimePoints, kept
   * here): an earning can raise it; a reversal, a negative adjustment or a
   * level edited since never lowers it (#219 recalculated it both ways, and
   * could leave a member with none).
   */
  private async raiseTier(
    tx: Prisma.TransactionClient,
    programId: string,
    member: { id: string; lifetimePoints: number; peakLifetimePoints?: number | null; tierId: string | null },
  ): Promise<void> {
    const peak = Math.max(member.peakLifetimePoints ?? 0, member.lifetimePoints);
    if (peak !== (member.peakLifetimePoints ?? 0)) {
      await tx.loyaltyMember.update({ where: { id: member.id }, data: { peakLifetimePoints: peak } });
    }
    const reached = await tx.loyaltyTier.findFirst({
      where: { programId, minPoints: { lte: peak } },
      orderBy: { minPoints: "desc" },
      select: { id: true, minPoints: true },
    });
    if (!reached || reached.id === member.tierId) return;
    if (member.tierId) {
      const current = await tx.loyaltyTier.findUnique({ where: { id: member.tierId }, select: { minPoints: true } });
      if (current && current.minPoints >= reached.minPoints) return;
    }
    await tx.loyaltyMember.update({ where: { id: member.id }, data: { tierId: reached.id } });
  }
}
