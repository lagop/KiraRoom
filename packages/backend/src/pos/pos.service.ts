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
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { WalletService } from '../payments/services/wallet.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { GiftCardsService } from '../gift-cards/gift-cards.service';
import { refreshClientStats } from '../clients/client-stats';
import { settleTenders, type Tender } from './pos-tenders';
import { drawerClosed, openCashSessionId, takesCash } from './cash-session-lock';
import {
  assertChargeable,
  recordAppointmentPayment,
  shareMethod,
  splitTicket,
  appointmentChargeCents,
  appointmentOwedCents,
  appointmentTotalCents,
  type PayableAppointment,
} from '../payments/appointment-payment';
import {
  moneyOfCatalogueCents,
  salonTaxBasis,
  visitChargeCents,
  visitDiscountInCatalogue,
  type SalonTaxBasis,
} from '../payments/appointment-charge';
import { addonServices } from '../appointments/visit-sync';
import { SALON_MANAGERS } from '../auth/decorators/roles.decorator';
import { CreatePosOrderDto, PosCartItemDto, PosQuoteDto, PosSettingsDto } from './dto/pos.dto';
import {
  applyDiscounts,
  assertDiscountAllowed,
  isDiscount,
  type DiscountSpec,
  type DiscountedTicket,
} from './pos-discounts';
import {
  InvoiceService,
  SIMPLIFIED_INVOICE_MAX_CENTS,
  type IssuedInvoice,
  type SimplifiedSaleInvoice,
} from '../invoices/invoices.service';
import { productTaxRatePercent, salonTaxRate } from '../invoices/salon-tax-settings';
import { taxLabelOf } from '@kira/shared';
import { CLIENT_POS_SELECT } from '../clients/client-select';
import {
  clientEmailFilter,
  countryForPhone,
  findClientIdByPhone,
  normalizeClientEmail,
  normalizeClientPhone,
} from '../clients/client-contact';
import {
  includedTaxCents,
  invoiceLineOf,
  loyaltyShares,
  rowsByBucket,
  saleDescription,
  type GiftCardLine,
  type PricedLine,
} from './pos-ticket';
import { effectiveCommissionRate } from '../commissions/commission-rate';
import { safeTimeZone } from '../gift-cards/gift-card-expiry';
import { salonInstant } from '../appointments/salon-time';
import { salonDayAndTime } from '../appointments/reschedule-check';
import { addDays, salonToday } from '../analytics/analytics-metrics';
import { SNAPSHOT_SELECT, withBookedService } from '../appointments/appointment-snapshot';

export { CreatePosOrderDto };
export type { PricedLine };

/** An appointment's issued invoice that a till discount will rectify: its id and "A000123". */
interface InvoiceToRectify {
  id: string;
  name: string;
  /** What the rectificativa credits, in money (tax included). */
  creditedCents: number;
}

/** An appointment's share of a sale's loyalty reward, for its invoice (PosService.visitLoyalty). */
interface VisitLoyalty {
  /** In the visit's catalogue terms: what its invoice takes off. */
  catalogueCents: number;
  /** Its live invoice, issued already: credited by a rectificativa by difference with the sale. */
  invoiceId?: string;
  /** What the appointment keeps under `discount.loyalty`. */
  record: Record<string, unknown>;
}

/** 409: the discount does not fit in what is left to credit of the appointment's invoice. */
function notCreditable(appointmentId: string, invoiceName: string, err: BadRequestException): ConflictException {
  return new ConflictException({
    code: 'APPOINTMENT_INVOICE_NOT_CREDITABLE',
    message: `La factura de esta cita (${invoiceName}) ya está emitida y el descuento no cabe en una rectificativa: ${err.message}. Cóbrala sin descuento o con uno menor.`,
    appointmentId,
  });
}

/** A cart line's discount, when it takes something off (0 % or 0 cents is none). */
function discountOf(line?: { discount?: DiscountSpec }): DiscountSpec | undefined {
  if (!line || !isDiscount(line.discount)) return undefined;
  const { type, value, reason } = line.discount;
  return { type, value: Number(value), ...(reason ? { reason } : {}) };
}

