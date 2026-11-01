import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import { WalletService } from '../payments/services/wallet.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { refreshClientStats } from '../clients/client-stats';
import {
  assertChargeable,
  recordAppointmentPayment,
  shareMethod,
  splitTicket,
  appointmentOwedCents,
  type PayableAppointment,
} from '../payments/appointment-payment';
import { SALON_MANAGERS } from '../auth/decorators/roles.decorator';
import { CreatePosOrderDto, PosCartItemDto, PosSettingsDto } from './dto/pos.dto';
import {
  applyDiscounts,
  assertDiscountAllowed,
  isDiscount,
  type DiscountSpec,
  type DiscountedTicket,
} from './pos-discounts';
import { InvoiceService, type IssuedInvoice } from '../invoices/invoices.service';
import { CLIENT_POS_SELECT } from '../clients/client-select';
import {
  clientEmailFilter,
  countryForPhone,
  findClientIdByPhone,
  normalizeClientEmail,
  normalizeClientPhone,
} from '../clients/client-contact';

export { CreatePosOrderDto };

/** An appointment's issued invoice that a till discount will rectify: its id and "A000123". */
interface InvoiceToRectify {
  id: string;
  name: string;
}

/** 409: the discount does not fit in what is left to credit of the appointment's invoice. */
function notCreditable(appointmentId: string, invoiceName: string, err: BadRequestException): ConflictException {
  return new ConflictException({
    code: 'APPOINTMENT_INVOICE_NOT_CREDITABLE',
    message: `La factura de esta cita (${invoiceName}) ya está emitida y el descuento no cabe en una rectificativa: ${err.message}. Cóbrala sin descuento o con uno menor.`,
    appointmentId,
  });
}

/**
 * A cart line as the server prices it: cents per unit, from the database
 * (the service or product, or what the appointment still owes). The
 * client sends only what is sold and how many, and the discount it asks
 * for (pos-discounts.ts), never a price.
 */
export interface PricedLine {
  serviceId?: string;
  productId?: string;
  appointmentId?: string;
  name: string;
  price: number;
  quantity: number;
  discount?: DiscountSpec;
}

/** A cart line's discount, when it takes something off (0 % or 0 cents is none). */
function discountOf(line?: { discount?: DiscountSpec }): DiscountSpec | undefined {
  if (!line || !isDiscount(line.discount)) return undefined;
  const { type, value, reason } = line.discount;
  return { type, value: Number(value), ...(reason ? { reason } : {}) };
}

/** The validated body plus the tenant and the actor, from the JWT. */
export interface PosCheckout extends CreatePosOrderDto {
  tenantId: string;
  /** Who is at the till (from the JWT, never the body): staff charge their own appointments only. */
  actor?: { id: string; role: string };
}

@Injectable()
export class PosService {
  private readonly logger = new Logger(PosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
    @Optional() private readonly loyalty?: LoyaltyService,
    @Optional() private readonly invoices?: InvoiceService,
  ) {}

