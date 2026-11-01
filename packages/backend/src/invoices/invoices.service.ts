import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import { InvoiceCalculator } from "./invoice-calculator.service";
import { FiscalService } from "./fiscal/fiscal.service";
import { AccountingService, cancelNeedsMirror } from "../accounting/accounting.service";
import { FiscalMode, InvoiceSource, InvoiceStatus, Prisma } from "@prisma/client";
import { appointmentInvoiceLines } from "./appointment-invoice-pricing";
import { pricesIncludeTaxOf } from "./salon-tax-settings";
import { addonServices } from "../appointments/visit-sync";
import { randomUUID } from "crypto";
import { TAX_REGIME_LABELS, TAX_REGIME_RATES, taxRegimeOf } from "@kira/shared";
import {
  RECTIFICATION_SERIES,
  RESERVED_SERIES,
  SIMPLIFIED_SERIES,
  dayOfIssueDate,
  formatInvoiceNumber,
  issueDateOfDay,
  salonDay,
} from "./invoice-numbering";
import { breakdownRate } from "./invoice-calculator.service";
import {
  amountCreditLines,
  rectificationLines,
  type PriorRectificationLine,
  type RectificationContext,
  type RectificationLineRequest,
} from "./rectification-lines";
import type { InvoiceLineInput } from "./invoice-calculator.service";

interface CreateInvoiceInput {
  tenantId: string;
  series?: string;
  issueDate?: Date;
  recipientType?: "client" | "tenant";
  recipientId?: string;
  recipientName: string;
  recipientTaxId?: string;
  recipientAddress?: Record<string, unknown>;
  lines: Array<{
    description: string;
    quantity: number;
    unitPriceCents: number;
    discountPct?: number;
    /** A discount on the whole line, in cents (InvoiceLineInput.discountCents). */
    discountCents?: number;
    taxRate: number;
    productId?: string;
    serviceId?: string;
    taxIncluded?: boolean;
    /** Amounts taken as they are (InvoiceLineInput.fixed): a rectification. */
    fixed?: { taxCents: number; totalCents: number };
    /** On a rectificativa: the line of the original it credits. */
    rectifiesLineId?: string;
    /** The loyalty reward's part of discountCents (InvoiceLineInput.loyaltyDiscountCents). */
    loyaltyDiscountCents?: number;
    /** The invoice's rounding remainder on this line's tax (InvoiceLineInput.roundingCents). */
    roundingCents?: number;
  }>;
  /**
   * Lines that leave `taxIncluded` out follow the salon's
   * `fiscalSettings.pricesIncludeTax` (salon-tax-settings.ts) instead of
   * taking the tax on top. POST /invoices sets it; explicit true or false
   * on a line still wins.
   */
  taxIncludedFromSalon?: boolean;
  notes?: string;
  /**
   * What the invoice is for (an appointment, an order). Unique per tenant:
   * a second invoice for the same source fails with P2002. Omitted: manual.
   */
  source?: { type: InvoiceSource; id: string };
}

/** An invoice just numbered and stored: what afterIssue() needs. */
export interface IssuedInvoice {
  id: string;
  fiscalMode: FiscalMode;
}

/** A line of a sale at the till, for its simplified invoice. */
export interface SimplifiedInvoiceLine {
  description: string;
  quantity: number;
  /** Unit price in cents, with the tax included or not (taxIncluded). */
  unitPriceCents: number;
  /** Percent (21, 7, 9.5). */
  taxRate: number;
  /** Left out: the salon's pricesIncludeTax (Ajustes fiscales). */
  taxIncluded?: boolean;
  /** A discount on the whole line, in cents (InvoiceLineInput.discountCents). */
  discountCents?: number;
  /** The loyalty reward's part of discountCents ("Descuento fidelidad" on the PDF). */
  loyaltyDiscountCents?: number;
  productId?: string;
  serviceId?: string;
}

export interface SimplifiedSaleInvoiceInput {
  tenantId: string;
  /**
   * The sale this invoice is for, and the idempotency key: one live invoice
   * per sale (sourceType pos_sale, sourceId = saleId). The till's own id for
   * the ticket or, for a sale with no row of its own, a stable id derived
   * from its payments (e.g. the first payment's id).
   */
  saleId: string;
  /** The payments the sale was charged with: named in the invoice's notes. */
  paymentIds?: string[];
  lines: SimplifiedInvoiceLine[];
  /** The salon's client, if the sale has one: named on the invoice (with her NIF if known). */
  clientId?: string;
  /** Defaults to now; the salon's calendar day of it is the issue date. */
  issueDate?: Date;
  /**
   * A full invoice (factura completa) instead: the salon's default series,
   * no 3.000 EUR cap, and the client must have a NIF (her name and NIF go on
   * it). For a sale over SIMPLIFIED_INVOICE_MAX_CENTS.
   */
  full?: boolean;
}