function euros(cents: number): string {
  return (cents / 100).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

export interface PosActor {
  id: string;
  role: string;
}

/** What a checkout answers (stored on PosSale.result and returned again on a retry). */
export type PosSaleResult = Record<string, any>;

/** The validated body plus the tenant and the actor, from the JWT. */
export interface PosCheckout extends CreatePosOrderDto {
  tenantId: string;
  /** Who is at the till (from the JWT, never the body): staff charge their own appointments only. */
  actor?: PosActor;
}

export interface PosQuoteInput extends PosQuoteDto {
  tenantId: string;
  actor?: PosActor;
}

/** What the till needs to know about the salon, read once per ticket. */
interface Salon {
  fiscalSettings: Record<string, unknown>;
  basis: SalonTaxBasis;
  maxStaffDiscountPercent: number;
  timezone: string;
  taxLabel: string;
}

type ChargeableApt = PayableAppointment & {
  clientId: string | null;
  professionalId: string;
  serviceId: string;
  discount?: unknown;
  service?: { name?: string; price: unknown } | null;
  /** The visit as its invoice reads it (appointment-charge.ts). */
  visit: any;
};

type TicketLine = DiscountedTicket<PricedLine>['lines'][number];

/** A ticket priced by the server: what POST /pos/quote answers and the checkout charges. */
interface PricedTicket {
  appointments: ChargeableApt[];
  ticket: DiscountedTicket<PricedLine>;
  giftCards: GiftCardLine[];
  giftCardsCents: number;
  orderDiscount: DiscountSpec | null;
  /** Per appointment: the money discount actually given. */
  appointmentDiscounts: Map<string, number>;
  /** Per appointment: the discount in catalogue terms and the money total after it. */
  catalogueDiscounts: Map<string, { catalogueCents: number; chargeAfterCents: number }>;
  toRectify: Map<string, InvoiceToRectify>;
}

/** Staff see only the sales they recorded or their professional's appointments (owner decision 2026-11-01). */
export interface StaffSalesScope {
  userId: string;
  professionalId: string | null;
}

/** The Prisma filter of the payments a staff member may see (null: everything, owner/manager). */
export function staffPaymentFilter(scope: StaffSalesScope | null): Prisma.PaymentWhereInput | null {
  if (!scope) return null;
  return {
    OR: [
      { recordedById: scope.userId },
      ...(scope.professionalId ? [{ appointment: { professionalId: scope.professionalId } }] : []),
    ],
  };
}

const CASHIER_TYPES = { appointment: 'appointment', service: 'service', product: 'product', gift_card: 'gift_card' } as const;

@Injectable()
export class PosService {
  private readonly logger = new Logger(PosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
    @Optional() private readonly loyalty?: LoyaltyService,
    @Optional() private readonly invoices?: InvoiceService,
    @Optional() private readonly giftCards?: GiftCardsService,
  ) {}

  /** Who a team member is at the till: null for the owner and managers (they see everything). */
  async staffScope(tenantId: string, actor?: PosActor): Promise<StaffSalesScope | null> {
    if (!actor) return null;
    if ((SALON_MANAGERS as string[]).includes(actor.role)) return null;
    const own = await this.prisma.professional.findFirst({
      where: { userId: actor.id, tenantId },
      select: { id: true },
    });
    return { userId: actor.id, professionalId: own?.id ?? null };
  }

  private async salonOf(tenantId: string): Promise<Salon> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { fiscalSettings: true, maxStaffDiscountPercent: true, timezone: true },
    });
    const fiscalSettings = ((tenant?.fiscalSettings ?? {}) as Record<string, unknown>) ?? {};
    return {
      fiscalSettings,
      basis: salonTaxBasis(fiscalSettings),
      maxStaffDiscountPercent: tenant?.maxStaffDiscountPercent ?? 0,
      timezone: safeTimeZone(tenant?.timezone),
      taxLabel: taxLabelOf(fiscalSettings),
    };
  }

  /** The salon's day [start, end) for `date` (YYYY-MM-DD, default today), in its timezone. */
  private dayRange(date: string | undefined, timeZone: string) {
    const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : salonToday(timeZone);
    return {
      day,
      start: salonInstant(day, '00:00', timeZone),
      end: salonInstant(addDays(day, 1), '00:00', timeZone),
    };
  }

  /**
   * The till's day: sales, transactions, methods, top services. A staff
   * member sees only their own sales (staffScope); the salon's totals are
   * the owner's and managers'.
   */
  async getDashboard(tenantId: string, date?: string, actor?: PosActor) {
    const scope = await this.staffScope(tenantId, actor);
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
    const { day, start, end } = this.dayRange(date, safeTimeZone(tenant?.timezone));
    const scoped = staffPaymentFilter(scope);

    const payments = await this.prisma.payment.findMany({
      where: { tenantId, createdAt: { gte: start, lt: end }, ...(scoped ? { AND: [scoped] } : {}) },
      orderBy: { createdAt: 'desc' },
      include: {
        appointment: { select: { id: true, service: { select: { name: true } } } },
        refunds: { where: { status: 'succeeded' }, select: { amount: true } },
      },
    });

    // Net of what was given back: a partial refund leaves its payment paid.
    const paid = payments.filter((p) => p.status === 'paid');
    const paymentBreakdown = paid.reduce((acc, p) => {
      if (!acc[p.method]) acc[p.method] = { amount: 0, count: 0 };
      acc[p.method].amount += keptCents(p);
      acc[p.method].count += 1;
      return acc;
    }, {} as Record<string, { amount: number; count: number }>);

    // Top services by what was charged that day (the payment's day): an
    // appointment's under its service, a service sold without one from its
    // sale line. They used to be the appointments CREATED that day.
    const services = new Map<string, { count: number; revenue: number; ids: Set<string> }>();
    const add = (name: string, cents: number, unit: string, count = 1) => {
      const entry = services.get(name) ?? { count: 0, revenue: 0, ids: new Set<string>() };
      if (!entry.ids.has(unit)) {
        entry.ids.add(unit);
        entry.count += count;
      }
      entry.revenue += cents;
      services.set(name, entry);
    };
    for (const p of paid) {
      const apt = (p as any).appointment as { id: string; service?: { name?: string } | null } | null;
      if (apt) add(apt.service?.name ?? 'Cita', keptCents(p), apt.id);
    }
    const saleIds = [
      ...new Set(paid.filter((p) => !p.appointmentId).map((p) => (p.metadata as any)?.posSaleId).filter(Boolean)),
    ] as string[];
    if (saleIds.length > 0) {
      const lines = await this.prisma.posSaleLine.findMany({
        where: { tenantId, saleId: { in: saleIds }, kind: 'service' },
        select: { id: true, description: true, quantity: true, totalCents: true, refundedCents: true, refundedQuantity: true },
      });
      for (const l of lines) {
        const left = l.quantity - (l.refundedQuantity ?? 0);
        if (left > 0 || l.totalCents - (l.refundedCents ?? 0) > 0) {
          add(l.description, l.totalCents - (l.refundedCents ?? 0), l.id, Math.max(0, left));
        }
      }
    }

    return {
      date: day,
      /** Cents (money). */
      totalSales: paid.reduce((sum, p) => sum + keptCents(p), 0),
      totalTransactions: paid.length,
      pendingPayments: payments.filter((p) => p.status === 'pending').length,
      /** Given back of the day's payments: whole refunds and partial ones. */
      refundedAmount: payments.reduce((sum, p) => sum + refundedCents(p), 0),
      paymentBreakdown: Object.entries(paymentBreakdown).map(([method, data]) => ({ method, ...data })),
      topServices: [...services.entries()]
        .map(([name, d]) => ({ name, count: d.count, revenue: d.revenue }))
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 10),
      /** True when the figures are only this team member's sales. */
      ownSalesOnly: !!scope,
    };
  }

  /**
   * The services the till sells (active ones), each with `chargeCents`: its
   * price in money, tax included -- what the till charges.
   */
  async getServices(tenantId: string) {
    const salon = await this.salonOf(tenantId);
    const services = await this.prisma.service.findMany({
      where: { tenantId, isActive: true },
      orderBy: { name: 'asc' },
    });
    return services.map((s: any) => ({
      ...s,
      chargeCents: moneyOfCatalogueCents(Math.round(Number(s.price) * 100), salon.basis),
      taxRate: salon.basis.ratePercent,
    }));
  }

  /** The products the till sells: active ones, priced in money (tax included), with their stock. */
  async getSaleProducts(tenantId: string, search?: string) {
    const salon = await this.salonOf(tenantId);
    const products = await this.prisma.product.findMany({
      where: {
        tenantId,
        isActive: true,
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' as const } },
                { sku: { contains: search, mode: 'insensitive' as const } },
                { barcode: { contains: search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      orderBy: { name: 'asc' },
      take: 200,
      select: { id: true, name: true, sku: true, price: true, taxRate: true, trackInventory: true, quantity: true, category: true },
    });
    return products.map((p) => {
      const rate = productTaxRatePercent(p.taxRate, salon.basis.ratePercent);
      return {
        ...p,
        price: Number(p.price),
        taxRate: rate,
        chargeCents: moneyOfCatalogueCents(Math.round(Number(p.price) * 100), { ...salon.basis, ratePercent: rate }),
      };
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

  // ------------------------------------------------------------------ pricing

  /**
   * The ticket priced by the server, in money (pos-ticket.ts): lines,
   * discounts (checked against who is at the till), the appointments'
   * discounts in their catalogue terms, and what the rectificativas of
   * invoiced ones would credit. Nothing is written.
   */
  private async priceTicket(
    tenantId: string,
    dto: PosQuoteDto,
    salon: Salon,
    actor?: PosActor,
  ): Promise<PricedTicket> {
    const appointmentIds = [...new Set(dto.appointmentIds ?? [])];
    // Checked before anything is spent or written: a cancelled or no-show
    // visit, or one already paid, refuses the whole ticket with a 409.
    const appointments = appointmentIds.length
      ? await this.chargeableAppointments(tenantId, appointmentIds, salon, actor)
      : [];

    const priced = await this.priceLines(tenantId, dto.items ?? [], appointments, salon, actor);
    const giftCards: GiftCardLine[] = (dto.giftCards ?? []).map((g) => ({
      amountCents: g.amountCents,
      recipientName: g.recipientName?.trim() || undefined,
      recipientEmail: g.recipientEmail?.trim() || undefined,
      message: g.message?.trim() || undefined,
    }));
    if (priced.length === 0 && giftCards.length === 0) {
      throw new BadRequestException('El ticket está vacío: añade un servicio, un producto, una cita o una tarjeta regalo.');
    }
    if (giftCards.length > 0 && !this.giftCards) {
      throw new BadRequestException('Ahora mismo no se pueden vender tarjetas regalo desde la caja.');
    }

    // Discounts asked for at the till, worked out on those prices and
    // checked against who is at the till, before anything is written.
    const orderDiscount = discountOf(dto) ?? null;
    const ticket = applyDiscounts(priced, orderDiscount);
    // The owner and managers always may; anyone else up to the salon's limit.
    if (ticket.discountCents > 0) assertDiscountAllowed(actor?.role, salon.maxStaffDiscountPercent, ticket, orderDiscount);

    // What each appointment of the ticket gets off, in money: its line's
    // discount and its share of the ticket's.
    const asked = new Map<string, number>();
    for (const line of ticket.lines) {
      const off = line.lineDiscountCents + line.orderDiscountCents;
      if (line.appointmentId && off > 0) asked.set(line.appointmentId, (asked.get(line.appointmentId) ?? 0) + off);
    }
    // In the visit's catalogue terms (what its total and invoice take off).
    const catalogueDiscounts = new Map<string, { catalogueCents: number; chargeAfterCents: number }>();
    const byId = new Map(appointments.map((a) => [a.id, a]));
    for (const [id, money] of asked) {
      catalogueDiscounts.set(id, visitDiscountInCatalogue(byId.get(id)!.visit, salon.fiscalSettings, money));
    }
    // An appointment already invoiced gets its discount as a rectificativa
    // by difference, issued with the sale; checked here (a cancelled
    // invoice, or less left to credit, is a 409).
    const toRectify =
      catalogueDiscounts.size > 0
        ? await this.invoicesToRectify(tenantId, catalogueDiscounts)
        : new Map<string, InvoiceToRectify>();

    // The money discount actually given: a salon whose prices are the base
    // can only reach some money totals (appointment-charge.ts), and an
    // invoiced visit is credited what its rectificativa says. The line
    // follows, so the till charges what the invoice says.
    const appointmentDiscounts = new Map<string, number>();
    for (const [id, money] of asked) {
      const apt = byId.get(id)!;
      const before = appointmentChargeCents(apt);
      const conv = catalogueDiscounts.get(id)!;
      const rect = toRectify.get(id);
      const given = rect ? rect.creditedCents : before - conv.chargeAfterCents;
      if (rect) catalogueDiscounts.set(id, { ...conv, chargeAfterCents: before - given });
      appointmentDiscounts.set(id, given);
      const delta = given - money;
      if (delta !== 0) adjustAppointmentLine(ticket, id, delta);
    }

    return {
      appointments,
      ticket,
      giftCards,
      giftCardsCents: giftCards.reduce((s, g) => s + g.amountCents, 0),
      orderDiscount,
      appointmentDiscounts,
      catalogueDiscounts,
      toRectify,
    };
  }

  /** The tax inside the ticket's lines (gift cards carry none), for "IVA incluido". */
  private taxOf(lines: TicketLine[]): number {
    return lines.reduce((s, l) => s + includedTaxCents(l.netCents, l.taxRate), 0);
  }

  /** The lines that go on the sale's own invoice: everything but appointments. */
  private invoiceableLines(lines: TicketLine[]): TicketLine[] {
    return lines.filter((l) => !l.appointmentId && l.netCents + l.lineDiscountCents + l.orderDiscountCents > 0);
  }

  /**
   * Which invoice the sale gets: simplified up to 3.000 EUR; above, a full
   * one when the client has a NIF, else refused (a Spanish message the
   * till shows).
   */
  private invoiceKind(
    invoiceableCents: number,
    client: { taxId?: string | null } | null,
  ): { kind: 'none' | 'simplified' | 'full'; problem?: string } {
    if (invoiceableCents <= 0) return { kind: 'none' };
    if (invoiceableCents <= SIMPLIFIED_INVOICE_MAX_CENTS) return { kind: 'simplified' };
    if (client?.taxId?.trim()) return { kind: 'full' };
    return {
      kind: 'full',
      problem: `Esta venta (${euros(invoiceableCents)}) pasa de 3.000 €, el máximo de una factura simplificada. Para cobrarla hace falta una factura completa: elige a la clienta y añade su NIF en su ficha.`,
    };
  }

  /** The ticket's lines as the panel shows them. */
  private linesOut(lines: TicketLine[]) {
    return lines.map((l) => ({
      ...l,
      unitPriceCents: l.price,
      discountCents: l.lineDiscountCents + l.orderDiscountCents,
      taxCents: includedTaxCents(l.netCents, l.taxRate),
    }));
  }

  /**
   * `POST /pos/quote`: the ticket as the checkout would charge it, priced by
   * the server, nothing written or spent. The panel charges `total`.
   */
  async quote(input: PosQuoteInput) {
    const { tenantId } = input;
    const salon = await this.salonOf(tenantId);
    const p = await this.priceTicket(tenantId, input, salon, input.actor);
    const client = input.clientId ? await this.clientForSale(tenantId, input.clientId) : null;

    let loyalty: { discount: number; pointsSpent: number; rewardName: string } | null = null;
    if (input.loyaltyRewardId) {
      if (!this.loyalty) throw new BadRequestException('Los puntos no están disponibles ahora mismo.');
      const preview = await this.loyalty.previewSaleDiscount(tenantId, {
        clientId: input.clientId,
        rewardId: input.loyaltyRewardId,
        items: this.loyaltyItems(p.ticket.lines),
        subtotalCents: p.ticket.totalCents,
      });
      loyalty = { discount: preview.discountCents, pointsSpent: preview.pointsSpent, rewardName: preview.rewardName };
    }
    const invoiceable = this.invoiceableLines(p.ticket.lines).reduce((s, l) => s + l.netCents, 0);
    const invoice = this.invoiceKind(invoiceable, client);
    return {
      lines: this.linesOut(p.ticket.lines),
      giftCards: p.giftCards,
      subtotal: p.ticket.subtotalCents + p.giftCardsCents,
      discount: { lines: p.ticket.lineDiscountsCents, order: p.ticket.orderDiscountCents, total: p.ticket.discountCents },
      loyalty,
      total: p.ticket.totalCents + p.giftCardsCents - (loyalty?.discount ?? 0),
      tax: { label: salon.taxLabel, cents: this.taxOf(p.ticket.lines), included: true, note: `${salon.taxLabel} incluido` },
      invoice: { kind: invoice.kind, ...(invoice.problem ? { problem: invoice.problem } : {}) },
    };
  }

  private loyaltyItems(lines: TicketLine[]) {
    // At what the lines cost after the till's discounts: a free service is
    // worth what is left of its line, never more.
    return lines.map((i) => ({ serviceId: i.serviceId, price: Math.floor(i.netCents / i.quantity), quantity: i.quantity }));
  }

  // ----------------------------------------------------------------- checkout

  /** The answer of a sale already recorded under this request id, if any (a retry). */
  private async priorSale(tenantId: string, requestId: string): Promise<PosSaleResult | null> {
    const sale = await this.prisma.posSale.findUnique({
      where: { tenantId_requestId: { tenantId, requestId } },
      select: { id: true, result: true },
    });
    if (!sale) return null;
    return { ...(sale.result as Record<string, unknown>), saleId: sale.id, replayed: true };
  }

  /**
   * A sale at the till: priced by the server in money (pos-ticket.ts), paid
   * with the tenders given (pos-tenders.ts), and written in ONE
   * transaction: the sale, its payments, the gift cards it redeems or
   * sells, the stock it takes, its discounts, the appointments it pays, its
   * rectificativas and its invoice. A retry with the same `saleId` returns
   * the first answer. The loyalty points it spends are given back if the
   * sale is not recorded.
   */
  async processCheckout(dto: PosCheckout, kind: 'checkout' | 'quick_sale' = 'checkout'): Promise<PosSaleResult> {
    const { tenantId, clientId, clientInfo, actor } = dto;
    const requestId = dto.saleId;
    if (requestId) {
      const prior = await this.priorSale(tenantId, requestId);
      if (prior) return prior;
    }
    const payments = (dto.payments ?? []) as Tender[];
    // Cash goes into the drawer: it needs the drawer open (arqueo). Card,
    // Bizum and the rest do not, so a salon that never uses the drawer is
    // not stuck. Checked again, under lock, inside the sale's transaction.
    if (takesCash(payments) && !(await openCashSessionId(this.prisma, tenantId))) throw drawerClosed();
    // The sale's id, stamped on its payments, discounts, points and invoice.
    const saleId = randomUUID();
    const salon = await this.salonOf(tenantId);
    const priced = await this.priceTicket(tenantId, dto, salon, actor);
    const { appointments, ticket, giftCards, giftCardsCents, orderDiscount, appointmentDiscounts, catalogueDiscounts, toRectify } =
      priced;
    const items = ticket.lines;
    const appointmentIds = appointments.map((a) => a.id);

    const client = clientId ? await this.clientForSale(tenantId, clientId) : null;
    // The wallet is a client's: without one nothing would be taken from it
    // and the sale would still be recorded as paid.
    if (!clientId && !clientInfo && payments.some((p) => p.method === 'wallet')) {
      throw new BadRequestException('Para cobrar con la cartera elige a la clienta.');
    }

    // The sale's own invoice: checked before anything is written.
    const invoiceable = this.invoiceableLines(items);
    const invoiceKind = this.invoiceKind(
      invoiceable.reduce((s, l) => s + l.netCents, 0),
      client,
    );
    if (invoiceKind.problem) throw new BadRequestException(invoiceKind.problem);

    const giftCodes = new Set(payments.filter((p) => p.method === 'gift_card').map((p) => (p.giftCardCode ?? '').trim().toUpperCase()));
    if (giftCodes.size > 1) {
      throw new BadRequestException('Se puede pagar con una sola tarjeta regalo por ticket: cobra el resto con otra forma de pago.');
    }
    // A gift card is paid with money, not with another gift card.
    const giftTendered = payments.filter((p) => p.method === 'gift_card').reduce((s, p) => s + p.amount, 0);
    if (giftCardsCents > 0 && giftTendered > ticket.totalCents) {
      throw new BadRequestException('Una tarjeta regalo no se puede pagar con otra tarjeta regalo.');
    }

    let finalClientId = clientId;
    if (!clientId && clientInfo) finalClientId = await this.walkInClient(tenantId, clientInfo);

    // Points spent on a reward come off the ticket before it is paid.
    let loyaltyDiscount = 0;
    let pointsSpent = 0;
    let rewardName: string | undefined;
    if (dto.loyaltyRewardId) {
      if (!this.loyalty) throw new BadRequestException('Los puntos no están disponibles ahora mismo.');
      const redeemed = await this.loyalty.redeemAtSale(tenantId, {
        clientId: finalClientId,
        rewardId: dto.loyaltyRewardId,
        saleId,
        items: this.loyaltyItems(items),
        subtotalCents: ticket.totalCents,
        appointmentId: appointmentIds[0] ?? null,
        actorId: actor?.id ?? null,
      });
      loyaltyDiscount = redeemed.discountCents;
      pointsSpent = redeemed.pointsSpent;
      rewardName = redeemed.rewardName;
    }
    const giveBackPoints = async () => {
      if (pointsSpent) {
        await this.loyalty
          ?.cancelSaleRedemption(tenantId, saleId, 'Venta no completada')
          .catch((e: Error) => this.logger.error(`points of failed sale ${saleId} not given back: ${e.message}`));
      }
    };
    const total = ticket.totalCents + giftCardsCents - loyaltyDiscount;

    // What was handed over: the total exactly, or more in cash (the change
    // goes back and is not recorded as a sale). pos-tenders.ts
    let tenders: Tender[];
    let change = 0;
    try {
      ({ tenders, change } = settleTenders(payments, total));
    } catch (err) {
      await giveBackPoints();
      throw err;
    }

    // Each appointment gets the part of the ticket that pays for it, as its
    // own payment row; what is left pays the rest, by kind (Payment.type).
    const { rows, shares } = splitTicket(appointments, tenders, loyaltyDiscount, appointmentDiscounts);
    const loyaltyLeft = loyaltyDiscount - shares.reduce((s, sh) => s + sh.fromDiscount, 0);
    // The loyalty reward is a discount on the invoices (owner decision
    // 2026-11-02): each appointment's share goes on its visit's invoice
    // (visitLoyalty), the rest is shared over the sale's own lines by their
    // tax base (pos-ticket.ts loyaltyShares).
    const loyaltyOfLine = new Map<TicketLine, number>();
    loyaltyShares(invoiceable, Math.max(0, loyaltyLeft)).forEach((cents, i) => {
      if (cents > 0) loyaltyOfLine.set(invoiceable[i], cents);
    });
    for (const share of shares) {
      const line = items.find((l) => l.appointmentId === share.appointment.id);
      if (line && share.fromDiscount > 0) loyaltyOfLine.set(line, share.fromDiscount);
    }
    let visitLoyalty: Map<string, VisitLoyalty>;
    try {
      visitLoyalty = await this.visitLoyalty(tenantId, salon, shares, catalogueDiscounts, saleId, rewardName);
    } catch (err) {
      await giveBackPoints();
      throw err;
    }
    const bucketOf = (k: PricedLine['kind']) =>
      items.filter((l) => !l.appointmentId && l.kind === k).reduce((s, l) => s + l.netCents, 0);
    let serviceCents = bucketOf('service');
    let productCents = bucketOf('product');
    const fromService = Math.min(serviceCents, Math.max(0, loyaltyLeft));
    serviceCents -= fromService;
    productCents = Math.max(0, productCents - (loyaltyLeft - fromService));
    const free = rows.filter((r) => !r.appointment);
    const typed = rowsByBucket(
      free.map((r) => ({ method: r.method, amount: r.amount, giftCardCode: (r as any).giftCardCode })),
      [
        { type: 'service', cents: serviceCents },
        { type: 'product', cents: productCents },
        { type: 'gift_card', cents: giftCardsCents },
      ],
    );
    const paymentRows: Array<{ method: string; amount: number; giftCardCode?: string; appointment: ChargeableApt | null; type: string }> = [
      ...rows.filter((r) => r.appointment).map((r) => ({ ...r, type: CASHIER_TYPES.appointment })),
      ...typed.map((r) => ({ ...r, appointment: null })),
    ];
    // splitTicket keeps the tender's own fields; the gift card code goes with each part of it.
    for (const row of paymentRows) {
      if (row.method === 'gift_card' && !row.giftCardCode) {
        row.giftCardCode = tenders.find((t) => t.method === 'gift_card')?.giftCardCode;
      }
    }
    if (paymentRows.some((r) => r.method === 'gift_card' && r.type === 'gift_card')) {
      await giveBackPoints();
      throw new BadRequestException('Una tarjeta regalo no se puede pagar con otra tarjeta regalo.');
    }

    const discountRows = this.discountRecords(tenantId, saleId, ticket, orderDiscount, actor);
    const names = [...items.map((i) => i.name), ...giftCards.map(() => 'Tarjeta regalo')];
    const description = saleDescription(kind === 'quick_sale' ? 'Venta rápida' : 'Venta en caja', names);
    const professionals = await this.commissionRates(tenantId, items);

    const rectifications = new Map<string, IssuedInvoice>();
    const loyaltyRectifications = new Map<string, IssuedInvoice>();
    let invoice: SimplifiedSaleInvoice | null = null;
    const soldCards: Array<{ id: string; code: string; amountCents: number; recipientName?: string; recipientEmail?: string }> = [];
    const created: any[] = [];

    let result: Record<string, unknown>;
    try {
      result = await this.prisma.$transaction(async (tx: any) => {
        // The open cash-drawer session, held (FOR SHARE) until this sale
        // commits: closing the drawer waits for it, so its money is in the
        // count, or the close comes first and the sale finds the drawer shut.
        const cashSessionId = await openCashSessionId(tx, tenantId, 'share');
        if (!cashSessionId && takesCash(payments)) throw drawerClosed();
        const inSession = cashSessionId ? { cashSessionId } : {};

        // First: the sale under its request id. A second request with the
        // same id waits here for the first and then fails the unique key.
        await tx.posSale.create({
          data: {
            ...inSession,
            id: saleId,
            tenantId,
            requestId: requestId ?? saleId,
            clientId: finalClientId ?? null,
            createdById: actor?.id ?? null,
            kind,
            subtotalCents: ticket.subtotalCents + giftCardsCents,
            discountCents: ticket.discountCents,
            loyaltyDiscountCents: loyaltyDiscount,
            totalCents: total,
            changeCents: change,
          },
        });

        // The wallet money, in the same transaction.
        const walletCents = paymentRows.filter((r) => r.method === 'wallet').reduce((s, r) => s + r.amount, 0);
        if (walletCents > 0 && finalClientId) {
          await this.walletService.debitIn(tx, tenantId, finalClientId, walletCents, 'Pago en caja', 'pos_sale', saleId);
        }

        // The rectificativas, numbered in the sale's transaction: issued if
        // and only if the sale is recorded. Each one checks again, with the
        // original locked, that the discount fits in what is left of it.
        for (const [appointmentId, inv] of toRectify) {
          const issued = await this.invoices!
            .rectifyByAmountIn(
              tx,
              tenantId,
              inv.id,
              catalogueDiscounts.get(appointmentId)!.catalogueCents,
              `Descuento en caja (venta ${saleId})`,
            )
            .catch((err) => {
              // Another rectificativa got there first: the sale rolls back.
              throw err instanceof BadRequestException ? notCreditable(appointmentId, inv.name, err) : err;
            });
          rectifications.set(appointmentId, issued);
        }
        // The loyalty reward on a visit invoiced already: a rectificativa by
        // difference for it, after the till discount's (checked: visitLoyalty).
        for (const [appointmentId, v] of visitLoyalty) {
          if (!v.invoiceId) continue;
          const issued = await this.invoices!.rectifyByAmountIn(
            tx,
            tenantId,
            v.invoiceId,
            v.catalogueCents,
            `Descuento fidelidad (venta ${saleId})`,
          );
          loyaltyRectifications.set(appointmentId, issued);
          v.record.rectificationInvoiceId = issued.id;
        }

        let giftCardId: string | undefined;
        for (const row of paymentRows) {
          const payment = await tx.payment.create({
            data: {
              tenantId,
              clientId: row.appointment?.clientId ?? finalClientId,
              ...(row.appointment ? { appointmentId: row.appointment.id } : {}),
              amount: row.amount,
              currency: 'EUR',
              type: row.type as any,
              status: 'paid',
              method: row.method as any,
              description,
              recordedById: actor?.id ?? null,
              ...inSession,
              metadata: {
                posSaleId: saleId,
                ...(appointmentIds.length ? { appointmentIds } : {}),
                ...(loyaltyDiscount ? { loyaltyDiscount, loyaltyRewardId: dto.loyaltyRewardId } : {}),
                ...(ticket.discountCents ? { posDiscountCents: ticket.discountCents } : {}),
              },
            },
          });
          // Paid with a gift card: taken from it now, linked to this payment.
          if (row.method === 'gift_card' && row.amount > 0) {
            if (!this.giftCards) throw new BadRequestException('Ahora mismo no se puede cobrar con tarjeta regalo.');
            const redeemed = await this.giftCards.redeemInTx(tx, {
              tenantId,
              ...(giftCardId ? { giftCardId } : { code: row.giftCardCode }),
              amountCents: row.amount,
              paymentId: payment.id,
              userId: actor?.id ?? null,
              note: `Venta en caja ${saleId}`,
            });
            giftCardId = redeemed.card.id;
            payment.metadata = { ...(payment.metadata ?? {}), giftCardId };
            await tx.payment.update({ where: { id: payment.id }, data: { metadata: payment.metadata } });
          }
          created.push(payment);
        }

        // Gift cards sold: issued, linked to the payment that paid them.
        const cardPayment = created.find((p) => p.type === 'gift_card');
        for (const card of giftCards) {
          const sold = await this.giftCards!.sellInTx(tx, {
            tenantId,
            amountCents: card.amountCents,
            paymentId: cardPayment?.id,
            userId: actor?.id ?? null,
            purchasedById: finalClientId ?? null,
            recipientName: card.recipientName ?? null,
            recipientEmail: card.recipientEmail ?? null,
            message: card.message ?? null,
          });
          soldCards.push({
            id: sold.card.id,
            code: sold.card.code,
            amountCents: card.amountCents,
            recipientName: card.recipientName,
            recipientEmail: card.recipientEmail,
          });
        }
        if (cardPayment && soldCards.length) {
          cardPayment.metadata = { ...(cardPayment.metadata ?? {}), soldGiftCardIds: soldCards.map((c) => c.id) };
          await tx.payment.update({ where: { id: cardPayment.id }, data: { metadata: cardPayment.metadata } });
        }

        // Products: the stock goes down in the same transaction, never below
        // what is there (two tills selling the last unit: one gets a 400).
        for (const line of items) {
          if (line.kind !== 'product' || !line.productId || !line.trackInventory) continue;
          const { count } = await tx.product.updateMany({
            where: { id: line.productId, tenantId, trackInventory: true, quantity: { gte: line.quantity } },
            data: { quantity: { decrement: line.quantity } },
          });
          const after = await tx.product.findFirst({
            where: { id: line.productId, tenantId },
            select: { quantity: true, trackInventory: true },
          });
          if (count !== 1) {
            if (!after?.trackInventory) continue;
            throw new BadRequestException(
              `Sin stock suficiente de ${line.name}: quedan ${Math.max(0, after?.quantity ?? 0)}.`,
            );
          }
          await tx.inventoryTransaction.create({
            data: {
              productId: line.productId,
              tenantId,
              type: 'sale',
              quantity: -line.quantity,
              previousQty: (after?.quantity ?? 0) + line.quantity,
              newQty: after?.quantity ?? 0,
              reason: 'Venta en caja',
              notes: `Venta ${saleId}`,
            },
          });
        }

        // The discounts given, with the sale they belong to.
        if (discountRows.length > 0) {
          await tx.posDiscount.createMany({ data: this.withRectifications(discountRows, items, rectifications) });
        }
        // An appointment is paid if and only if the payments that pay it are recorded.
        for (const share of shares) {
          const off = catalogueDiscounts.get(share.appointment.id);
          const money = appointmentDiscounts.get(share.appointment.id) ?? 0;
          await recordAppointmentPayment(
            tx,
            share.appointment,
            share.fromDiscount + share.fromMoney,
            shareMethod(share),
            off && off.catalogueCents > 0
              ? {
                  cents: off.catalogueCents,
                  chargeTotalCents: off.chargeAfterCents,
                  record: this.appointmentDiscountRecord(
                    share.appointment,
                    saleId,
                    off.catalogueCents,
                    money,
                    items,
                    orderDiscount,
                    actor,
                    rectifications.get(share.appointment.id)?.id,
                  ),
                }
              : undefined,
            visitLoyalty.get(share.appointment.id)?.record,
          );
        }

        // The sale's own invoice (series T, or a full one over 3.000 EUR).
        if (invoiceKind.kind !== 'none' && this.invoices) {
          invoice = await this.invoices.issueSimplifiedInvoiceForSale(tx, {
            tenantId,
            saleId,
            paymentIds: created.map((p) => p.id),
            lines: invoiceable.map((l) => invoiceLineOf(l, loyaltyOfLine.get(l) ?? 0)),
            clientId: finalClientId ?? undefined,
            full: invoiceKind.kind === 'full',
          });
        } else if (invoiceKind.kind !== 'none') {
          this.logger.warn(`sale ${saleId}: no invoice service, simplified invoice not issued`);
        }

        // Its lines, for the receipt and the commissions.
        const saleLines = [
          ...items.map((l, lineIndex) => {
            // The commission is on the line before the loyalty reward (paid
            // with points, like an appointment's: commissions.service.ts).
            const base = salon.basis.pricesIncludeTax ? l.netCents : l.netCents - includedTaxCents(l.netCents, l.taxRate);
            // What the line was charged, as the invoice says: after the reward.
            const loyalty = loyaltyOfLine.get(l) ?? 0;
            const charged = l.netCents - loyalty;
            const tax = includedTaxCents(charged, l.taxRate);
            const prof = l.kind === 'service' && l.professionalId ? professionals.get(l.professionalId) : undefined;
            return {
              saleId,
              tenantId,
              lineIndex,
              kind: l.kind,
              serviceId: l.serviceId ?? null,
              productId: l.productId ?? null,
              appointmentId: l.appointmentId ?? null,
              professionalId: l.professionalId ?? null,
              description: l.name.slice(0, 200),
              quantity: l.quantity,
              unitPriceCents: l.price,
              discountCents: l.lineDiscountCents + l.orderDiscountCents,
              ...(loyalty > 0 ? { loyaltyDiscountCents: loyalty } : {}),
              totalCents: charged,
              taxRate: l.taxRate,
              taxCents: tax,
              commissionBaseCents: base,
              // Appointments keep theirs on the appointment (commissions.service.ts).
              ...(prof !== undefined ? { commissionRate: prof, commissionAmount: (base * prof) / 100 } : {}),
            };
          }),
          ...soldCards.map((c, i) => ({
            saleId,
            tenantId,
            lineIndex: items.length + i,
            kind: 'gift_card',
            giftCardId: c.id,
            description: 'Tarjeta regalo',
            quantity: 1,
            unitPriceCents: c.amountCents,
            discountCents: 0,
            totalCents: c.amountCents,
            taxRate: 0,
            taxCents: 0,
            commissionBaseCents: 0,
          })),
        ];
        await tx.posSaleLine.createMany({ data: saleLines });

        const answer = JSON.parse(
          JSON.stringify({
            orderId: saleId,
            saleId,
            requestId: requestId ?? saleId,
            kind,
            clientId: finalClientId ?? null,
            items: this.linesOut(items),
            // The cards' ids, codes and amounts; not their recipients (another person's data).
            giftCards: soldCards.map((c) => ({ id: c.id, code: c.code, amountCents: c.amountCents })),
            subtotal: ticket.subtotalCents + giftCardsCents,
            discount: { lines: ticket.lineDiscountsCents, order: ticket.orderDiscountCents, total: ticket.discountCents },
            total,
            tax: { label: salon.taxLabel, cents: this.taxOf(items), included: true, note: `${salon.taxLabel} incluido` },
            /** Handed over, and the cash given back (not recorded as a sale). */
            tendered: payments.reduce((s, p) => s + p.amount, 0),
            change,
            payments: created,
            loyalty: { pointsEarned: 0, pointsSpent, discount: loyaltyDiscount, rewardName },
            invoice: invoice
              ? { id: (invoice as SimplifiedSaleInvoice).id, series: (invoice as SimplifiedSaleInvoice).series, number: `${(invoice as SimplifiedSaleInvoice).series}${(invoice as SimplifiedSaleInvoice).number}`, full: invoiceKind.kind === 'full' }
              : null,
            ...(rectifications.size
              ? {
                  rectifications: [...rectifications].map(([appointmentId, issued]) => ({
                    appointmentId,
                    invoiceId: issued.id,
                  })),
                }
              : {}),
            ...(loyaltyRectifications.size
              ? {
                  loyaltyRectifications: [...loyaltyRectifications].map(([appointmentId, issued]) => ({
                    appointmentId,
                    invoiceId: issued.id,
                  })),
                }
              : {}),
            status: 'completed',
            createdAt: new Date().toISOString(),
          }),
        );
        await tx.posSale.update({
          where: { id: saleId },
          data: { result: answer, invoiceId: invoice ? (invoice as SimplifiedSaleInvoice).id : null },
        });
        return answer;
      });
    } catch (err) {
      // Nothing was sold: give the points back.
      await giveBackPoints();
      // The same request, recorded meanwhile by another call: its answer.
      if (requestId && isUniqueViolation(err)) {
        const prior = await this.priorSale(tenantId, requestId);
        if (prior) return prior;
      }
      throw err;
    }

    // Committed: the invoices go to the AEAT / Holded like any invoice.
    for (const issued of rectifications.values()) this.invoices?.afterIssue(issued);
    for (const issued of loyaltyRectifications.values()) this.invoices?.afterIssue(issued);
    const issuedInvoice = invoice as SimplifiedSaleInvoice | null;
    if (issuedInvoice?.created) this.invoices?.afterIssue(issuedInvoice);
    // The gift cards sold, emailed to who receives them.
    const emailed: Record<string, boolean> = {};
    for (const card of soldCards) {
      if (!card.recipientEmail) continue;
      emailed[card.id] = (await this.giftCards!.sendCardEmail(tenantId, card.id)).sent;
    }

    // Points for the sale. An appointment's ticket earns through the
    // appointment instead (once it is completed and paid), never both. A
    // gift card earns when it is spent, not when it is sold.
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
            basisCents: total - giftCardsCents,
            isVisit: items.some((i) => !!i.serviceId),
          });
        }
      } catch (err) {
        // The sale stands; the hourly sweep retries appointments.
        this.logger.warn(`loyalty points for sale ${saleId} failed: ${(err as Error).message}`);
      }
    }
    // What each client has spent (client-stats.ts).
    await refreshClientStats(this.prisma, tenantId, [finalClientId, ...created.map((p) => p?.clientId)]);

    return {
      ...result,
      giftCards: soldCards.map((c) => ({ ...c, ...(c.id in emailed ? { emailSent: emailed[c.id] } : {}) })),
      loyalty: { ...(result.loyalty as object), pointsEarned },
    };
  }

  /** The client of a sale: 404 unless she is this salon's. Her NIF decides the invoice above 3.000 EUR. */
  private async clientForSale(tenantId: string, clientId: string): Promise<{ id: string; taxId: string | null }> {
    const client = await this.prisma.client.findFirst({
      where: { id: clientId, tenantId },
      select: { id: true, taxId: true },
    });
    if (!client) throw new NotFoundException('Clienta no encontrada');
    return { id: client.id, taxId: client.taxId ?? null };
  }

  /** The commission rate of each professional who did a walk-in service, by id. */
  private async commissionRates(tenantId: string, lines: TicketLine[]): Promise<Map<string, number>> {
    const ids = [
      ...new Set(lines.filter((l) => l.kind === 'service' && l.professionalId).map((l) => l.professionalId as string)),
    ];
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.professional.findMany({
      where: { tenantId, id: { in: ids } },
      select: { id: true, commissionRate: true },
    });
    return new Map(rows.map((r: any) => [r.id, effectiveCommissionRate(r.commissionRate)]));
  }

  /**
   * The appointments a ticket pays for, in the order given: each one of this
   * salon, chargeable (assertChargeable: not cancelled, not a no-show, not
   * already paid) and, for a staff member, on their own agenda -- the same
   * appointments the till lists for them. Each with its money total
   * (chargeTotalCents) when the salon's prices are the base.
   */
  private async chargeableAppointments(
    tenantId: string,
    ids: string[],
    salon: Salon,
    actor?: PosActor,
  ): Promise<ChargeableApt[]> {
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
        price: true,
        addons: true,
        // Kept alongside a till discount's record (appointmentDiscountRecord).
        discount: true,
        // What it was booked at (appointment-snapshot.ts): its name on the
        // ticket and its price where the visit has no stored total.
        ...SNAPSHOT_SELECT,
        service: { select: { name: true, price: true } },
        services: {
          include: { service: true },
          orderBy: [{ order: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        },
      },
    });
    if (found.length !== ids.length) {
      throw new NotFoundException('Cita no encontrada');
    }
    if (actor?.role === 'staff') {
      const own = await this.prisma.professional.findFirst({
        where: { userId: actor.id, tenantId },
        select: { id: true },
      });
      if (!own || found.some((a: any) => a.professionalId !== own.id)) {
        throw new ForbiddenException('Solo puedes cobrar tus propias citas.');
      }
    }
    const byId = new Map(found.map((a: any) => [a.id, a]));
    const ordered = ids.map((id) => withBookedService(byId.get(id)! as any)) as any[];
    ordered.forEach(assertChargeable);
    const out: ChargeableApt[] = [];
    for (const apt of ordered) {
      const visit = {
        ...apt,
        addons: Array.isArray(apt.addons) && apt.addons.length ? await addonServices(this.prisma, tenantId, apt.addons) : [],
      };
      out.push({
        ...apt,
        visit,
        ...(salon.basis.pricesIncludeTax ? {} : { chargeTotalCents: visitChargeCents(visit, salon.fiscalSettings) }),
      });
    }
    return out;
  }

  /**
   * Prices the cart from the database, in money cents (pos-ticket.ts). Each
   * appointment of the ticket gets one line at what it still owes: the line
   * that names it (`appointmentId`), else the first line of its service
   * with no appointment, else a line added for it. Further units of that
   * line, and every other line, are sold at the price of the service or
   * product, tax included.
   *
   * A line's discount goes with it. When the appointment takes one unit of
   * a longer line, a percentage applies to both parts; a fixed amount stays
   * with the appointment's unit (it may not exceed that unit's price).
   */
  private async priceLines(
    tenantId: string,
    lines: PosCartItemDto[],
    appointments: ChargeableApt[],
    salon: Salon,
    actor?: PosActor,
  ): Promise<PricedLine[]> {
    if (lines.some((l) => !l.serviceId === !l.productId)) {
      throw new BadRequestException('Cada línea del ticket es un servicio o un producto.');
    }
    if (lines.some((l) => l.productId && l.appointmentId)) {
      throw new BadRequestException('Una cita se cobra en una línea de servicio, no de producto.');
    }
    const salonRate = salonTaxRate(salon.fiscalSettings);
    const pending = lines.map((l) => ({ ...l }));
    const priced: PricedLine[] = [];
    for (const apt of appointments) {
      let at = pending.findIndex((l) => l.appointmentId === apt.id);
      if (at < 0) at = pending.findIndex((l) => !l.appointmentId && !!l.serviceId && l.serviceId === apt.serviceId);
      const line = at >= 0 ? pending.splice(at, 1)[0] : undefined;
      const discount = discountOf(line);
      priced.push({
        kind: 'appointment',
        ...(apt.serviceId ? { serviceId: apt.serviceId } : {}),
        appointmentId: apt.id,
        professionalId: apt.professionalId,
        name: apt.service?.name ?? 'Cita',
        price: appointmentOwedCents(apt),
        quantity: 1,
        taxRate: salonRate,
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
      throw new BadRequestException('Una línea cobra una cita que no está en este ticket.');
    }

    const serviceIds = [...new Set(pending.map((l) => l.serviceId).filter((id): id is string => !!id))];
    const productIds = [...new Set(pending.map((l) => l.productId).filter((id): id is string => !!id))];
    const services = serviceIds.length
      ? await this.prisma.service.findMany({
          where: { id: { in: serviceIds }, tenantId },
          select: { id: true, name: true, price: true, isActive: true },
        })
      : [];
    const products = productIds.length
      ? await this.prisma.product.findMany({
          where: { id: { in: productIds }, tenantId },
          select: { id: true, name: true, price: true, isActive: true, taxRate: true, trackInventory: true },
        })
      : [];
    if (services.length !== serviceIds.length) throw new NotFoundException('Servicio no encontrado');
    if (products.length !== productIds.length) throw new NotFoundException('Producto no encontrado');
    // Off the menu is off the till too.
    const inactiveService = services.find((s: any) => s.isActive === false);
    if (inactiveService) {
      throw new BadRequestException(
        `El servicio "${inactiveService.name}" está desactivado. Actívalo en Servicios para poder venderlo.`,
      );
    }
    const inactive = products.find((p: any) => !p.isActive);
    if (inactive) throw new BadRequestException(`El producto "${inactive.name}" no está a la venta (desactivado).`);

    // Who did each walk-in service: the one picked, else the team member at
    // the till if they are a professional. Staff may only name themselves.
    const own = actor
      ? await this.prisma.professional.findFirst({ where: { userId: actor.id, tenantId }, select: { id: true } })
      : null;
    const named = [...new Set(pending.map((l) => l.professionalId).filter((id): id is string => !!id))];
    if (named.length) {
      const pros = await this.prisma.professional.findMany({ where: { tenantId, id: { in: named } }, select: { id: true } });
      if (pros.length !== named.length) throw new NotFoundException('Profesional no encontrado');
      if (actor?.role === 'staff' && named.some((id) => id !== own?.id)) {
        throw new ForbiddenException('Solo puedes anotarte a ti los servicios que vendes.');
      }
    }

    const serviceById = new Map(services.map((x: any) => [x.id, x]));
    const productById = new Map(products.map((x: any) => [x.id, x]));
    for (const line of pending) {
      const discount = discountOf(line);
      if (line.serviceId) {
        const s = serviceById.get(line.serviceId)!;
        const catalogue = Math.round(Number(s.price) * 100);
        const professionalId = line.professionalId ?? own?.id;
        priced.push({
          kind: 'service',
          serviceId: line.serviceId,
          ...(professionalId ? { professionalId } : {}),
          name: s.name,
          price: moneyOfCatalogueCents(catalogue, salon.basis),
          catalogueUnitCents: catalogue,
          quantity: line.quantity,
          taxRate: salonRate,
          ...(discount ? { discount } : {}),
        });
      } else {
        const p = productById.get(line.productId as string)!;
        const rate = productTaxRatePercent(p.taxRate, salonRate);
        const catalogue = Math.round(Number(p.price) * 100);
        priced.push({
          kind: 'product',
          productId: line.productId,
          name: p.name,
          price: moneyOfCatalogueCents(catalogue, { ...salon.basis, ratePercent: rate }),
          catalogueUnitCents: catalogue,
          quantity: line.quantity,
          taxRate: rate,
          trackInventory: p.trackInventory !== false,
          ...(discount ? { discount } : {}),
        });
      }
    }
    return priced;
  }

  /**
   * The issued invoices of the discounted appointments, by appointment, with
   * what each rectificativa would credit in money. With VERI*FACTU an issued
   * invoice is chained and sent, never edited: a discount given afterwards at
   * the till is credited by a rectificativa by difference
   * (InvoiceService.rectifyByAmountIn, in the line's own terms: the catalogue
   * discount), issued with the sale. A 409, before anything is written, when
   * the invoice is cancelled or has less left to credit than the discount.
   */
  private async invoicesToRectify(
    tenantId: string,
    discounts: Map<string, { catalogueCents: number }>,
  ): Promise<Map<string, InvoiceToRectify>> {
    const found = await this.prisma.invoice.findMany({
      where: { tenantId, sourceType: 'appointment', sourceId: { in: [...discounts.keys()] } },
      select: { id: true, sourceId: true, status: true, series: true, number: true },
    });
    // An appointment whose invoice was cancelled can be invoiced again: its
    // live invoice is the one, the cancelled ones only count when it has none.
    const live = new Set(found.filter((i) => i.status !== 'cancelled').map((i) => i.sourceId));
    const invoiced = found.filter((i) => i.status !== 'cancelled' || !live.has(i.sourceId));
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
      const amount = discounts.get(appointmentId)!.catalogueCents;
      let credited: unknown;
      try {
        credited = await this.invoices.assertCreditable(tenantId, invoice.id, amount);
      } catch (err) {
        throw err instanceof BadRequestException ? notCreditable(appointmentId, name, err) : err;
      }
      out.set(appointmentId, { id: invoice.id, name, creditedCents: typeof credited === 'number' ? credited : amount });
    }
    return out;
  }

  /**
   * Each appointment's share of the loyalty reward, for its invoice (owner
   * decision 2026-11-02: the reward is a discount on the invoice, so the
   * invoice comes to what was charged). In the visit's catalogue terms, the
   * terms of its invoice lines. The visit keeps it under `discount.loyalty`
   * (recordAppointmentPayment) and its invoice, issued later, takes it off
   * (appointment-invoice-pricing.ts). A visit invoiced already gets a
   * rectificativa by difference for it, issued with the sale -- when what is
   * left to credit of its invoice takes it (with the till discount's): when
   * it does not, the sale still goes through and the answer's record says so
   * (`notOnInvoice`). Already-issued invoices are never edited.
   */
  private async visitLoyalty(
    tenantId: string,
    salon: Salon,
    shares: Array<{ appointment: ChargeableApt; fromDiscount: number }>,
    catalogueDiscounts: Map<string, { catalogueCents: number }>,
    saleId: string,
    rewardName?: string,
  ): Promise<Map<string, VisitLoyalty>> {
    const out = new Map<string, VisitLoyalty>();
    const rewarded = shares.filter((s) => s.fromDiscount > 0);
    if (rewarded.length === 0) return out;
    const invoices = this.invoices
      ? await this.prisma.invoice.findMany({
          where: {
            tenantId,
            sourceType: 'appointment',
            sourceId: { in: rewarded.map((s) => s.appointment.id) },
            status: { not: 'cancelled' },
          },
          select: { id: true, sourceId: true, series: true, number: true },
        })
      : [];
    for (const share of rewarded) {
      const apt = share.appointment;
      const tillCents = catalogueDiscounts.get(apt.id)?.catalogueCents ?? 0;
      const catalogueCents = salon.basis.pricesIncludeTax
        ? share.fromDiscount
        : loyaltyInCatalogue(apt, salon.fiscalSettings, tillCents, share.fromDiscount);
      if (catalogueCents <= 0) continue;
      const record: Record<string, unknown> = {
        saleId,
        moneyCents: share.fromDiscount,
        catalogueCents,
        ...(rewardName ? { rewardName } : {}),
        at: new Date().toISOString(),
      };
      const invoice = invoices.find((i) => i.sourceId === apt.id);
      let invoiceId: string | undefined;
      if (invoice && this.invoices) {
        try {
          await this.invoices.assertCreditable(tenantId, invoice.id, tillCents + catalogueCents);
          invoiceId = invoice.id;
        } catch (err) {
          if (!(err instanceof BadRequestException)) throw err;
          const name = `${invoice.series}${invoice.number}`;
          this.logger.warn(`sale ${saleId}: loyalty reward of appointment ${apt.id} not credited on ${name}: ${err.message}`);
          record.notOnInvoice = name;
        }
      }
      out.set(apt.id, { catalogueCents, ...(invoiceId ? { invoiceId } : {}), record });
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
    lines: TicketLine[],
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

  /** The PosDiscount rows of a ticket (money cents): one per discounted line, one for the ticket's own discount. */
  private discountRecords(
    tenantId: string,
    saleId: string,
    ticket: DiscountedTicket<PricedLine>,
    orderDiscount: DiscountSpec | null,
    actor?: PosActor,
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
   * the cents its invoice takes off, in the visit's catalogue terms
   * (`amountCents`, appointment-invoice-pricing.ts), the money given
   * (`moneyCents`), the sale, the reasons and who gave it. Other keys
   * already there stay.
   */
  private appointmentDiscountRecord(
    apt: { id: string; discount?: unknown },
    saleId: string,
    catalogueCents: number,
    moneyCents: number,
    lines: TicketLine[],
    orderDiscount: DiscountSpec | null,
    actor?: PosActor,
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
        amountCents: catalogueCents,
        ...(moneyCents !== catalogueCents ? { moneyCents } : {}),
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

  /**
   * The salon's client typed at the till: the one with that phone (last
   * nine digits, however it was stored) or that email (any case), else a
   * new one, stored like every other client (see clients/client-contact.ts).
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
   * A quick sale: one service, paid exactly with one method. The same
   * checkout as any ticket (priced in money, invoiced, idempotent by
   * `saleId`); the panel asks for confirmation first.
   */
  async quickSale(
    tenantId: string,
    serviceId: string,
    paymentMethod: string,
    clientId?: string,
    options: { saleId?: string; actor?: PosActor } = {},
  ) {
    const items = [{ serviceId, quantity: 1 }] as PosCartItemDto[];
    if (options.saleId) {
      const prior = await this.priorSale(tenantId, options.saleId);
      if (prior) return this.quickSaleAnswer(prior, paymentMethod);
    }
    const quote = await this.quote({ tenantId, items, clientId, actor: options.actor });
    const sale = await this.processCheckout(
      {
        tenantId,
        clientId,
        items,
        payments: [{ method: paymentMethod as any, amount: quote.total }],
        saleId: options.saleId,
        actor: options.actor,
      },
      'quick_sale',
    );
    return this.quickSaleAnswer(sale, paymentMethod);
  }

  private quickSaleAnswer(sale: any, paymentMethod: string) {
    const line = sale.items?.[0];
    return {
      ...sale,
      id: sale.payments?.[0]?.id,
      service: line ? { name: line.name, price: line.price / 100 } : undefined,
      amount: sale.total,
      paymentMethod,
      status: sale.payments?.[0]?.status ?? 'paid',
    };
  }

  /**
   * The ticket of a sale (`GET /pos/sales/:id/receipt`): the legal minimum
   * of a simplified invoice -- the salon's name, NIF and address, the
   * invoice number, date and time, the lines, the tax rate and amount
   * ("IVA incluido"), the total and how it was paid. Staff only reach the
   * sales they recorded.
   */
  async getReceipt(tenantId: string, saleId: string, actor?: PosActor) {
    const sale = await this.prisma.posSale.findFirst({ where: { id: saleId, tenantId } });
    if (!sale) throw new NotFoundException('Venta no encontrada');
    const scope = await this.staffScope(tenantId, actor);
    if (scope && sale.createdById !== scope.userId) {
      throw new ForbiddenException('Solo puedes ver los tickets de las ventas que has cobrado tú.');
    }
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        name: true,
        legalName: true,
        taxId: true,
        street: true,
        city: true,
        postalCode: true,
        phone: true,
        timezone: true,
        fiscalSettings: true,
      },
    });
    const invoice = sale.invoiceId
      ? await this.prisma.invoice.findFirst({
          where: { id: sale.invoiceId, tenantId },
          select: { id: true, series: true, number: true, taxBreakdown: true, totalCents: true, recipientName: true, recipientTaxId: true },
        })
      : null;
    const lines = await this.prisma.posSaleLine.findMany({ where: { saleId: sale.id }, orderBy: { lineIndex: 'asc' } });
    const result = (sale.result ?? {}) as any;
    const timeZone = safeTimeZone(tenant?.timezone);
    const at = salonDayAndTime(sale.createdAt, timeZone);
    const settings = (tenant?.fiscalSettings ?? {}) as Record<string, unknown>;
    const taxLabel = taxLabelOf(settings);
    const breakdown = new Map<number, { rate: number; baseCents: number; taxCents: number }>();
    for (const l of lines) {
      if (l.kind === 'gift_card') continue;
      const rate = Number(l.taxRate);
      const entry = breakdown.get(rate) ?? { rate, baseCents: 0, taxCents: 0 };
      entry.baseCents += l.totalCents - l.taxCents;
      entry.taxCents += l.taxCents;
      breakdown.set(rate, entry);
    }
    const settings2 = tenant ?? ({} as any);
    return {
      saleId: sale.id,
      salon: {
        name: settings2.legalName || settings2.name || '',
        tradeName: settings2.name ?? '',
        taxId: settings2.taxId ?? (typeof settings.tenantNif === 'string' ? settings.tenantNif : null),
        address: [settings2.street, [settings2.postalCode, settings2.city].filter(Boolean).join(' ')].filter(Boolean).join(', '),
        phone: settings2.phone ?? null,
      },
      invoice: invoice
        ? {
            id: invoice.id,
            number: `${invoice.series}${invoice.number}`,
            full: invoice.series !== 'T',
            recipientName: invoice.recipientName,
            recipientTaxId: invoice.recipientTaxId,
          }
        : null,
      date: at.day,
      time: at.time,
      createdAt: sale.createdAt,
      lines: lines.map((l) => ({
        kind: l.kind,
        description: l.description,
        quantity: l.quantity,
        unitPriceCents: l.unitPriceCents,
        discountCents: l.discountCents,
        totalCents: l.totalCents,
        taxRate: Number(l.taxRate),
        taxCents: l.taxCents,
      })),
      taxLabel,
      taxNote: `${taxLabel} incluido`,
      taxBreakdown: [...breakdown.values()].sort((a, b) => b.rate - a.rate),
      taxCents: lines.reduce((s, l) => s + l.taxCents, 0),
      subtotalCents: sale.subtotalCents,
      discountCents: sale.discountCents,
      loyaltyDiscountCents: sale.loyaltyDiscountCents,
      totalCents: sale.totalCents,
      payments: (Array.isArray(result.payments) ? result.payments : []).map((p: any) => ({
        method: p.method,
        amount: p.amount,
      })),
      tenderedCents: result.tendered ?? sale.totalCents + sale.changeCents,
      changeCents: sale.changeCents,
      giftCards: (Array.isArray(result.giftCards) ? result.giftCards : []).map((c: any) => ({
        code: c.code,
        amountCents: c.amountCents,
      })),
    };
  }

  /**
   * Get order/receipt details
   */
  async getOrder(tenantId: string, orderId: string, actor?: PosActor) {
    // The salon's own: any id used to be read, another salon's sale and
    // client contact included. Staff: only what they may see on the till.
    const scoped = staffPaymentFilter(await this.staffScope(tenantId, actor));
    const payment = await this.prisma.payment.findFirst({
      where: { id: orderId, tenantId, ...(scoped ? { AND: [scoped] } : {}) },
    });

    if (!payment) {
      throw new NotFoundException('Venta no encontrada');
    }

    const client = payment.clientId
      ? await this.prisma.client.findFirst({ where: { id: payment.clientId, tenantId } })
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
   * The day's sales, by hour of the salon's clock (it used to be the
   * server's, UTC). Staff see only their own sales.
   */
  async getDailyReport(tenantId: string, date: string | undefined, actor?: PosActor) {
    const scope = await this.staffScope(tenantId, actor);
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
    const timeZone = safeTimeZone(tenant?.timezone);
    const { day, start, end } = this.dayRange(date, timeZone);
    const scoped = staffPaymentFilter(scope);

    const payments = await this.prisma.payment.findMany({
      where: { tenantId, createdAt: { gte: start, lt: end }, ...(scoped ? { AND: [scoped] } : {}) },
      include: {
        client: { select: { firstName: true, lastName: true } },
        refunds: { where: { status: 'succeeded' }, select: { amount: true } },
      },
    });

    const paidPayments = payments.filter((p) => p.status === 'paid');
    // Whole refunds and partial ones (the payment stays paid): both given back.
    const refundedPayments = payments.filter((p) => refundedCents(p) > 0);

    const hourlySales = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0, amount: 0 }));
    for (const payment of paidPayments) {
      const hour = Number(salonDayAndTime(new Date(payment.createdAt), timeZone).time.slice(0, 2));
      hourlySales[hour].count += 1;
      hourlySales[hour].amount += keptCents(payment);
    }

    return {
      date: day,
      ownSalesOnly: !!scope,
      summary: {
        totalSales: paidPayments.reduce((sum, p) => sum + keptCents(p), 0),
        totalTransactions: paidPayments.length,
        refundedAmount: refundedPayments.reduce((sum, p) => sum + refundedCents(p), 0),
        refundedCount: refundedPayments.length,
      },
      hourlySales,
      payments: paidPayments.map((p) => ({
        id: p.id,
        amount: keptCents(p),
        ...(refundedCents(p) > 0 ? { refundedAmount: refundedCents(p) } : {}),
        method: p.method,
        client: p.client ? `${p.client.firstName} ${p.client.lastName}` : 'Clienta sin ficha',
        time: p.createdAt,
      })),
    };
  }
}