  /**
   * Get POS dashboard data for a tenant
   */
  async getDashboard(tenantId: string, date?: string) {
    const targetDate = date || new Date().toISOString().split('T')[0];
    
    // Get today's payments - use start of day to start of next day (exclusive)
    const dayStart = new Date(`${targetDate}T00:00:00.000Z`);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    
    const payments = await this.prisma.payment.findMany({
      where: {
        tenantId,
        createdAt: {
          gte: dayStart,
          lt: dayEnd,
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Calculate totals
    const totalSales = payments
      .filter((p) => p.status === 'paid')
      .reduce((sum, p) => sum + p.amount, 0);

    const totalTransactions = payments.filter((p) => p.status === 'paid').length;
    const pendingPayments = payments.filter((p) => p.status === 'pending').length;
    const refundedAmount = payments
      .filter((p) => p.status === 'refunded')
      .reduce((sum, p) => sum + p.amount, 0);

    // Get payment method breakdown
    const paymentBreakdown = payments
      .filter((p) => p.status === 'paid')
      .reduce((acc, p) => {
        if (!acc[p.method]) {
          acc[p.method] = { amount: 0, count: 0 };
        }
        acc[p.method].amount += p.amount;
        acc[p.method].count += 1;
        return acc;
      }, {} as Record<string, { amount: number; count: number }>);

    // Get top services sold today
    const todayAppointments = await this.prisma.appointment.findMany({
      where: {
        tenantId,
        createdAt: {
          gte: new Date(`${targetDate}T00:00:00Z`),
          lt: new Date(`${targetDate}T23:59:59Z`),
        },
        paymentStatus: 'paid',
      },
      include: { service: true },
    });

    const serviceSales = todayAppointments.reduce((acc, apt) => {
      const serviceName = apt.service?.name || 'Unknown';
      if (!acc[serviceName]) {
        acc[serviceName] = { count: 0, revenue: 0 };
      }
      acc[serviceName].count += 1;
      acc[serviceName].revenue += Number(apt.price);
      return acc;
    }, {} as Record<string, { count: number; revenue: number }>);

    return {
      date: targetDate,
      totalSales,
      totalTransactions,
      pendingPayments,
      refundedAmount,
      paymentBreakdown: Object.entries(paymentBreakdown).map(([method, data]) => ({
        method,
        ...data,
      })),
      topServices: Object.entries(serviceSales)
        .map(([name, data]) => ({ name, ...data }))
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 10),
    };
  }

  /**
   * Get available services for POS (only active ones)
   */
  async getServices(tenantId: string) {
    return this.prisma.service.findMany({
      where: { tenantId, isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  /**
   * Get clients for POS
   */
  async getClients(tenantId: string, search?: string) {
    const where: any = { tenantId, status: 'active' };
    
    if (search) {
      where.OR = [
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }
    
    return this.prisma.client.findMany({
      where,
      orderBy: { firstName: 'asc' },
      take: 50,
      // Who, how to reach, points: never her sign-in secrets or health data.
      select: CLIENT_POS_SELECT,
    });
  }

  /**
   * Process a POS checkout/sale
   */
  async processCheckout(dto: PosCheckout) {
    const { tenantId, clientId, clientInfo } = dto;
    const payments = dto.payments ?? [];
    // One id for the whole ticket, stamped on each of its payments, so the
    // loyalty points it earns or spends can be found again on a refund.
    const saleId = randomUUID();

    const appointmentIds = [...new Set(dto.appointmentIds ?? [])];
    // Checked before anything is spent or written: a cancelled or no-show
    // visit, or one already paid, refuses the whole ticket with a 409.
    const appointments = appointmentIds.length
      ? await this.chargeableAppointments(tenantId, appointmentIds, dto.actor)
      : [];

    // Priced here. The lines used to carry their own price from the
    // client, so a ticket could be rung up for any amount.
    const priced = await this.priceLines(tenantId, dto.items ?? [], appointments);

    // Discounts asked for at the till, worked out on those prices and
    // checked against who is at the till, before anything is written.
    const orderDiscount = discountOf(dto) ?? null;
    const ticket = applyDiscounts(priced, orderDiscount);
    if (ticket.discountCents > 0) await this.assertMayDiscount(tenantId, dto.actor, ticket, orderDiscount);
    const items = ticket.lines;
    const subtotal = ticket.subtotalCents;

    // What each appointment of the ticket gets off: its line's discount and
    // its share of the ticket's. Its total goes down by that much.
    const appointmentDiscounts = new Map<string, number>();
    for (const line of items) {
      const off = line.lineDiscountCents + line.orderDiscountCents;
      if (line.appointmentId && off > 0) {
        appointmentDiscounts.set(line.appointmentId, (appointmentDiscounts.get(line.appointmentId) ?? 0) + off);
      }
    }
    // An appointment already invoiced gets its discount as a rectificativa
    // by difference, issued with the sale; checked here, before anything is
    // written (a cancelled invoice, or less left to credit, is a 409).
    const toRectify =
      appointmentDiscounts.size > 0 ? await this.invoicesToRectify(tenantId, appointmentDiscounts) : new Map<string, InvoiceToRectify>();

    if (clientId) await this.assertClient(tenantId, clientId);
    // The wallet is a client's: without one nothing would be taken from it
    // and the sale would still be recorded as paid.
    if (!clientId && !clientInfo && payments.some((p) => p.method === 'wallet')) {
      throw new BadRequestException('A wallet payment needs a client');
    }

    let finalClientId = clientId;

    // If no clientId provided, create or find walk-in client
    if (!clientId && clientInfo) {
      finalClientId = await this.walkInClient(tenantId, clientInfo);
    }

    // Points spent on a reward come off the ticket before it is paid.
    let loyaltyDiscount = 0;
    let pointsSpent = 0;
    let rewardName: string | undefined;
    if (dto.loyaltyRewardId) {
      if (!this.loyalty) throw new BadRequestException('Loyalty is not available');
      const redeemed = await this.loyalty.redeemAtSale(tenantId, {
        clientId: finalClientId,
        rewardId: dto.loyaltyRewardId,
        saleId,
        // At what the lines cost after the till's discounts: a free service
        // is worth what is left of its line, never more.
        items: items.map((i) => ({ serviceId: i.serviceId, price: Math.floor(i.netCents / i.quantity), quantity: i.quantity })),
        subtotalCents: ticket.totalCents,
        appointmentId: appointmentIds[0] ?? null,
      });
      loyaltyDiscount = redeemed.discountCents;
      pointsSpent = redeemed.pointsSpent;
      rewardName = redeemed.rewardName;
    }
    const total = ticket.totalCents - loyaltyDiscount;

    // Verify payment amounts match total
    const paymentTotal = payments.reduce((sum, p) => sum + p.amount, 0);
    if (paymentTotal < total) {
      if (pointsSpent) await this.loyalty?.cancelSaleRedemption(tenantId, saleId, 'Venta no completada');
      throw new BadRequestException('Payment amount is less than order total');
    }

    // Each appointment gets the part of the ticket that pays for it, as its
    // own payment row (Payment.appointmentId): the reward first, then the
    // money. It used to be one row with the ids only in its metadata, and a
    // second call from the panel marked the appointment paid for any amount.
    const { rows, shares } = splitTicket(appointments, payments, loyaltyDiscount, appointmentDiscounts);
    const discountRows = this.discountRecords(tenantId, saleId, ticket, orderDiscount, dto.actor);

    // "Card" at the till is the salon's own card terminal: the money is
    // already taken when the sale is recorded. It used to create a Stripe
    // PaymentIntent for 100 times the amount (cents passed to a method that
    // multiplied by 100), with the platform's Stripe account when the salon
    // had none, which nobody ever confirmed: the sale stayed "pending" and
    // out of the day's card total.
    const walletTaken: number[] = [];
    let paymentRecords: any[] = [];
    const rectifications = new Map<string, IssuedInvoice>();
    try {
      for (const payment of payments) {
        if (payment.method === 'wallet' && finalClientId) {
          await this.walletService.deductFunds(tenantId, finalClientId, payment.amount, 'POS Payment');
          walletTaken.push(payment.amount);
        }
      }

      const write = async (db: any) => {
        const created: any[] = [];
        // The rectificativas, numbered in the sale's transaction: issued if
        // and only if the sale is recorded. Each one checks again, with the
        // original locked, that the discount fits in what is left of it.
        for (const [appointmentId, invoice] of toRectify) {
          const issued = await this.invoices!
            .rectifyByAmountIn(
              db,
              tenantId,
              invoice.id,
              appointmentDiscounts.get(appointmentId) as number,
              `Descuento en caja (venta ${saleId})`,
            )
            .catch((err) => {
              // Another rectificativa got there first: the sale rolls back.
              throw err instanceof BadRequestException ? notCreditable(appointmentId, invoice.name, err) : err;
            });
          rectifications.set(appointmentId, issued);
        }
        for (const row of rows) {
          created.push(
            await db.payment.create({
              data: {
                tenantId,
                clientId: row.appointment?.clientId ?? finalClientId,
                ...(row.appointment ? { appointmentId: row.appointment.id } : {}),
                amount: row.amount,
                currency: 'EUR',
                type: row.appointment ? 'appointment' : 'service',
                status: 'paid',
                method: row.method as any,
                description: `POS Sale: ${items.map(i => i.name).join(', ')}`,
                metadata: {
                  posSaleId: saleId,
                  ...(appointmentIds.length ? { appointmentIds } : {}),
                  ...(loyaltyDiscount ? { loyaltyDiscount, loyaltyRewardId: dto.loyaltyRewardId } : {}),
                  ...(ticket.discountCents ? { posDiscountCents: ticket.discountCents } : {}),
                },
              },
            }),
          );
        }
        // The discounts given, with the sale they belong to: recorded if and
        // only if the sale is.
        if (discountRows.length > 0) {
          await db.posDiscount.createMany({ data: this.withRectifications(discountRows, items, rectifications) });
        }
        // Same transaction: an appointment is paid if and only if the
        // payments that pay it are recorded.
        for (const share of shares) {
          const off = appointmentDiscounts.get(share.appointment.id) ?? 0;
          await recordAppointmentPayment(
            db,
            share.appointment,
            share.fromDiscount + share.fromMoney,
            shareMethod(share),
            off > 0
              ? {
                  cents: off,
                  record: this.appointmentDiscountRecord(
                    share.appointment,
                    saleId,
                    off,
                    items,
                    orderDiscount,
                    dto.actor,
                    rectifications.get(share.appointment.id)?.id,
                  ),
                }
              : undefined,
          );
        }
        return created;
      };
      paymentRecords = appointments.length || discountRows.length
        ? await this.prisma.$transaction((tx) => write(tx))
        : await write(this.prisma);
    } catch (err) {
      // Nothing was sold: give the points and the wallet money back.
      if (pointsSpent) await this.loyalty?.cancelSaleRedemption(tenantId, saleId, 'Venta no completada');
      for (const amount of walletTaken) {
        await this.walletService
          .addFunds(tenantId, finalClientId as string, amount, 'Devolución: venta no completada')
          .catch((e: Error) => this.logger.error(`wallet refund for failed sale ${saleId} failed: ${e.message}`));
      }
      throw err;
    }
    // Committed: the rectificativas go to the AEAT / Holded like any invoice.
    for (const issued of rectifications.values()) this.invoices?.afterIssue(issued);

    // Points for the sale. An appointment's ticket earns through the
    // appointment instead (once it is completed and paid), never both.
    let pointsEarned = 0;
    if (this.loyalty) {
      try {
        if (appointmentIds.length > 0) {
          for (const id of appointmentIds) {
            const r = await this.loyalty.settleAppointment(tenantId, id);
            pointsEarned += r?.awarded ?? 0;
          }
        } else {
          pointsEarned = await this.loyalty.earnForSale(tenantId, {
            clientId: finalClientId,
            saleId,
            basisCents: total,
            isVisit: items.some((i) => !!i.serviceId),
          });
        }
      } catch (err) {
        // The sale stands; the hourly sweep retries appointments.
        this.logger.warn(`loyalty points for sale ${saleId} failed: ${(err as Error).message}`);
      }
    }
    // What each client has spent (client-stats.ts).
    await refreshClientStats(this.prisma, tenantId, [
      finalClientId,
      ...(Array.isArray(paymentRecords) ? paymentRecords.map((p: { clientId?: string | null }) => p?.clientId) : []),
    ]);

    return {
      orderId: `POS-${Date.now()}`,
      saleId,
      clientId: finalClientId,
      items,
      subtotal,
      discount: {
        lines: ticket.lineDiscountsCents,
        order: ticket.orderDiscountCents,
        total: ticket.discountCents,
      },
      total,
      payments: paymentRecords,
      loyalty: { pointsEarned, pointsSpent, discount: loyaltyDiscount, rewardName },
      ...(rectifications.size
        ? {
            rectifications: [...rectifications].map(([appointmentId, issued]) => ({
              appointmentId,
              invoiceId: issued.id,
            })),
          }
        : {}),
      status: 'completed',
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * The appointments a ticket pays for, in the order given: each one of this
   * salon, chargeable (assertChargeable: not cancelled, not a no-show, not
   * already paid) and, for a staff member, on their own agenda -- the same
   * appointments the till lists for them.
   */
  private async chargeableAppointments(
    tenantId: string,
    ids: string[],
    actor?: { id: string; role: string },
  ) {
    const found = await this.prisma.appointment.findMany({
      where: { id: { in: ids }, tenantId },
      select: {
        id: true,
        clientId: true,
        professionalId: true,
        serviceId: true,
        status: true,
        paymentStatus: true,
        amountPaid: true,
        totalAmount: true,
        // Kept alongside a till discount's record (appointmentDiscountRecord).
        discount: true,
        service: { select: { name: true, price: true } },
      },
    });
    if (found.length !== ids.length) {
      throw new NotFoundException('Appointment not found');
    }
    if (actor?.role === 'staff') {
      const own = await this.prisma.professional.findFirst({
        where: { userId: actor.id, tenantId },
        select: { id: true },
      });
      if (!own || found.some((a) => a.professionalId !== own.id)) {
        throw new ForbiddenException('Solo puedes cobrar tus propias citas.');
      }
    }
    const byId = new Map(found.map((a) => [a.id, a]));
    const ordered = ids.map((id) => byId.get(id)!);
    ordered.forEach(assertChargeable);
    return ordered;
  }

  /**
   * Prices the cart from the database, in cents. Each appointment of the
   * ticket gets one line at what it still owes (appointmentOwedCents, the
   * figure the till shows): the line that names it (`appointmentId`), else
   * the first line of its service, else a line added for it. Further units
   * of that line, and every other line, are sold at the list price of the
   * service or product.
   *
   * A line's discount goes with it. When the appointment takes one unit of
   * a longer line, a percentage applies to both parts; a fixed amount stays
   * with the appointment's unit (it may not exceed that unit's price).
   */
  private async priceLines(
    tenantId: string,
    lines: PosCartItemDto[],
    appointments: Array<PayableAppointment & { serviceId?: string | null; service?: { name?: string; price: unknown } | null }>,
  ): Promise<PricedLine[]> {
    if (lines.some((l) => !l.serviceId === !l.productId)) {
      throw new BadRequestException('Each cart line is one service or one product');
    }
    const pending = lines.map((l) => ({ ...l }));
    const priced: PricedLine[] = [];
    for (const apt of appointments) {
      let at = pending.findIndex((l) => l.appointmentId === apt.id);
      if (at < 0) at = pending.findIndex((l) => !l.appointmentId && !!l.serviceId && l.serviceId === apt.serviceId);
      const line = at >= 0 ? pending.splice(at, 1)[0] : undefined;
      const discount = discountOf(line);
      priced.push({
        ...(apt.serviceId ? { serviceId: apt.serviceId } : {}),
        appointmentId: apt.id,
        name: apt.service?.name ?? 'Cita',
        price: appointmentOwedCents(apt),
        quantity: 1,
        ...(discount ? { discount } : {}),
      });
      if (line && line.quantity > 1) {
        pending.push({
          ...line,
          appointmentId: undefined,
          quantity: line.quantity - 1,
          discount: discount?.type === 'percentage' ? line.discount : undefined,
        });
      }
    }
    if (pending.some((l) => l.appointmentId)) {
      throw new BadRequestException('A cart line charges an appointment that is not on this ticket');
    }

    const serviceIds = [...new Set(pending.map((l) => l.serviceId).filter((id): id is string => !!id))];
    const productIds = [...new Set(pending.map((l) => l.productId).filter((id): id is string => !!id))];
    const services = serviceIds.length
      ? await this.prisma.service.findMany({
          where: { id: { in: serviceIds }, tenantId },
          select: { id: true, name: true, price: true },
        })
      : [];
    const products = productIds.length
      ? await this.prisma.product.findMany({
          where: { id: { in: productIds }, tenantId },
          select: { id: true, name: true, price: true, isActive: true },
        })
      : [];
    if (services.length !== serviceIds.length) throw new NotFoundException('Service not found');
    if (products.length !== productIds.length) throw new NotFoundException('Product not found');
    const inactive = products.find((p) => !p.isActive);
    if (inactive) throw new BadRequestException(`Product ${inactive.name} is not available`);

    const serviceById = new Map(services.map((x) => [x.id, x]));
    const productById = new Map(products.map((x) => [x.id, x]));
    for (const line of pending) {
      const source = line.serviceId ? serviceById.get(line.serviceId)! : productById.get(line.productId as string)!;
      const discount = discountOf(line);
      priced.push({
        ...(line.serviceId ? { serviceId: line.serviceId } : { productId: line.productId }),
        name: source.name,
        price: Math.round(Number(source.price) * 100),
        quantity: line.quantity,
        ...(discount ? { discount } : {}),
      });
    }
    return priced;
  }

  /**
   * 403 unless the actor may give the ticket's discounts: the owner and
   * managers always; staff up to the salon's maxStaffDiscountPercent per
   * line (pos-discounts.ts assertDiscountAllowed).
   */
  private async assertMayDiscount(
    tenantId: string,
    actor: { id: string; role: string } | undefined,
    ticket: DiscountedTicket<PricedLine>,
    orderDiscount: DiscountSpec | null,
  ): Promise<void> {
    let max = 0;
    if (!actor || !(SALON_MANAGERS as string[]).includes(actor.role)) {
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { maxStaffDiscountPercent: true },
      });
      max = tenant?.maxStaffDiscountPercent ?? 0;
    }
    assertDiscountAllowed(actor?.role, max, ticket, orderDiscount);
  }

  /**
   * The issued invoices of the discounted appointments, by appointment.
   * With VERI*FACTU an issued invoice is chained and sent, never edited: a
   * discount given afterwards at the till is credited by a rectificativa by
   * difference (InvoiceService.rectifyByAmountIn), issued with the sale. It
   * used to be refused with a 409. Still a 409, before anything is written,
   * when the invoice is cancelled or has less left to credit than the
   * discount (earlier rectificativas included).
   */
  private async invoicesToRectify(
    tenantId: string,
    discounts: Map<string, number>,
  ): Promise<Map<string, InvoiceToRectify>> {
    const invoiced = await this.prisma.invoice.findMany({
      where: { tenantId, sourceType: 'appointment', sourceId: { in: [...discounts.keys()] } },
      select: { id: true, sourceId: true, status: true, series: true, number: true },
    });
    const out = new Map<string, InvoiceToRectify>();
    for (const invoice of invoiced) {
      const appointmentId = invoice.sourceId as string;
      const name = `${invoice.series}${invoice.number}`;
      if (!this.invoices) {
        throw new ConflictException({
          code: 'APPOINTMENT_ALREADY_INVOICED',
          message:
            'Esta cita ya tiene su factura emitida: no se le puede aplicar un descuento en caja. Cóbrala sin descuento o emite una factura rectificativa.',
          appointmentId,
        });
      }
      if (invoice.status === 'cancelled') {
        throw new ConflictException({
          code: 'APPOINTMENT_INVOICE_CANCELLED',
          message: `La factura de esta cita (${name}) está anulada: no se le puede aplicar un descuento en caja. Cóbrala sin descuento.`,
          appointmentId,
        });
      }
      try {
        await this.invoices.assertCreditable(tenantId, invoice.id, discounts.get(appointmentId) as number);
      } catch (err) {
        throw err instanceof BadRequestException ? notCreditable(appointmentId, name, err) : err;
      }
      out.set(appointmentId, { id: invoice.id, name });
    }
    return out;
  }

  /**
   * The ticket's discount rows, each naming the rectificativa issued for it:
   * a line's, its appointment's; the ticket's own discount, the one
   * rectificativa its share went to (none when it went to several: each
   * appointment's record keeps its own, appointmentDiscountRecord).
   */
  private withRectifications(
    rows: any[],
    lines: DiscountedTicket<PricedLine>['lines'],
    rectifications: Map<string, IssuedInvoice>,
  ): any[] {
    if (rectifications.size === 0) return rows;
    const fromOrder = [
      ...new Set(
        lines
          .filter((l) => l.appointmentId && l.orderDiscountCents > 0 && rectifications.has(l.appointmentId))
          .map((l) => rectifications.get(l.appointmentId as string)!.id),
      ),
    ];
    return rows.map((row) => {
      let id: string | undefined;
      if (row.scope === 'line') id = row.appointmentId ? rectifications.get(row.appointmentId)?.id : undefined;
      else if (fromOrder.length === 1) id = fromOrder[0];
      return id ? { ...row, rectificationInvoiceId: id } : row;
    });
  }

  /** The PosDiscount rows of a ticket: one per discounted line, one for the ticket's own discount. */
  private discountRecords(
    tenantId: string,
    saleId: string,
    ticket: DiscountedTicket<PricedLine>,
    orderDiscount: DiscountSpec | null,
    actor?: { id: string; role: string },
  ) {
    const by = { appliedById: actor?.id ?? null, appliedByRole: actor?.role ?? null };
    const rows: any[] = [];
    ticket.lines.forEach((line, lineIndex) => {
      if (!line.discount) return;
      rows.push({
        tenantId,
        saleId,
        scope: 'line',
        lineIndex,
        serviceId: line.serviceId ?? null,
        productId: line.productId ?? null,
        appointmentId: line.appointmentId ?? null,
        description: line.name.slice(0, 200),
        type: line.discount.type,
        value: line.discount.value,
        baseCents: line.grossCents,
        amountCents: line.lineDiscountCents,
        reason: line.discount.reason ?? null,
        ...by,
      });
    });
    if (orderDiscount) {
      rows.push({
        tenantId,
        saleId,
        scope: 'order',
        description: 'Ticket',
        type: orderDiscount.type,
        value: orderDiscount.value,
        baseCents: ticket.orderBaseCents,
        amountCents: ticket.orderDiscountCents,
        reason: orderDiscount.reason ?? null,
        ...by,
      });
    }
    return rows;
  }

  /**
   * What an appointment keeps of a till discount (its `discount` column):
   * the cents its invoice takes off (appointment-invoice-pricing.ts), the
   * sale, the reasons and who gave it. Other keys already there stay.
   */
  private appointmentDiscountRecord(
    apt: { id: string; discount?: unknown },
    saleId: string,
    cents: number,
    lines: DiscountedTicket<PricedLine>['lines'],
    orderDiscount: DiscountSpec | null,
    actor?: { id: string; role: string },
    rectificationInvoiceId?: string,
  ): Record<string, unknown> {
    const own = lines.filter((l) => l.appointmentId === apt.id);
    const reasons = [
      ...own.map((l) => l.discount?.reason),
      own.some((l) => l.orderDiscountCents > 0) ? orderDiscount?.reason : undefined,
    ].filter((r): r is string => !!r);
    const existing = apt.discount && typeof apt.discount === 'object' && !Array.isArray(apt.discount) ? apt.discount : {};
    return {
      ...(existing as Record<string, unknown>),
      pos: {
        saleId,
        amountCents: cents,
        lineCents: own.reduce((s, l) => s + l.lineDiscountCents, 0),
        orderCents: own.reduce((s, l) => s + l.orderDiscountCents, 0),
        ...(reasons.length ? { reason: [...new Set(reasons)].join(' · ') } : {}),
        appliedById: actor?.id ?? null,
        appliedByRole: actor?.role ?? null,
        // The appointment was invoiced already: the rectificativa that credits it.
        ...(rectificationInvoiceId ? { rectificationInvoiceId } : {}),
        at: new Date().toISOString(),
      },
    };
  }

  /** The till's settings: how far staff may discount. */
  async getSettings(tenantId: string): Promise<{ maxStaffDiscountPercent: number }> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { maxStaffDiscountPercent: true },
    });
    return { maxStaffDiscountPercent: tenant?.maxStaffDiscountPercent ?? 0 };
  }

  async updateSettings(tenantId: string, dto: PosSettingsDto): Promise<{ maxStaffDiscountPercent: number }> {
    const tenant = await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { maxStaffDiscountPercent: dto.maxStaffDiscountPercent },
      select: { maxStaffDiscountPercent: true },
    });
    return { maxStaffDiscountPercent: tenant.maxStaffDiscountPercent };
  }

  /** 404 unless the client is one of this salon's. */
  private async assertClient(tenantId: string, clientId: string): Promise<void> {
    const client = await this.prisma.client.findFirst({ where: { id: clientId, tenantId }, select: { id: true } });
    if (!client) throw new NotFoundException('Client not found');
  }

  /**
   * The salon's client typed at the till: the one with that phone (last
   * nine digits, however it was stored) or that email (any case), else a
   * new one, stored like every other client (see clients/client-contact.ts).
   * The phone used to be looked up as typed, so "600 111 222" at the till
   * made a second client of "+34600111222"; an email already on file failed
   * the sale with a unique-constraint error.
   */
  private async walkInClient(
    tenantId: string,
    info: { firstName: string; lastName?: string; email?: string; phone?: string },
  ): Promise<string> {
    const email = normalizeClientEmail(info.email) ?? null;
    const phone = normalizeClientPhone(info.phone, await countryForPhone(this.prisma, tenantId, info.phone)) ?? null;
    const byEmail = () =>
      email
        ? this.prisma.client.findFirst({
            where: { tenantId, email: clientEmailFilter(email) },
            orderBy: { createdAt: 'asc' },
            select: { id: true },
          })
        : Promise.resolve(null);

    const existing = (await findClientIdByPhone(this.prisma, tenantId, phone)) ?? (await byEmail())?.id;
    if (existing) return existing;
    try {
      const created = await this.prisma.client.create({
        data: {
          tenantId,
          firstName: info.firstName.trim(),
          lastName: info.lastName?.trim() ?? '',
          email,
          phone,
          status: 'active',
        },
        select: { id: true },
      });
      return created.id;
    } catch (error) {
      // Created meanwhile (another till, a booking): the email is taken by
      // her record, so the sale goes to it.
      if ((error as { code?: string } | null)?.code === 'P2002') {
        const raced = await byEmail();
        if (raced) return raced.id;
      }
      throw error;
    }
  }

  /**
   * Process a quick sale (single item, immediate payment)
   */
  async quickSale(tenantId: string, serviceId: string, paymentMethod: 'cash' | 'card', clientId?: string) {
    const service = await this.prisma.service.findUnique({ where: { id: serviceId } });
    
    if (!service) {
      throw new NotFoundException('Service not found');
    }
    if (clientId) await this.assertClient(tenantId, clientId);

    // Convert price to cents (same as checkout)
    const amount = Math.round(Number(service.price) * 100);
    const saleId = randomUUID();
    // Card means the salon's terminal; see processCheckout.

    const payment = await this.prisma.payment.create({
      data: {
        tenantId,
        clientId,
        amount,
        currency: service.currency || 'EUR',
        type: 'service',
        status: 'paid',
        method: paymentMethod as any,
        description: `Quick Sale: ${service.name}`,
        metadata: { posSaleId: saleId },
      },
    });

    let pointsEarned = 0;
    try {
      pointsEarned =
        (await this.loyalty?.earnForSale(tenantId, { clientId, saleId, basisCents: amount, isVisit: true })) ?? 0;
    } catch (err) {
      this.logger.warn(`loyalty points for quick sale ${saleId} failed: ${(err as Error).message}`);
    }
    await refreshClientStats(this.prisma, tenantId, [clientId]);

    return {
      id: payment.id,
      service: { name: service.name, price: service.price },
      amount,
      paymentMethod,
      status: payment.status,
      loyalty: { pointsEarned },
    };
  }

  /**
   * Get order/receipt details
   */
  async getOrder(orderId: string) {
    const payment = await this.prisma.payment.findFirst({
      where: { id: orderId },
    });

    if (!payment) {
      throw new NotFoundException('Order not found');
    }

    const client = payment.clientId
      ? await this.prisma.client.findUnique({ where: { id: payment.clientId } })
      : null;

    return {
      id: payment.id,
      client: client
        ? { name: `${client.firstName} ${client.lastName}`, email: client.email, phone: client.phone }
        : null,
      amount: payment.amount,
      paymentMethod: payment.method,
      status: payment.status,
      createdAt: payment.createdAt,
    };
  }

  /**
   * Get daily sales report
   */
  async getDailyReport(tenantId: string, date: string) {
    const startDate = new Date(`${date}T00:00:00Z`);
    const endDate = new Date(`${date}T23:59:59Z`);

    const payments = await this.prisma.payment.findMany({
      where: {
        tenantId,
        createdAt: { gte: startDate, lte: endDate },
      },
      include: { client: { select: { firstName: true, lastName: true } } },
    });

    const paidPayments = payments.filter((p) => p.status === 'paid');
    const refundedPayments = payments.filter((p) => p.status === 'refunded');

    // Group by hour
    const hourlySales = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      count: 0,
      amount: 0,
    }));

    paidPayments.forEach((payment) => {
      const hour = new Date(payment.createdAt).getHours();
      hourlySales[hour].count += 1;
      hourlySales[hour].amount += payment.amount;
    });

    return {
      date,
      summary: {
        totalSales: paidPayments.reduce((sum, p) => sum + p.amount, 0),
        totalTransactions: paidPayments.length,
        refundedAmount: refundedPayments.reduce((sum, p) => sum + p.amount, 0),
        refundedCount: refundedPayments.length,
      },
      hourlySales,
      payments: paidPayments.map((p) => ({
        id: p.id,
        amount: p.amount,
        method: p.method,
        client: p.client ? `${p.client.firstName} ${p.client.lastName}` : 'Walk-in',
        time: p.createdAt,
      })),
    };
  }
}