export interface SimplifiedSaleInvoice extends IssuedInvoice {
  series: string;
  number: string;
  /** False: the sale already had its invoice, returned as it is (nothing to dispatch). */
  created: boolean;
}

/**
 * A simplified invoice (factura simplificada) may not exceed 3.000 EUR, tax
 * included, for hairdressing and beauty services (RD 1619/2012, art. 4.1).
 */
export const SIMPLIFIED_INVOICE_MAX_CENTS = 300_000;

/**
 * InvoiceSource "pos_sale" (migration 20261101190000). Spelled out rather
 * than InvoiceSource.pos_sale so this compiles against a Prisma client
 * generated before the value existed.
 */
export const POS_SALE_SOURCE = "pos_sale" as InvoiceSource;

type RectifiableInvoice = Prisma.InvoiceGetPayload<{ include: { lines: true } }>;

/**
 * How every rectificativa's note starts ("Rectificación de A000123:"). For
 * those issued before rectifiesLineId it is the only link to the original.
 */
export function rectificationNotePrefix(original: { series: string; number: string }): string {
  return `Rectificación de ${original.series}${original.number}:`;
}

@Injectable()
export class InvoiceService {
  private readonly logger = new Logger(InvoiceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly calculator: InvoiceCalculator,
    private readonly fiscal: FiscalService,
    @Optional() private readonly accounting?: AccountingService,
  ) {}

  async create(input: CreateInvoiceInput): Promise<{ id: string }> {
    const prepared = await this.prepare(input);
    // Number and invoice in one transaction: when the insert fails (a source
    // that already has its invoice, see fromAppointment) the number is given
    // back, so the series stays correlative with no gaps.
    const invoice = await this.prisma.$transaction((tx) => this.insert(tx, input, prepared));
    this.afterIssue(invoice);
    return { id: invoice.id };
  }

  /**
   * The amounts, series, date and fiscal mode of an invoice about to be
   * issued, from its lines and the salon's fiscal settings. Read with `db`:
   * the caller's transaction when the invoice is issued inside one.
   */
  private async prepare(input: CreateInvoiceInput, db: Prisma.TransactionClient = this.prisma) {
    if (!input.lines?.length) {
      throw new BadRequestException("Invoice must have at least one line");
    }
    const tenant = await db.tenant.findUnique({
      where: { id: input.tenantId },
      select: { fiscalMode: true, fiscalSettings: true, timezone: true, name: true, legalName: true, taxId: true },
    });
    if (!tenant) {
      throw new NotFoundException("Tenant not found");
    }
    const settings = (tenant.fiscalSettings as Record<string, unknown>) ?? {};
    const lines = input.taxIncludedFromSalon
      ? input.lines.map((l) =>
          l.taxIncluded === undefined || l.taxIncluded === null
            ? { ...l, taxIncluded: pricesIncludeTaxOf(settings) }
            : l,
        )
      : input.lines;
    const computation = this.calculator.compute(lines);
    const series = input.series ?? (settings.defaultSeries as string) ?? "A";
    // The salon's calendar day, stored at 00:00 UTC; its year is the
    // numbering year (invoice-numbering.ts).
    const day = dayOfIssueDate(input.issueDate ?? new Date(), tenant.timezone);
    const issueDate = issueDateOfDay(day);
    // The issuer as it is now, kept on the invoice: its PDF prints these even
    // if the salon later changes its razón social or NIF.
    const issuer = {
      name: tenant.legalName || tenant.name,
      taxId: tenant.taxId ?? (typeof settings.tenantNif === "string" ? settings.tenantNif : null),
    };
    return { computation, series, issueDate, year: Number(day.slice(0, 4)), fiscalMode: tenant.fiscalMode, issuer };
  }