/**
 * Moves `delta` cents of discount onto an appointment's line (money): the
 * discount a salon whose prices are the base can actually give, or what an
 * invoiced visit's rectificativa credits. The ticket's totals follow.
 */
function adjustAppointmentLine(ticket: DiscountedTicket<PricedLine>, appointmentId: string, delta: number): void {
  const line = ticket.lines.find((l) => l.appointmentId === appointmentId && l.lineDiscountCents + l.orderDiscountCents > 0);
  if (!line) return;
  if (line.lineDiscountCents > 0) {
    line.lineDiscountCents += delta;
    ticket.lineDiscountsCents += delta;
  } else {
    line.orderDiscountCents += delta;
    ticket.orderDiscountCents += delta;
  }
  line.netCents -= delta;
  ticket.discountCents += delta;
  ticket.totalCents -= delta;
}

/**
 * A loyalty reward of `moneyCents` on a visit, in the visit's catalogue
 * terms, for a salon whose prices are the base: the base cut whose invoice
 * comes closest to the money (appointment-charge.ts visitDiscountInCatalogue),
 * over the visit as it is after the till's own discount.
 */
function loyaltyInCatalogue(
  apt: ChargeableApt,
  fiscalSettings: Record<string, unknown>,
  tillCents: number,
  moneyCents: number,
): number {
  const catalogue = appointmentTotalCents(apt) - tillCents;
  const visit = {
    ...apt.visit,
    price: catalogue / 100,
    totalAmount: catalogue,
    ...(tillCents > 0 ? { discount: { pos: { amountCents: tillCents } } } : {}),
  };
  return visitDiscountInCatalogue(visit, fiscalSettings, moneyCents).catalogueCents;
}

/**
 * What was given back of a payment, cents: its refunds, or all of it when it
 * was refunded before refunds were recorded one by one (no refund rows).
 */
function refundedCents(p: { amount: number; status: string; refunds?: Array<{ amount: number }> }): number {
  const rows = p.refunds ?? [];
  if (rows.length > 0) return rows.reduce((s, r) => s + r.amount, 0);
  return p.status === 'refunded' ? p.amount : 0;
}

/** What the salon keeps of a paid payment: its amount less its partial refunds. */
function keptCents(p: { amount: number; status: string; refunds?: Array<{ amount: number }> }): number {
  return Math.max(0, p.amount - refundedCents(p));
}
