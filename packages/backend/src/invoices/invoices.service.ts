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
import { pricesIncludeTaxOf, productTaxRatePercent, salonTaxRate } from "./salon-tax-settings";
import { addonServices } from "../appointments/visit-sync";
import { allocateCents } from "../pos/pos-discounts";
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
      select: { fiscalMode: true, fiscalSettings: true },
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
    const issueDate = input.issueDate ?? new Date();
    return { computation, series, issueDate, year: issueDate.getFullYear(), fiscalMode: tenant.fiscalMode };
  }

  /** Numbers and stores the invoice, inside `tx`. */
  private async insert(
    tx: Prisma.TransactionClient,
    input: CreateInvoiceInput,
    prepared: Awaited<ReturnType<InvoiceService["prepare"]>>,
  ): Promise<IssuedInvoice> {
    const { computation, series, issueDate, year, fiscalMode } = prepared;
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
          })),
        },
      },
    });
    return { id: invoice.id, fiscalMode };
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
   * Atomically allocate the next correlative number for (tenant, series, year).
   * Uses an upsert-on-unique-conflict pattern to be safe under concurrent
   * invoice creation — the unique constraint on (tenantId, series, year)
   * serialises the increment.
   */
  async allocateNumber(
    tenantId: string,
    series: string,
    year: number,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<string> {
    // First call creates the row at 0; subsequent calls increment.
    await db.fiscalSequence.upsert({
      where: {
        tenantId_series_year: { tenantId, series, year },
      },
      create: {
        tenantId,
        series,
        year,
        lastNumber: 0,
      },
      update: {},
    });

    // Increment and read the new value atomically. Called with create()'s
    // transaction, the row stays locked until the invoice commits (or rolls
    // back, returning the number); the unique index on
    // Invoice(tenantId, series, number) remains the last line of defence.
    const updated = await db.fiscalSequence.update({
      where: { tenantId_series_year: { tenantId, series, year } },
      data: { lastNumber: { increment: 1 } },
    });

    return String(updated.lastNumber).padStart(6, "0");
  }

  async findOne(tenantId: string, id: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, tenantId },
      include: { lines: true },
    });
    if (!invoice) throw new NotFoundException("Invoice not found");
    return invoice;
  }

  async list(
    tenantId: string,
    filters: {
      series?: string;
      status?: string;
      fromDate?: string;
      toDate?: string;
      limit?: number;
    },
  ) {
    const where: any = { tenantId };
    if (filters.series) where.series = filters.series;
    if (filters.status) where.status = filters.status;
    if (filters.fromDate || filters.toDate) {
      where.issueDate = {};
      if (filters.fromDate) where.issueDate.gte = new Date(filters.fromDate);
      if (filters.toDate) where.issueDate.lte = new Date(filters.toDate);
    }
    return this.prisma.invoice.findMany({
      where,
      orderBy: { issueDate: "desc" },
      take: Math.min(filters.limit ?? 50, 200),
      include: { lines: true },
    });
  }

  async cancel(tenantId: string, id: string, reason: string) {
    const invoice = await this.findOne(tenantId, id);
    if (invoice.status === InvoiceStatus.cancelled) {
      throw new BadRequestException("Invoice already cancelled");
    }
    const updated = await this.prisma.invoice.update({
      where: { id },
      data: {
        status: InvoiceStatus.cancelled,
        notes: [invoice.notes, `CANCELLED: ${reason}`].filter(Boolean).join("\n"),
        ...this.holdedCancelMark(invoice),
      },
    });
    this.mirrorCancellation(id);
    return updated;
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
    const invoice = await this.findOne(tenantId, id);
    if (invoice.status === InvoiceStatus.cancelled) {
      throw new BadRequestException("Invoice already cancelled");
    }

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
  ): Promise<IssuedInvoice> {
    return this.rectifyIn(tx, tenantId, originalInvoiceId, reason, (original, context) =>
      amountCreditLines(original.lines, amountCents, context),
    );
  }

  /**
   * Throws what rectifyByAmountIn would refuse (a cancelled invoice, more
   * than is left to credit), without issuing anything or locking: a check
   * before a sale is written. rectifyByAmountIn checks again under the lock.
   */
  async assertCreditable(tenantId: string, originalInvoiceId: string, amountCents: number): Promise<void> {
    const original = await this.rectifiable(this.prisma, tenantId, originalInvoiceId);
    amountCreditLines(original.lines, amountCents, await this.creditContext(this.prisma, original));
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
      series: "R",
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
    return this.insert(tx, input, await this.prepare(input, tx));
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
    const lineIds = original.lines.map((l) => l.id);
    const earlier = await db.invoice.findMany({
      where: {
        tenantId: original.tenantId,
        id: { not: original.id },
        status: { not: InvoiceStatus.cancelled },
        OR: [
          { notes: { startsWith: rectificationNotePrefix(original) } },
          ...(lineIds.length ? [{ lines: { some: { rectifiesLineId: { in: lineIds } } } }] : []),
        ],
      },
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

  /**
   * Convert a paid POS Order into an invoice. Returns null if the order
   * is not in a payable state (no idempotency on existing invoice).
   */
  async fromOrder(orderId: string): Promise<{ id: string } | null> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: {
          include: { product: true },
        },
        client: true,
        tenant: { select: { name: true, fiscalSettings: true } },
      },
    });
    if (!order) return null;
    if (order.status !== "completed") return null;
    const settings =
      (order.tenant?.fiscalSettings as Record<string, unknown>) ?? {};
    const defaultTaxRate = salonTaxRate(settings);
    // A till price is written the way the salon writes all its prices: tax
    // included or on top, its own choice (salon-tax-settings.ts).
    const taxIncluded = pricesIncludeTaxOf(settings);

    // The order's discount (Order.discount, euros) used to be left off the
    // invoice, which then said more than was charged. Shared over the lines
    // in proportion, in the prices' own terms (tax included or not).
    const lineCents = order.items.map((it) => Math.round(Number(it.unitPrice) * 100) * Number(it.quantity));
    const shares = allocateCents(
      Math.min(Math.round(Number(order.discount ?? 0) * 100), lineCents.reduce((s, c) => s + c, 0)),
      lineCents,
    );
    const lines = order.items.map((it, i) => ({
      description: it.product?.name ?? "Producto",
      quantity: Number(it.quantity),
      unitPriceCents: Math.round(Number(it.unitPrice) * 100),
      // Product.taxRate is a fraction (0.21); a line's rate is a percent (21).
      taxRate: productTaxRatePercent(it.product?.taxRate, defaultTaxRate),
      taxIncluded,
      productId: it.productId,
      ...(shares[i] > 0 ? { discountCents: shares[i] } : {}),
    }));

    if (lines.length === 0) return null;

    const client = order.client;
    // Compose recipient NIF from the client record properly, falling back
    // to empty string when the client has no taxId (we MUST NOT use email).
    const recipientTaxId = client?.taxId ?? undefined;
    return this.create({
      tenantId: order.tenantId,
      recipientType: client ? "client" : "tenant",
      recipientId: client?.id,
      recipientName: client
        ? `${client.firstName} ${client.lastName}`
        : order.tenant?.name ?? order.tenantId,
      recipientTaxId,
      lines,
      notes: `Generada desde pedido ${order.orderNumber}`,
    });
  }

  /**
   * Convert a completed appointment into an invoice. Tenant opt-in via
   * `fiscalSettings.autoInvoiceAppointments`. Skipped for tenants that
   * opted out.
   *
   * Idempotent: an appointment gets one invoice, ever. The invoice carries
   * sourceType "appointment" + sourceId, unique per tenant in the database,
   * so completing twice, or two completions at once, return the invoice
   * already issued instead of a second one (an issued invoice cannot simply
   * be withdrawn: with VERI*FACTU it is already chained and sent).
   */
  async fromAppointment(appointmentId: string): Promise<{ id: string } | null> {
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
    if (!appt) return null;

    const existing = await this.appointmentInvoice(appt.tenantId, appt.id);
    if (existing) return existing;

    if (appt.status !== "completed") return null;
    const settings =
      (appt.tenant.fiscalSettings as Record<string, unknown>) ?? {};
    if (!settings.autoInvoiceAppointments) return null;

    try {
      return await this.create({
        tenantId: appt.tenantId,
        recipientType: appt.client ? "client" : "tenant",
        recipientId: appt.client?.id,
        recipientName: appt.client
          ? `${appt.client.firstName} ${appt.client.lastName}`
          : appt.tenantId,
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

  /** The invoice issued for an appointment, if any (cancelled ones included). */
  private appointmentInvoice(tenantId: string, appointmentId: string): Promise<{ id: string } | null> {
    return this.prisma.invoice.findFirst({
      where: { tenantId, sourceType: InvoiceSource.appointment, sourceId: appointmentId },
      select: { id: true },
    });
  }
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}