  /** Numbers and stores the invoice, inside `tx`. */
  private async insert(
    tx: Prisma.TransactionClient,
    input: CreateInvoiceInput,
    prepared: Awaited<ReturnType<InvoiceService["prepare"]>>,
  ): Promise<IssuedInvoice & { series: string; number: string }> {
    const { computation, series, issueDate, year, fiscalMode, issuer } = prepared;
    const number = await this.allocateNumber(input.tenantId, series, year, tx);
    const invoice = await tx.invoice.create({
      data: {
        tenantId: input.tenantId,
        series,
        number,
        issueDate,
        recipientType: input.recipientType ?? "client",
        recipientId: input.recipientId,
        recipientName: input.recipientName,
        recipientTaxId: input.recipientTaxId,
        recipientAddress: input.recipientAddress as any,
        subtotalCents: computation.subtotalCents,
        taxBreakdown: computation.taxBreakdown as any,
        totalCents: computation.totalCents,
        currency: "EUR",
        status: InvoiceStatus.issued,
        fiscalMode,
        fiscalStatus:
          fiscalMode === FiscalMode.none ? "not_required" : "pending",
        sourceType: input.source?.type ?? InvoiceSource.manual,
        sourceId: input.source?.id,
        notes: input.notes,
        issuerNameAtIssue: issuer.name,
        issuerTaxIdAtIssue: issuer.taxId,
        lines: {
          create: computation.lines.map((l) => ({
            description: l.description,
            quantity: l.quantity as any,
            unitPriceCents: l.unitPriceCents,
            discountPct: l.discountPct as any,
            taxRate: l.taxRate as any,
            taxCents: l.taxCents,
            totalCents: l.totalCents,
            productId: l.productId,
            serviceId: l.serviceId,
            taxIncluded: l.taxIncluded,
            ...(l.rectifiesLineId ? { rectifiesLineId: l.rectifiesLineId } : {}),
            ...(l.loyaltyDiscountCents ? { loyaltyDiscountCents: l.loyaltyDiscountCents } : {}),
          })),
        },
      },
    });
    return { id: invoice.id, fiscalMode, series, number };
  }

  /**
   * What follows an invoice once it is committed: the fiscal dispatch and
   * the push to Holded, both in the background. An invoice issued inside a
   * caller's transaction (rectifyByAmountIn) is handed back to it to call
   * this after its commit.
   */
  afterIssue(invoice: IssuedInvoice): void {
    // Fire fiscal dispatch in the background. Failures don't roll back the
    // invoice — the operator can retry via /invoices/:id/resend-fiscal.
    if (invoice.fiscalMode !== FiscalMode.none) {
      void this.fiscal.dispatchInvoice(invoice.id).catch((err) => {
        this.logger.warn(
          `Background fiscal dispatch failed for ${invoice.id}: ${(err as Error).message}`,
        );
      });
    }

    // Push to Holded if the salon connected it (a no-op otherwise). Started
    // after the fiscal dispatch; failures are recorded on the invoice and
    // retried by AccountingScheduler, never thrown back here.
    if (this.accounting) {
      void this.accounting.syncInvoice(invoice.id).catch((err) => {
        this.logger.warn(
          `Background accounting sync failed for ${invoice.id}: ${(err as Error).message}`,
        );
      });
    }
  }

