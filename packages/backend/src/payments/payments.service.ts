import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
  Optional,
} from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import { LoyaltyService } from "../loyalty/loyalty.service";
import { AppointmentStatus, PaymentMethod, PaymentStatus, Prisma } from "@prisma/client";
import { applyStatusIfAllowed } from "../appointments/appointment-status";
import { refreshClientStats } from "../clients/client-stats";
import { salonToday } from "../analytics/analytics-metrics";
import { WalletService } from "./services/wallet.service";
import { GiftCardsService } from "../gift-cards/gift-cards.service";
import { needsTimezone, PaymentFilters, paymentWhere, PAYMENT_SORT_FIELDS } from "./payments-query";
import { openCashSessionId } from "../pos/cash-session-lock";

const euros = (cents: number) =>
  new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(cents / 100);

/** What a list row carries: its client, its appointment and what was refunded of it. */
const LIST_INCLUDE = {
  client: { select: { id: true, firstName: true, lastName: true, email: true } },
  appointment: {
    select: { id: true, scheduledDate: true, status: true, service: { select: { name: true } } },
  },
  refunds: { where: { status: "succeeded" as const }, select: { amount: true } },
} satisfies Prisma.PaymentInclude;

/** Adds `refundedAmount` (cents, refunds made so far) and drops the refund rows. */
function withRefunded<P extends { refunds?: { amount: number }[] }>(payment: P) {
  const { refunds, ...rest } = payment;
  return { ...rest, refundedAmount: (refunds ?? []).reduce((s, r) => s + r.amount, 0) };
}

