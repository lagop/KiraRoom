import {
  BadRequestException,
  ForbiddenException,
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
} from "./loyalty.dto";

type TxType = "earn" | "redeem" | "reversal" | "redeem_reversal" | "welcome" | "adjust";

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
   * For a negative change: "strict" refuses when the balance is short (a
   * redemption), "clamp" takes what is there (a reversal after the client
   * already spent the points: the balance never goes below zero).
   */
  shortfall?: "strict" | "clamp";
}

export interface SaleItem {
  serviceId?: string;
  price: number;
  quantity: number;
}

const HISTORY_LIMIT = 30;
const SWEEP_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;
const SWEEP_BATCH = 1000;

/** A Prisma unique-constraint violation: the change was applied before. */
function isDuplicate(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  ) || (err as any)?.code === "P2002";
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
    };
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
    return this.prisma.loyaltyReward.create({
      data: {
        programId: program.id,
        name: dto.name,
        description: dto.description,
        type: dto.type,
        pointsCost: dto.pointsCost,
        discountPercent: dto.discountPercent ?? null,
        discountAmount: dto.discountAmount ?? null,
        freeServiceId: dto.freeServiceId ?? null,
        isActive: dto.isActive ?? true,
      },
    });
  }

  async updateReward(tenantId: string, id: string, dto: UpdateLoyaltyRewardDto) {
    const reward = await this.ownReward(tenantId, id);
    await this.checkFreeService(tenantId, dto.type ?? reward.type, dto.freeServiceId ?? reward.freeServiceId);
    return this.prisma.loyaltyReward.update({
      where: { id },
      data: {
        name: dto.name,
        description: dto.description,
        type: dto.type,
        pointsCost: dto.pointsCost,
        discountPercent: dto.discountPercent,
        discountAmount: dto.discountAmount,
        freeServiceId: dto.freeServiceId,
        isActive: dto.isActive,
      },
    });
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

  private async checkFreeService(tenantId: string, type: string, serviceId?: string | null) {
    if (type !== "free_service") return;
    if (!serviceId) throw new BadRequestException("Elige el servicio que regala la recompensa");
    const service = await this.prisma.service.findFirst({ where: { id: serviceId, tenantId } });
    if (!service) throw new BadRequestException("Ese servicio no es de este salón");
  }

  async createTier(tenantId: string, dto: LoyaltyTierDto) {
    const program = await this.requireProgram(tenantId);
    return this.prisma.loyaltyTier.create({
      data: {
        programId: program.id,
        name: dto.name,
        minPoints: dto.minPoints,
        pointsMultiplier: dto.pointsMultiplier,
      },
    });
  }

  async deleteTier(tenantId: string, id: string) {
    const tier = await this.prisma.loyaltyTier.findFirst({ where: { id, program: { tenantId } } });
    if (!tier) throw new NotFoundException("Nivel no encontrado");
    await this.prisma.loyaltyTier.delete({ where: { id } });
    return { ok: true };
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
          data: { clientId, programId: program.id, enrolledVia: via },
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
      member,
      rewards: rewards.map((r) => ({
        ...r,
        redeemable:
          !!member &&
          program.isActive &&
          member.currentPoints >= r.pointsCost &&
          member.currentPoints >= program.minPointsRedemption,
      })),
      history,
    };
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

  // ------------------------------------------------------------ the portal

  /** What a signed-in client sees in their portal. */
  async portalView(tenantId: string, clientId: string) {
    const program = await this.activeProgram(tenantId);
    if (!program) return { enabled: false as const };
    const member = await this.prisma.loyaltyMember.findUnique({
      where: { clientId_programId: { clientId, programId: program.id } },
      include: { tier: { select: { name: true } } },
    });
    const [rewards, history] = await Promise.all([
      this.prisma.loyaltyReward.findMany({
        where: { programId: program.id, isActive: true },
        orderBy: { pointsCost: "asc" },
        select: { id: true, name: true, description: true, type: true, pointsCost: true },
      }),
      member
        ? this.prisma.loyaltyTransaction.findMany({
            where: { memberId: member.id },
            orderBy: { createdAt: "desc" },
            take: HISTORY_LIMIT,
            select: { id: true, createdAt: true, type: true, points: true, description: true },
          })
        : Promise.resolve([]),
    ]);
    return {
      enabled: true as const,
      program: {
        name: program.name,
        description: program.description,
        earnMode: program.earnMode,
        pointsPerEuro: program.pointsPerEuro,
        pointsPerVisit: program.pointsPerVisit,
        minPointsRedemption: program.minPointsRedemption,
        welcomePoints: program.welcomePoints,
        allowSelfEnroll: program.allowSelfEnroll,
      },
      member: member
        ? {
            currentPoints: member.currentPoints,
            lifetimePoints: member.lifetimePoints,
            joinedAt: member.joinedAt,
            tier: member.tier?.name ?? null,
          }
        : null,
      rewards,
      history,
    };
  }

  async portalJoin(tenantId: string, clientId: string) {
    const program = await this.activeProgram(tenantId);
    if (!program) throw new BadRequestException("Este salón no tiene programa de fidelización activo");
    if (!program.allowSelfEnroll) {
      throw new ForbiddenException("El salón da de alta a los socios en el mostrador");
    }
    await this.enrollInProgram(tenantId, program, clientId, "portal");
    return this.portalView(tenantId, clientId);
  }

  // --------------------------------------------------------------- earning

  /**
   * An appointment earns once it is both completed and paid. Called after
   * every change that can make that true; does nothing until it is, and
   * nothing the second time.
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
        service: { select: { price: true } },
        payments: { where: { status: "paid" }, select: { amount: true, method: true } },
      },
    });
    if (!apt?.clientId || apt.status !== "completed") return null;
    const moneyRows = (apt.payments ?? []).filter((p) => p.method !== "loyalty_points");
    const paid = apt.paymentStatus === "paid" || moneyRows.length > 0;
    if (!paid) return null;

    const member = await this.memberForEarning(tenantId, program, apt.clientId);
    if (!member) return null;

    let basis = Number(apt.amountPaid ?? 0);
    if (!(basis > 0)) basis = moneyRows.reduce((s, p) => s + p.amount, 0);
    if (!(basis > 0)) basis = Number(apt.totalAmount ?? 0);
    if (!(basis > 0)) basis = Math.round(Number(apt.service?.price ?? 0) * 100);
    // The part paid with points is not money spent: it earns nothing.
    const discounted = await this.prisma.loyaltyRedemption.aggregate({
      where: { appointmentId, status: { not: "cancelled" } },
      _sum: { valueReceived: true },
    });
    basis = Math.max(0, Math.round(basis - (discounted._sum.valueReceived ?? 0)));

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

  /** A cancelled or refunded appointment gives its points back. */
  async reverseAppointment(tenantId: string, appointmentId: string, reason: string): Promise<number> {
    const earned = await this.prisma.loyaltyTransaction.findFirst({
      where: { tenantId, type: "earn", source: "appointment", sourceId: appointmentId },
      include: { member: { select: { clientId: true } } },
    });
    if (!earned) return 0;
    const basis = Number((earned.metadata as any)?.basisCents ?? 0);
    const taken = await this.applyChange(tenantId, earned.programId, earned.memberId, earned.member.clientId, {
      type: "reversal",
      points: -earned.points,
      source: "appointment",
      sourceId: appointmentId,
      description: reason,
      shortfall: "clamp",
    }, -basis);
    return taken ?? 0;
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
   * A refunded payment takes back what it earned: the whole visit for an
   * appointment, its share of the ticket for a till sale. When every
   * payment of a sale is refunded, the points spent on it come back too.
   */
  async onPaymentRefunded(
    tenantId: string,
    payment: { id: string; amount: number; appointmentId?: string | null; metadata?: unknown },
  ): Promise<void> {
    if (payment.appointmentId) {
      await this.reverseAppointment(tenantId, payment.appointmentId, "Devolución del pago de la cita");
    }
    const meta = (payment.metadata ?? {}) as { posSaleId?: string; appointmentIds?: string[] };
    for (const appointmentId of meta.appointmentIds ?? []) {
      await this.reverseAppointment(tenantId, appointmentId, "Devolución del pago de la cita");
    }
    const saleId = meta.posSaleId;
    if (!saleId) return;

    const earned = await this.prisma.loyaltyTransaction.findFirst({
      where: { tenantId, type: "earn", source: "pos_sale", sourceId: saleId },
      include: { member: { select: { clientId: true } } },
    });
    if (earned) {
      const basis = Number((earned.metadata as any)?.basisCents ?? 0);
      const share = basis > 0 ? Math.round((earned.points * payment.amount) / basis) : earned.points;
      const previous = await this.prisma.loyaltyTransaction.findMany({
        where: {
          memberId: earned.memberId,
          type: "reversal",
          source: "payment",
          metadata: { path: ["posSaleId"], equals: saleId },
        },
        select: { points: true },
      });
      const alreadyBack = previous.reduce((s, t) => s - t.points, 0);
      const due = Math.min(share, earned.points - alreadyBack);
      if (due > 0) {
        await this.applyChange(tenantId, earned.programId, earned.memberId, earned.member.clientId, {
          type: "reversal",
          points: -due,
          source: "payment",
          sourceId: payment.id,
          description: "Devolución de la compra",
          metadata: { posSaleId: saleId },
          shortfall: "clamp",
        }, -Math.min(payment.amount, basis));
      }
    }

    const stillPaid = await this.prisma.payment.count({
      where: { tenantId, status: "paid", metadata: { path: ["posSaleId"], equals: saleId } },
    });
    if (stillPaid === 0) await this.cancelSaleRedemption(tenantId, saleId, "Devolución de la compra");
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
  ): Promise<{ discountCents: number; pointsSpent: number; rewardName: string; redemptionId: string }> {
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

    await this.applyChange(tenantId, program.id, member.id, args.clientId, {
      type: "redeem",
      points: -reward.pointsCost,
      source: "pos_sale",
      sourceId: args.saleId,
      description: `Canje: ${reward.name}`,
      metadata: { rewardId: reward.id, discountCents },
      actorId: args.actorId,
      shortfall: "strict",
    });
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
    await this.prisma.loyaltyReward.update({
      where: { id: reward.id },
      data: { currentRedemptions: { increment: 1 } },
    });
    return { discountCents, pointsSpent: reward.pointsCost, rewardName: reward.name, redemptionId: redemption.id };
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
          OR: [{ paymentStatus: "paid" }, { payments: { some: { status: "paid" } } }],
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
   * Records one movement and updates the member's counters in a single
   * transaction. Returns the points actually moved (a clamped reversal can
   * move fewer), or null when this exact movement was recorded before.
   * `spentCents` keeps the member's total spend in step with earn/reversal.
   */
  private async applyChange(
    tenantId: string,
    programId: string,
    memberId: string,
    clientId: string,
    change: PointsChange,
    spentCents = 0,
  ): Promise<number | null> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        let points = change.points;
        if (points < 0) {
          const m = await tx.loyaltyMember.findUnique({ where: { id: memberId }, select: { currentPoints: true } });
          const balance = m?.currentPoints ?? 0;
          if (-points > balance) {
            if (change.shortfall === "strict") {
              throw new BadRequestException(`Puntos insuficientes (tiene ${balance})`);
            }
            points = -balance;
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
        // the same points at once cannot both succeed.
        if (updated.currentPoints < 0) {
          throw new BadRequestException("Puntos insuficientes");
        }

        // The client record carries a copy that campaigns and lists read.
        await tx.client.update({ where: { id: clientId }, data: { loyaltyPoints: updated.currentPoints } });

        if (points > 0) {
          const tier = await tx.loyaltyTier.findFirst({
            where: { programId, minPoints: { lte: updated.lifetimePoints } },
            orderBy: { minPoints: "desc" },
            select: { id: true },
          });
          if ((tier?.id ?? null) !== (updated.tierId ?? null) && tier) {
            await tx.loyaltyMember.update({ where: { id: memberId }, data: { tierId: tier.id } });
          }
        }
        return points;
      });
    } catch (err) {
      if (isDuplicate(err)) return null;
      throw err;
    }
  }
}