  /**
   * The next correlative number of (tenant, series, year), formatted
   * (formatInvoiceNumber: "000123" up to 2026, "2027-000001" from 2027).
   *
   * One statement: INSERT ... ON CONFLICT DO UPDATE ... RETURNING creates the
   * counter at 1 or increments it, atomically, also when two transactions
   * create the same counter at once (the second waits for the first and then
   * increments). The upsert it replaces (create at 0, then increment) raced
   * there: the first invoices of a new series or year issued at once failed
   * with a unique violation. Called with create()'s transaction, the counter
   * row stays locked until the invoice commits, or rolls back and gives the
   * number back; the unique index on Invoice(tenantId, series, number)
   * remains the last line of defence.
   */
  async allocateNumber(
    tenantId: string,
    series: string,
    year: number,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<string> {
    const rows = await db.$queryRaw<Array<{ lastNumber: number }>>`
      INSERT INTO "fiscal_sequences" ("id", "tenantId", "series", "year", "lastNumber")
      VALUES (${randomUUID()}, ${tenantId}, ${series}, ${year}, 1)
      ON CONFLICT ("tenantId", "series", "year")
      DO UPDATE SET "lastNumber" = "fiscal_sequences"."lastNumber" + 1
      RETURNING "lastNumber"`;
    const next = Number(rows?.[0]?.lastNumber);
    if (!Number.isInteger(next) || next < 1) {
      throw new Error(`Invoice numbering failed for series ${series} ${year}`);
    }
    return formatInvoiceNumber(year, next);
  }

  async findOne(tenantId: string, id: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, tenantId },
      include: { lines: true },
    });
    if (!invoice) throw new NotFoundException("Invoice not found");
    return invoice;
  }

  /**
   * The salon's invoices, newest first, a page at a time (at most 100). `q`
   * finds a number ("A2027-000012", "000012", "12"), a client's name or a
   * NIF. Dates are whole days, both ends included.
   */
  async list(
    tenantId: string,
    filters: {
      series?: string;
      status?: string;
      q?: string;
      dateFrom?: string;
      dateTo?: string;
      /** Older names of dateFrom / dateTo, still accepted. */
      fromDate?: string;
      toDate?: string;
      limit?: number;
      offset?: number;
      page?: number;
    },
  ) {
    const where: Prisma.InvoiceWhereInput = { tenantId };
    if (filters.series) where.series = filters.series;
    if (filters.status) where.status = filters.status as InvoiceStatus;
    const from = filters.dateFrom ?? filters.fromDate;
    const to = filters.dateTo ?? filters.toDate;
    if (from || to) {
      // An issue date is the salon's day at 00:00 UTC (older ones, an
      // instant during it): the last day counts whole.
      where.issueDate = {
        ...(from ? { gte: issueDateOfDay(from) } : {}),
        ...(to ? { lt: new Date(issueDateOfDay(to).getTime() + DAY_MS) } : {}),
      };
    }
    const q = filters.q?.trim();
    if (q) where.OR = invoiceSearch(q);
    const take = Math.min(Math.max(Math.trunc(filters.limit ?? 50), 1), 100);
    const skip =
      filters.offset !== undefined
        ? Math.max(Math.trunc(filters.offset), 0)
        : filters.page && filters.page > 1
          ? (Math.trunc(filters.page) - 1) * take
          : 0;
    return this.prisma.invoice.findMany({
      where,
      orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }],
      take,
      skip,
      include: { lines: true },
    });
  }

  /**
   * A manual invoice (POST /invoices). Refused in Spanish: a series KiraRoom
   * issues itself (R for rectificativas, T for tickets), an issue date other
   * than today's (the salon's: an invoice is dated the day it is issued, and
   * an earlier date would break the series' order), a tax rate the salon's
   * regime does not have, a line without a quantity.
   */
  async createManual(input: CreateInvoiceInput): Promise<{ id: string }> {
    const series = input.series?.trim() || undefined;
    if (series !== undefined && RESERVED_SERIES.includes(series.toUpperCase())) {
      throw new BadRequestException(
        `La serie "${series}" está reservada: R es la de las rectificativas y T la de los tickets. Usa otra serie.`,
      );
    }
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: input.tenantId },
      select: { fiscalSettings: true, timezone: true },
    });
    if (!tenant) throw new NotFoundException("Tenant not found");
    if (input.issueDate) {
      const now = new Date();
      const sent = input.issueDate.toISOString().slice(0, 10);
      const today = salonDay(now, tenant.timezone);
      // A browser that works out "today" in UTC is a day behind just after
      // midnight: that is today as well.
      if (sent !== today && sent !== now.toISOString().slice(0, 10)) {
        throw new BadRequestException(
          `La fecha de expedición de una factura es la de hoy (${spanishDay(today)}): no se pueden emitir facturas con otra fecha.`,
        );
      }
    }
    for (const line of input.lines ?? []) {
      if (!(Number(line.quantity) > 0)) {
        throw new BadRequestException(`La cantidad de la línea "${line.description}" tiene que ser mayor que cero.`);
      }
    }
    assertRegimeRates(tenant.fiscalSettings, input.lines ?? []);
    // Always today, the salon's.
    return this.create({ ...input, series, issueDate: undefined });
  }

  /**
   * The simplified invoice (factura simplificada, series T) of a sale at the
   * till, issued inside the caller's transaction `tx` (the sale's own), so
   * the sale and its invoice commit or roll back together. Numbered like any
   * invoice (its own correlative series T per year).
   *
   * Idempotent by the sale: sourceType pos_sale, sourceId = saleId. A second
   * call for the same sale (a retry, or two at once: they wait for each
   * other here) returns the invoice already issued, `created: false`. A
   * cancelled one does not count: the sale can be invoiced again.
   *
   * Refused (400): no lines, a total over 3.000 EUR
   * (SIMPLIFIED_INVOICE_MAX_CENTS: that needs a full invoice), a client that
   * is not this salon's. When `created`, the caller calls afterIssue() once
   * its transaction commits (fiscal dispatch, Holded).
   */
  async issueSimplifiedInvoiceForSale(
    tx: Prisma.TransactionClient,
    input: SimplifiedSaleInvoiceInput,
  ): Promise<SimplifiedSaleInvoice> {
    const { tenantId, saleId } = input;
    if (!saleId) throw new BadRequestException("Falta la venta de la factura simplificada.");
    const lockKey = `invoice:pos_sale:${tenantId}:${saleId}`;
    await tx.$queryRaw`SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))) AS l`;
    const existing = await tx.invoice.findFirst({
      where: {
        tenantId,
        sourceType: POS_SALE_SOURCE,
        sourceId: saleId,
        status: { not: InvoiceStatus.cancelled },
      },
      select: { id: true, fiscalMode: true, series: true, number: true },
    });
    if (existing) return { ...existing, created: false };
    if (input.full && !input.clientId) {
      throw new BadRequestException("Una factura completa necesita la clienta con su NIF.");
    }

    let recipient: Pick<
      CreateInvoiceInput,
      "recipientType" | "recipientId" | "recipientName" | "recipientTaxId" | "recipientAddress"
    > = {
      recipientType: "tenant",
      recipientName: "Consumidor final",
    };
    if (input.clientId) {
      const client = await tx.client.findFirst({
        where: { id: input.clientId, tenantId },
        select: { id: true, firstName: true, lastName: true, taxId: true },
      });
      if (!client) throw new BadRequestException("La clienta de la venta no es de este salón.");
      if (input.full && !client.taxId?.trim()) {
        throw new BadRequestException(
          "Para una factura completa la clienta tiene que tener su NIF en la ficha.",
        );
      }
      recipient = {
        recipientType: "client",
        recipientId: client.id,
        recipientName: `${client.firstName} ${client.lastName}`.trim(),
        recipientTaxId: client.taxId ?? undefined,
      };
    }
    const paymentIds = (input.paymentIds ?? []).filter(Boolean);
    const invoiceInput: CreateInvoiceInput = {
      tenantId,
      // A full invoice: the salon's own series (prepare() reads its defaultSeries).
      series: input.full ? undefined : SIMPLIFIED_SERIES,
      issueDate: input.issueDate,
      ...recipient,
      lines: input.lines,
      taxIncludedFromSalon: true,
      notes: input.full
        ? `Factura de la venta ${saleId}${paymentIds.length ? ` (pagos: ${paymentIds.join(", ")})` : ""}`
        : paymentIds.length
        ? `Factura simplificada de la venta ${saleId} (pagos: ${paymentIds.join(", ")})`
        : `Factura simplificada de la venta ${saleId}`,
      source: { type: POS_SALE_SOURCE, id: saleId },
    };
    const prepared = await this.prepare(invoiceInput, tx);
    if (!input.full && prepared.computation.totalCents > SIMPLIFIED_INVOICE_MAX_CENTS) {
      throw new BadRequestException(
        "Una factura simplificada no puede pasar de 3.000,00 € (impuestos incluidos): emite una factura completa.",
      );
    }
    const issued = await this.insert(tx, invoiceInput, prepared);
    return { ...issued, created: true };
  }

  /**
   * Cancels an invoice (status cancelled), with a reason. Refused while it
   * has rectificativas that are not cancelled: the tax reports would then
   * count only the negative rectificativa. An appointment whose invoice is
   * cancelled can be invoiced again (the source's unique index only covers
   * live invoices).
   */
  async cancel(tenantId: string, id: string, reason: string) {
    const why = requireReason(reason);
    const updated = await this.prisma.$transaction(async (tx) => {
      // The lock a rectificativa takes on its original (rectifyIn): none is
      // issued while this decides.
      await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`;
      const invoice = await tx.invoice.findFirst({ where: { id, tenantId }, include: { lines: true } });
      if (!invoice) throw new NotFoundException("Invoice not found");
      if (invoice.status === InvoiceStatus.cancelled) {
        throw new BadRequestException("La factura ya está anulada.");
      }
      await this.assertNoLiveRectifications(tx, invoice);
      return tx.invoice.update({
        where: { id },
        data: {
          status: InvoiceStatus.cancelled,
          notes: [invoice.notes, `CANCELLED: ${why}`].filter(Boolean).join("\n"),
          ...this.holdedCancelMark(invoice),
        },
      });
    });
    this.mirrorCancellation(id);
    return updated;
  }

  /** 400 when `invoice` has rectificativas that are not cancelled. */
  private async assertNoLiveRectifications(db: Prisma.TransactionClient, invoice: RectifiableInvoice): Promise<void> {
    const live = await db.invoice.findMany({
      where: this.rectificationsOf(invoice),
      select: { series: true, number: true },
    });
    if (live.length > 0) {
      const names = live.map((r) => `${r.series}${r.number}`).join(", ");
      throw new BadRequestException(
        `La factura ${invoice.series}${invoice.number} tiene rectificativas emitidas (${names}). ` +
          "Anula antes las rectificativas, o emite una rectificativa en lugar de anular la factura.",
      );
    }
  }

  /**
   * An invoice already sent to Holded stayed there as a live sale after it
   * was cancelled here. Marked in the same update that cancels it, so the
   * mirroring cannot be lost; AccountingService does it (and retries it).
   */
  private holdedCancelMark(invoice: { accountingExternalId: string | null; accountingStatus: string }) {
    return cancelNeedsMirror(invoice) ? { accountingCancelStatus: "pending" as const } : {};
  }

  private mirrorCancellation(id: string): void {
    if (!this.accounting) return;
    void this.accounting.reflectCancellation(id).catch((err) => {
      this.logger.warn(`Background Holded cancellation failed for ${id}: ${(err as Error).message}`);
    });
  }

  /**
   * Anular: marks the invoice cancelled AND, if fiscalMode!=none,
   * emits the AEAT/TBAI `<RegistroAnulacion>` envelope via FiscalService.
   */
  async anulate(tenantId: string, id: string, reason: string) {
    reason = requireReason(reason);
    const invoice = await this.findOne(tenantId, id);
    if (invoice.status === InvoiceStatus.cancelled) {
      throw new BadRequestException("La factura ya está anulada.");
    }
    // As cancel(): not while it has live rectificativas.
    await this.assertNoLiveRectifications(this.prisma, invoice);

    let fiscalAnulated = false;
    if (this.fiscal) {
      try {
        fiscalAnulated = await this.fiscal.anulateInvoice(id, reason);
      } catch (err) {
        this.logger.warn(
          `Fiscal anulation failed for ${id}: ${(err as Error).message}`,
        );
      }
    }

    const updated = await this.prisma.invoice.update({
      where: { id },
      data: {
        status: InvoiceStatus.cancelled,
        notes: [
          invoice.notes,
          `ANULATED: ${reason}${fiscalAnulated ? " [fiscal OK]" : " [fiscal pending]"}`,
        ]
          .filter(Boolean)
          .join("\n"),
        ...this.holdedCancelMark(invoice),
      },
    });
    this.mirrorCancellation(id);
    return { ...updated, fiscalAnulated };
  }

  /**
   * Rectify: creates a NEW invoice with series="R" referencing the
   * original, marked with the negative amount delta. Used for partial
   * refunds, discounts, etc. No lines: what is left of the whole original
   * (for one never rectified, each line's stored amounts negated, so the
   * two net to zero). Lines that name an original line credit it from what
   * is left of it; past what is left is refused (rectification-lines.ts).
   * Free lines without taxIncluded follow the salon's pricesIncludeTax.
   */
  async emitRectification(
    tenantId: string,
    originalInvoiceId: string,
    lines: RectificationLineRequest[] | undefined,
    reason: string,
  ): Promise<{ id: string }> {
    const issued = await this.prisma.$transaction((tx) =>
      this.rectifyIn(tx, tenantId, originalInvoiceId, reason, (original, context) =>
        rectificationLines(original.lines, lines, context),
      ),
    );
    this.afterIssue(issued);
    return { id: issued.id };
  }

  /**
   * A rectificativa by difference for `amountCents` of the invoice's price
   * (a discount given at the till after the invoice was issued), issued
   * inside the caller's transaction like any other rectificativa: series
   * R, numbered, linked line by line to the original and counted in what is
   * left to credit of it. The caller calls afterIssue() once it commits.
   */
  rectifyByAmountIn(
    tx: Prisma.TransactionClient,
    tenantId: string,
    originalInvoiceId: string,
    amountCents: number,
    reason: string,
    /** The money the credit stands for: the rectificativa credits it exactly (amountCreditLines). */
    moneyCents?: number,
  ): Promise<IssuedInvoice> {
    return this.rectifyIn(tx, tenantId, originalInvoiceId, reason, (original, context) =>
      amountCreditLines(original.lines, amountCents, context, moneyCents),
    );
  }

  /**
   * Throws what rectifyByAmountIn would refuse (a cancelled invoice, more
   * than is left to credit), without issuing anything or locking: a check
   * before a sale is written. rectifyByAmountIn checks again under the lock.
   */
  async assertCreditable(tenantId: string, originalInvoiceId: string, amountCents: number): Promise<number> {
    const original = await this.rectifiable(this.prisma, tenantId, originalInvoiceId);
    const lines = amountCreditLines(original.lines, amountCents, await this.creditContext(this.prisma, original));
    // What the rectificativa would credit, in money (tax included): its lines' totals are negative.
    return -lines.reduce((sum, l) => sum + (l.fixed?.totalCents ?? this.calculator.compute([l]).totalCents), 0);
  }

  private async rectifyIn(
    tx: Prisma.TransactionClient,
    tenantId: string,
    originalInvoiceId: string,
    reason: string,
    linesOf: (original: RectifiableInvoice, context: RectificationContext) => InvoiceLineInput[],
  ): Promise<IssuedInvoice> {
    // One rectificativa of an invoice at a time: a second one waits here
    // until the first commits, and then sees what it credited.
    await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${originalInvoiceId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    const original = await this.rectifiable(tx, tenantId, originalInvoiceId);
    const input: CreateInvoiceInput = {
      tenantId,
      series: RECTIFICATION_SERIES,
      recipientType: "client",
      recipientId: original.recipientId ?? undefined,
      recipientName: original.recipientName,
      recipientTaxId: original.recipientTaxId ?? undefined,
      lines: linesOf(original, {
        ...(await this.creditContext(tx, original)),
        // A free line that does not say whether its price includes the tax
        // is read the way the salon prices (Ajustes fiscales), like a manual
        // invoice line (POST /invoices).
        freeLinesTaxIncluded: await this.salonPricesIncludeTax(tx, tenantId),
      }),
      notes: `${rectificationNotePrefix(original)} ${reason}`,
    };
    const { id, fiscalMode } = await this.insert(tx, input, await this.prepare(input, tx));
    return { id, fiscalMode };
  }

  private async salonPricesIncludeTax(db: Prisma.TransactionClient, tenantId: string): Promise<boolean> {
    const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { fiscalSettings: true } });
    return pricesIncludeTaxOf(tenant?.fiscalSettings);
  }

  /** The invoice to rectify, with its lines: 404 if not this salon's, 400 if cancelled. */
  private async rectifiable(
    db: Prisma.TransactionClient,
    tenantId: string,
    id: string,
  ): Promise<RectifiableInvoice> {
    const invoice = await db.invoice.findFirst({ where: { id, tenantId }, include: { lines: true } });
    if (!invoice) throw new NotFoundException("Invoice not found");
    if (invoice.status === InvoiceStatus.cancelled) {
      throw new BadRequestException(
        `La factura ${invoice.series}${invoice.number} está anulada: no se puede rectificar`,
      );
    }
    return invoice;
  }

  /**
   * What earlier rectificativas of `original` credited: the lines of every
   * non-cancelled one. Found by the line link (rectifiesLineId) and by the
   * note every rectificativa carries ("Rectificación de A000123: ..."), which
   * is the only link the ones issued before the line link have. Their lines
   * have no rectifiesLineId and count against the invoice as a whole
   * (rectification-lines.ts).
   */
  private async creditContext(db: Prisma.TransactionClient, original: RectifiableInvoice) {
    const earlier = await db.invoice.findMany({
      where: this.rectificationsOf(original),
      select: { lines: { select: { rectifiesLineId: true, quantity: true, taxCents: true, totalCents: true } } },
    });
    return {
      prior: earlier.flatMap((inv) => inv.lines) as PriorRectificationLine[],
      invoiceTotalCents: original.totalCents,
    };
  }

  async resendFiscal(tenantId: string, id: string) {
    const invoice = await this.findOne(tenantId, id);
    if (invoice.fiscalStatus === "not_required") {
      throw new BadRequestException("Invoice has no fiscal mode configured");
    }
    await this.prisma.invoice.update({
      where: { id },
      data: {
        fiscalStatus: "pending",
        fiscalError: null,
      },
    });
    await this.fiscal.dispatchInvoice(id);
    return this.findOne(tenantId, id);
  }

  /** The live (not cancelled) rectificativas of `original`, by note or line link (see creditContext). */
  private rectificationsOf(original: RectifiableInvoice): Prisma.InvoiceWhereInput {
    const lineIds = original.lines.map((l) => l.id);
    return {
      tenantId: original.tenantId,
      id: { not: original.id },
      status: { not: InvoiceStatus.cancelled },
      OR: [
        { notes: { startsWith: rectificationNotePrefix(original) } },
        ...(lineIds.length ? [{ lines: { some: { rectifiesLineId: { in: lineIds } } } }] : []),
      ],
    };
  }

  /**
   * Convert a completed appointment into an invoice. On completion
   * (AppointmentService) only for salons that opted in
   * (`fiscalSettings.autoInvoiceAppointments`); asked for explicitly
   * (POST /invoices/from-appointment/:id, `requested`) whatever that setting,
   * and only for an appointment of `tenantId`.
   *
   * Idempotent: an appointment has at most one live invoice. The invoice
   * carries sourceType "appointment" + sourceId, unique per tenant among
   * invoices that are not cancelled, so completing twice, or two completions
   * at once, return the invoice already issued instead of a second one (an
   * issued invoice cannot simply be withdrawn: with VERI*FACTU it is already
   * chained and sent). Once its invoice is cancelled, the appointment can be
   * invoiced again.
   */
  async fromAppointment(
    appointmentId: string,
    options: { tenantId?: string; requested?: boolean } = {},
  ): Promise<{ id: string } | null> {
    const appt = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        client: true,
        service: true,
        tenant: { select: { fiscalSettings: true } },
        // Every service of the visit, for one line each.
        services: { include: { service: true }, orderBy: [{ order: "asc" }, { createdAt: "asc" }, { id: "asc" }] },
      },
    });
    if (!appt || (options.tenantId !== undefined && appt.tenantId !== options.tenantId)) {
      if (options.requested) throw new NotFoundException("Cita no encontrada");
      return null;
    }

    const existing = await this.appointmentInvoice(appt.tenantId, appt.id);
    if (existing) return existing;

    if (appt.status !== "completed") {
      if (options.requested) {
        throw new BadRequestException("Solo se puede facturar una cita completada.");
      }
      return null;
    }
    const settings =
      (appt.tenant.fiscalSettings as Record<string, unknown>) ?? {};
    if (!settings.autoInvoiceAppointments && !options.requested) return null;

    try {
      return await this.create({
        tenantId: appt.tenantId,
        recipientType: appt.client ? "client" : "tenant",
        recipientId: appt.client?.id,
        recipientName: appt.client
          ? `${appt.client.firstName} ${appt.client.lastName}`
          : "Consumidor final",
        // The client's NIF, as a manual invoice for her would carry it.
        recipientTaxId: appt.client?.taxId ?? undefined,
        lines: appointmentInvoiceLines(
          { ...appt, addons: await addonServices(this.prisma, appt.tenantId, (appt as any).addons) },
          settings,
        ),
        notes: `Generada desde cita ${appt.id}`,
        source: { type: InvoiceSource.appointment, id: appt.id },
      });
    } catch (err) {
      // Lost the race to a concurrent call: its invoice is the one. Our
      // transaction rolled back, number included.
      if (isUniqueViolation(err)) {
        const winner = await this.appointmentInvoice(appt.tenantId, appt.id);
        if (winner) return winner;
      }
      throw err;
    }
  }

  /** The live (not cancelled) invoice of an appointment, if any. */
  private appointmentInvoice(tenantId: string, appointmentId: string): Promise<{ id: string } | null> {
    return this.prisma.invoice.findFirst({
      where: {
        tenantId,
        sourceType: InvoiceSource.appointment,
        sourceId: appointmentId,
        status: { not: InvoiceStatus.cancelled },
      },
      select: { id: true },
    });
  }
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A cancellation's reason, trimmed: 400 when there is none. */
function requireReason(reason: string | undefined | null): string {
  const why = typeof reason === "string" ? reason.trim() : "";
  if (!why) throw new BadRequestException("Indica el motivo de la anulación.");
  return why;
}

/** "2026-11-01" as "01/11/2026". */
function spanishDay(day: string): string {
  const [y, m, d] = day.split("-");
  return `${d}/${m}/${y}`;
}

/**
 * 400 when a line's tax rate is not one of the salon's regime
 * (TAX_REGIME_RATES: IVA 0/4/10/21, IGIC 0/3/7/9,5/15/20, IPSI ...).
 */
export function assertRegimeRates(fiscalSettings: unknown, lines: Array<{ taxRate: number }>): void {
  const regime = taxRegimeOf(fiscalSettings);
  const allowed = TAX_REGIME_RATES[regime];
  for (const line of lines) {
    const rate = breakdownRate(Number(line.taxRate));
    if (!allowed.includes(rate)) {
      const list = allowed.map((r) => String(r).replace(".", ",")).join(", ");
      throw new BadRequestException(
        `El tipo de ${TAX_REGIME_LABELS[regime]} del ${String(line.taxRate).replace(".", ",")} % no existe. ` +
          `Los tipos de ${TAX_REGIME_LABELS[regime]} son: ${list} %.`,
      );
    }
  }
}

/**
 * What `q` matches in the invoice list: the number ("A2027-000012" splits
 * into series A and number 2027-000012; "000012", "12" match a part of the
 * number), the recipient's name or NIF.
 */
function invoiceSearch(q: string): Prisma.InvoiceWhereInput[] {
  const or: Prisma.InvoiceWhereInput[] = [
    { number: { contains: q } },
    { recipientName: { contains: q, mode: "insensitive" } },
    { recipientTaxId: { contains: q.replace(/[\s.-]/g, ""), mode: "insensitive" } },
  ];
  const full = /^([A-Za-z]+)[\s-]?(\d[\d-]*)$/.exec(q);
  if (full) or.push({ series: { equals: full[1], mode: "insensitive" }, number: { contains: full[2] } });
  return or;
}