export interface PaymentsSummary {
  /** Paid, net of what was refunded of it, in cents. */
  totalRevenue: number;
  /** Payments matching the filters, whatever their status. */
  totalTransactions: number;
  /** Payments still pending, in cents. */
  pendingAmount: number;
  /** Money given back (refunds), in cents. */
  refundedAmount: number;
  /** Net revenue by payment method. */
  byMethod: { method: PaymentMethod; amount: number; count: number }[];
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly loyalty?: LoyaltyService,
    // A refund of a wallet payment puts the money back in the wallet.
    @Optional() private readonly wallet?: WalletService,
    // A refund of a gift card payment goes back to the card; a refunded gift card SALE comes off the card.
    @Optional() private readonly giftCards?: GiftCardsService,
  ) {}

  /**
   * Loyalty follows the money: a paid appointment earns, a refund takes the
   * points back. Never allowed to fail the payment itself; the loyalty
   * sweep retries what is missed here.
   */
  private async loyaltyAfter(
    tenantId: string,
    payment: { id: string; amount: number; status: string; appointmentId?: string | null; metadata?: unknown },
  ) {
    if (!this.loyalty) return;
    try {
      if (payment.status === "paid" && payment.appointmentId) {
        await this.loyalty.settleAppointment(tenantId, payment.appointmentId);
      } else if (payment.status === "refunded") {
        await this.loyalty.onPaymentRefunded(tenantId, payment);
      }
    } catch (err) {
      this.logger.warn(`loyalty after payment ${payment.id} failed: ${(err as Error).message}`);
    }
  }

  /**
   * A payment marks its appointment completed -- but only where the
   * appointments' transition table allows it, and only over the status just
   * read. A visit already completed stays as it is (paying after completing
   * is the usual order), and a cancelled or no-show one is not revived by a
   * fee paid on it. The payment itself is never refused for it: it is
   * already recorded by the time we get here.
   */
  private async markAppointment(appointmentId: string, to: AppointmentStatus) {
    const changed = await applyStatusIfAllowed(this.prisma as any, appointmentId, to);
    if (!changed) {
      this.logger.log(`appointment ${appointmentId} not marked ${to} by its payment: status does not allow it`);
    }
  }

  /**
   * The client's spend (and, when the payment completed her appointment,
   * her visits) follow what was recorded: client-stats.ts. Never fails the
   * payment.
   */
  private async clientStatsAfter(tenantId: string, clientId: string | null | undefined) {
    await refreshClientStats(this.prisma, tenantId, [clientId]);
  }

  /** The salon's timezone, for its calendar days (Europe/Madrid by default). */
  private async timezoneOf(tenantId: string): Promise<string> {
    try {
      const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
      return tenant?.timezone || "Europe/Madrid";
    } catch {
      return "Europe/Madrid";
    }
  }

  private async whereFor(tenantId: string, filters: PaymentFilters) {
    const timeZone = needsTimezone(filters) ? await this.timezoneOf(tenantId) : undefined;
    return paymentWhere(tenantId, filters, timeZone);
  }

  async getPayments(
    tenantId: string,
    professionalId: string | null,
    options: PaymentFilters & {
      page?: number;
      limit?: number;
      sortBy?: string;
      sortOrder?: "asc" | "desc";
    },
  ) {
    const page = Math.max(1, Math.floor(options.page ?? 1));
    const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 20)));
    const skip = (page - 1) * limit;

    const where = await this.whereFor(tenantId, { ...options, professionalId });

    const field = (PAYMENT_SORT_FIELDS as readonly string[]).includes(options.sortBy ?? "")
      ? (options.sortBy as string)
      : "createdAt";
    const order = options.sortOrder === "asc" ? "asc" : "desc";
    // The id breaks ties, so a page never repeats or skips a row.
    const orderBy: Prisma.PaymentOrderByWithRelationInput[] = [{ [field]: order }, { id: order }];

    const [payments, total] = await Promise.all([
      this.prisma.payment.findMany({ where, skip, take: limit, orderBy, include: LIST_INCLUDE }),
      this.prisma.payment.count({ where }),
    ]);

    return {
      payments: payments.map(withRefunded),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * One payment. A staff member (`professionalId`) reaches only the
   * payments of their own appointments; any other is a 404.
   */
  async getPaymentById(
    tenantId: string,
    paymentId: string,
    professionalId?: string | null,
    recordedById?: string | null,
  ) {
    const scoped = paymentWhere(tenantId, { professionalId, recordedById });
    const payment = await this.prisma.payment.findFirst({
      where: { ...scoped, id: paymentId },
      include: {
        client: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
          },
        },
        appointment: {
          select: {
            id: true,
            scheduledDate: true,
            status: true,
            service: {
              select: {
                name: true,
                price: true,
              },
            },
          },
        },
        refunds: { where: { status: "succeeded" }, select: { amount: true } },
      },
    });

    if (!payment) {
      throw new NotFoundException("Cobro no encontrado");
    }

    return withRefunded(payment);
  }

  async createPayment(
    tenantId: string,
    professionalId: string | null,
    data: {
      clientId: string;
      appointmentId?: string;
      amount: number;
      method:
        | "cash"
        | "card"
        | "bank_transfer"
        | "wallet"
        | "gift_card"
        | "loyalty_points"
        | "bizum";
      type?:
        | "appointment"
        | "deposit"
        | "product"
        | "service"
        | "gift_card"
        | "membership"
        | "other";
      status?: "pending" | "paid" | "failed" | "refunded";
      description?: string;
    },
  ) {
    const {
      clientId,
      appointmentId,
      amount,
      method,
      type = "appointment",
      status = "pending",
      description,
    } = data;

    const client = await this.prisma.client.findFirst({
      where: { id: clientId, tenantId },
    });

    if (!client) {
      throw new NotFoundException("Clienta no encontrada");
    }

    if (appointmentId) {
      const whereCondition: any = {
        id: appointmentId,
        clientId,
        tenantId,
      };

      // Si el usuario es STAFF, validar que la cita le pertenece
      if (professionalId) {
        whereCondition.professionalId = professionalId;
      }

      const appointment = await this.prisma.appointment.findFirst({
        where: whereCondition,
      });

      if (!appointment) {
        throw new NotFoundException("Cita no encontrada");
      }
    }

    const payment = await this.prisma.payment.create({
      data: {
        tenantId,
        clientId,
        appointmentId,
        amount,
        type,
        method,
        status,
        description,
      },
    });

    if (status === "paid" && appointmentId) {
      await this.markAppointment(appointmentId, AppointmentStatus.completed);
    }

    await this.loyaltyAfter(tenantId, payment);
    await this.clientStatsAfter(tenantId, clientId);

    return payment;
  }

  /**
   * The Pagos page's cards, for the same filters as its list (status
   * aside: each card is one status). They were named differently from what
   * the page read (3 of 4 cards always 0) and ignored the filters.
   */
  async getSummary(tenantId: string, filters: PaymentFilters): Promise<PaymentsSummary> {
    const where = await this.whereFor(tenantId, { ...filters, status: undefined });

    const [totalTransactions, paid, pending, legacyRefunded, refunds] = await Promise.all([
      this.prisma.payment.count({ where }),
      this.prisma.payment.groupBy({
        by: ["method"],
        where: { ...where, status: PaymentStatus.paid },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.payment.aggregate({ where: { ...where, status: PaymentStatus.pending }, _sum: { amount: true } }),
      // Refunded before refunds were recorded one by one: the whole payment.
      this.prisma.payment.aggregate({
        where: { ...where, status: PaymentStatus.refunded, refunds: { none: {} } },
        _sum: { amount: true },
      }),
      this.prisma.refund.findMany({
        where: { status: "succeeded", payment: where },
        select: { amount: true, payment: { select: { method: true, status: true } } },
      }),
    ]);

    // What was given back of payments still paid (partial refunds) comes
    // off their method's revenue.
    const partialByMethod = new Map<string, number>();
    for (const r of refunds) {
      if (r.payment.status !== PaymentStatus.paid) continue;
      partialByMethod.set(r.payment.method, (partialByMethod.get(r.payment.method) ?? 0) + r.amount);
    }
    const byMethod = paid
      .map((g) => ({
        method: g.method,
        amount: (g._sum.amount ?? 0) - (partialByMethod.get(g.method) ?? 0),
        count: g._count._all,
      }))
      .sort((a, b) => b.amount - a.amount);

    return {
      totalRevenue: byMethod.reduce((s, m) => s + m.amount, 0),
      totalTransactions,
      pendingAmount: pending._sum.amount ?? 0,
      refundedAmount: refunds.reduce((s, r) => s + r.amount, 0) + (legacyRefunded._sum.amount ?? 0),
      byMethod,
    };
  }

  /**
   * Gives back all or part of a charge taken at the salon (cash, card
   * terminal, transfer, wallet), in one transaction:
   *
   * - a `Refund` row with the amount and the reason;
   * - the payment becomes `refunded` once all of it is given back; a
   *   partial refund leaves it `paid`, the refunds saying how much;
   * - its appointment's `amountPaid` goes down by the amount (and its
   *   payment status becomes `refunded` when nothing is left paid). The
   *   visit's own status is not touched: it happened;
   * - a wallet payment's money goes back to the wallet.
   *
   * Then, once committed, a full refund takes back the loyalty points the
   * payment earned (and gives back points spent on the sale when nothing of
   * it is left paid), and the client's figures are recomputed.
   *
   * An issued invoice is not edited: the answer names it so the salon issues
   * the rectificativa (Facturas).
   *
   * No online (Stripe) payment exists on this version; one would be refused
   * here rather than marked refunded without Stripe giving the money back.
   */
  async refundPayment(
    tenantId: string,
    paymentId: string,
    input: { amount?: number; reason: string },
    actorId?: string | null,
  ) {
    const payment = await this.prisma.payment.findFirst({
      where: { id: paymentId, tenantId },
      include: { refunds: { where: { status: "succeeded" }, select: { amount: true } } },
    });
    if (!payment) throw new NotFoundException("Cobro no encontrado");
    if (payment.status === PaymentStatus.refunded) {
      throw new ConflictException("Este cobro ya está devuelto.");
    }
    if (payment.status !== PaymentStatus.paid) {
      throw new BadRequestException("Solo se puede devolver un cobro pagado.");
    }
    if (payment.stripePaymentId) {
      throw new BadRequestException("Este cobro se hizo en línea con Stripe: devuélvelo desde tu cuenta de Stripe.");
    }
    const reason = (input.reason ?? "").trim();
    if (!reason) throw new BadRequestException("Indica el motivo de la devolución.");

    const already = (payment.refunds ?? []).reduce((s, r) => s + r.amount, 0);
    const left = payment.amount - already;
    if (left <= 0) throw new ConflictException("Este cobro ya está devuelto.");
    const amount = input.amount ?? left;
    if (!Number.isInteger(amount) || amount < 1) {
      throw new BadRequestException("El importe a devolver debe ser mayor que 0.");
    }
    if (amount > left) {
      throw new BadRequestException(
        `Como máximo puedes devolver ${euros(left)} de este cobro` +
          (already > 0 ? ` (ya se devolvieron ${euros(already)}).` : "."),
      );
    }
    const full = amount === left;
    const status = full ? PaymentStatus.refunded : PaymentStatus.paid;

    const changed = () =>
      new ConflictException("El cobro acaba de cambiar. Recarga y vuelve a intentarlo.");

    const { refund, appointment } = await this.prisma.$transaction(async (tx) => {
      // Over the payment as just read: a second refund at the same time
      // finds it changed and gets a 409, so the two cannot add up past it.
      const { count } = await tx.payment.updateMany({
        where: { id: payment.id, tenantId, status: PaymentStatus.paid, updatedAt: payment.updatedAt },
        data: { status, updatedAt: new Date() },
      });
      if (count !== 1) throw changed();

      // The cash-drawer session open now (arqueo), held until this commits:
      // a cash refund comes out of that drawer, so its close counts it.
      // With the drawer closed the refund is still given (not blocked).
      const cashSessionId = await openCashSessionId(tx, tenantId, "share");
      const refund = await tx.refund.create({
        data: {
          paymentId: payment.id,
          amount,
          reason,
          status: "succeeded",
          adminId: actorId ?? null,
          ...(cashSessionId ? { cashSessionId } : {}),
        },
      });

      let appointment: { id: string; amountPaid: number; paymentStatus: PaymentStatus } | null = null;
      if (payment.appointmentId) {
        const apt = await tx.appointment.findFirst({
          where: { id: payment.appointmentId, tenantId },
          select: { id: true, amountPaid: true, paymentStatus: true },
        });
        if (apt) {
          const before = Math.round(Number(apt.amountPaid ?? 0));
          const amountPaid = Math.max(0, before - amount);
          const paymentStatus = amountPaid === 0 ? PaymentStatus.refunded : apt.paymentStatus;
          const res = await tx.appointment.updateMany({
            where: { id: apt.id, tenantId, amountPaid: apt.amountPaid },
            data: { amountPaid, paymentStatus },
          });
          if (res.count !== 1) throw changed();
          appointment = { id: apt.id, amountPaid, paymentStatus };
        }
      }

      if (payment.method === PaymentMethod.wallet && payment.clientId) {
        if (!this.wallet) throw new BadRequestException("No se puede devolver a la cartera ahora mismo.");
        await this.wallet.creditIn(tx, tenantId, payment.clientId, amount, `Devolución: ${reason}`, "refund", refund.id);
      }

      // Paid with a gift card (at the till): the money goes back to the card,
      // like a wallet payment to the wallet.
      const meta = (payment.metadata ?? {}) as { giftCardId?: string; soldGiftCardIds?: string[] };
      if (payment.method === PaymentMethod.gift_card) {
        if (!meta.giftCardId || !this.giftCards) {
          throw new BadRequestException("Este cobro con tarjeta regalo no indica la tarjeta: devuélvelo desde Tarjetas regalo.");
        }
        await this.giftCards.refundToCard(tx, {
          tenantId,
          giftCardId: meta.giftCardId,
          amountCents: amount,
          paymentId: payment.id,
          userId: actorId ?? null,
          note: `Devolución: ${reason}`,
        });
      }
      // The payment that BOUGHT a gift card: what is given back comes off the
      // card (refused when the card no longer has it: it was spent).
      if (payment.type === "gift_card" && meta.soldGiftCardIds?.length) {
        if (!this.giftCards) throw new BadRequestException("Ahora mismo no se puede devolver la venta de una tarjeta regalo.");
        let left = amount;
        for (const giftCardId of meta.soldGiftCardIds) {
          if (left <= 0) break;
          const card = await tx.giftCard.findFirst({ where: { id: giftCardId, tenantId }, select: { currentBalance: true } });
          const take = Math.min(left, card?.currentBalance ?? 0);
          if (take <= 0) continue;
          await this.giftCards.redeemInTx(tx, {
            tenantId,
            giftCardId,
            amountCents: take,
            paymentId: payment.id,
            userId: actorId ?? null,
            note: `Devolución de la venta de la tarjeta: ${reason}`,
          });
          left -= take;
        }
        if (left > 0) {
          throw new BadRequestException(
            `La tarjeta regalo ya se ha usado: solo quedan ${euros(amount - left)} en ella para devolver.`,
          );
        }
      }

      return { refund, appointment };
    });

    const updated = { ...payment, refunds: undefined, status };
    if (full) await this.loyaltyAfter(tenantId, updated);
    await this.clientStatsAfter(tenantId, payment.clientId);

    const invoice = payment.appointmentId
      ? await this.prisma.invoice.findFirst({
          where: {
            tenantId,
            sourceType: "appointment",
            sourceId: payment.appointmentId,
            status: { in: ["issued", "paid"] },
          },
          select: { id: true, series: true, number: true },
        })
      : null;

    return {
      payment: { ...updated, refundedAmount: already + amount },
      refund,
      refundedAmount: already + amount,
      refundableAmount: left - amount,
      appointment,
      invoice: invoice ? { id: invoice.id, number: `${invoice.series ?? ""}${invoice.number ?? ""}` } : null,
      rectificationNeeded: !!invoice,
    };
  }

  async deletePayment(tenantId: string, paymentId: string) {
    const payment = await this.prisma.payment.findFirst({
      where: {
        id: paymentId,
        tenantId,
      },
    });

    if (!payment) {
      throw new NotFoundException("Cobro no encontrado");
    }

    if (!["pending", "failed"].includes(payment.status)) {
      throw new BadRequestException(
        "Solo se pueden borrar cobros pendientes o fallidos. Un cobro pagado se devuelve (Reembolsar).",
      );
    }

    await this.prisma.payment.delete({
      where: { id: paymentId },
    });

    return { success: true };
  }

  /** Today's payments, today being the salon's calendar day. */
  async getTodayPayments(tenantId: string, professionalId: string | null, recordedById?: string | null) {
    const timeZone = await this.timezoneOf(tenantId);
    const today = salonToday(timeZone);
    const where = paymentWhere(tenantId, { dateFrom: today, dateTo: today, professionalId, recordedById }, timeZone);

    const payments = await this.prisma.payment.findMany({
      where,
      include: LIST_INCLUDE,
      orderBy: { createdAt: "desc" },
    });

    return payments.map(withRefunded);
  }

  async getPaymentsByAppointment(tenantId: string, appointmentId: string, professionalId?: string | null) {
    const payments = await this.prisma.payment.findMany({
      where: {
        tenantId,
        appointmentId,
        ...(professionalId ? { appointment: { professionalId } } : {}),
      },
      include: {
        client: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        refunds: { where: { status: "succeeded" }, select: { amount: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    return payments.map(withRefunded);
  }

  async getPaymentsByClient(tenantId: string, clientId: string, professionalId?: string | null) {
    const payments = await this.prisma.payment.findMany({
      where: {
        tenantId,
        clientId,
        ...(professionalId ? { appointment: { professionalId } } : {}),
      },
      include: {
        appointment: {
          select: {
            id: true,
            scheduledDate: true,
            status: true,
          },
        },
        refunds: { where: { status: "succeeded" }, select: { amount: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    return payments.map(withRefunded);
  }
}
