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
import { AccountingService } from "../accounting/accounting.service";
import { FiscalMode, InvoiceSource, InvoiceStatus, Prisma } from "@prisma/client";
import { ISSUE_TRANSACTION, VerifactuRecordsService } from "./fiscal/verifactu/verifactu-records.service";
import { VerifactuDispatcher } from "./fiscal/verifactu/verifactu-dispatcher.service";
import { verifactuAvailable } from "./fiscal/verifactu/config";
import { salonYear } from "./fiscal/verifactu/format";

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
    taxRate: number;
    productId?: string;
    serviceId?: string;
  }>;
  notes?: string;
  /** Rectificativas: the invoice this one corrects. */
  rectifiesInvoiceId?: string;
}

@Injectable()
export class InvoiceService {
  private readonly logger = new Logger(InvoiceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly calculator: InvoiceCalculator,
    private readonly fiscal: FiscalService,
    @Optional() private readonly accounting?: AccountingService,
    @Optional() private readonly verifactu?: VerifactuRecordsService,
    @Optional() private readonly verifactuDispatcher?: VerifactuDispatcher,
  ) {}

  /** Whether this salon's invoices go through the VERI*FACTU record chain. */
  private recordsVerifactu(fiscalMode: FiscalMode): boolean {
    return fiscalMode === FiscalMode.verifactu && !!this.verifactu && verifactuAvailable();
  }

  async create(input: CreateInvoiceInput): Promise<{ id: string }> {
    if (!input.lines?.length) {
      throw new BadRequestException("Invoice must have at least one line");
    }
    const computation = this.calculator.compute(input.lines);
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: input.tenantId },
      select: { fiscalMode: true, fiscalSettings: true, timezone: true },
    });
    if (!tenant) {
      throw new NotFoundException("Tenant not found");
    }
    const settings = (tenant.fiscalSettings as Record<string, unknown>) ?? {};
    const series = input.series ?? (settings.defaultSeries as string) ?? "A";
    const issueDate = input.issueDate ?? new Date();
    // The salon's calendar year: at 00:30 on 1 January in Madrid it is still December in UTC.
    const year = salonYear(issueDate, tenant.timezone || "Europe/Madrid");
    const fiscalMode = tenant.fiscalMode;
    const withRecords = this.recordsVerifactu(fiscalMode);

    // Number, invoice and VERI*FACTU record together: an invoice that cannot
    // be recorded is not issued, and its number is not used up either.
    const invoice = await this.prisma.$transaction(async (tx) => {
      const number = await this.allocateNumber(input.tenantId, series, year, tx);
      const created = await tx.invoice.create({
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
        sourceType: InvoiceSource.manual,
        notes: input.notes,
        rectifiesInvoiceId: input.rectifiesInvoiceId,
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
          })),
        },
      },
    });
      if (withRecords) await this.verifactu!.recordInvoice(tx, created.id);
      return created;
    }, ISSUE_TRANSACTION);

    // TicketBAI / SII (not available yet): background dispatch as before.
    // VERI*FACTU records are sent by VerifactuDispatcher.
    if (fiscalMode !== FiscalMode.none && !withRecords) {
      void this.fiscal.dispatchInvoice(invoice.id).catch((err) => {
        this.logger.warn(
          `Background fiscal dispatch failed for ${invoice.id}: ${(err as Error).message}`,
        );
      });
    }

    // Fire accounting sync if a connection is active. Runs after fiscal so
    // we don't push unauthenticated invoices to Holded/Sage.
    if (this.accounting) {
      void this.accounting.syncInvoice(invoice.id).catch((err) => {
        this.logger.warn(
          `Background accounting sync failed for ${invoice.id}: ${(err as Error).message}`,
        );
      });
    }
    return { id: invoice.id };
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
    // One statement creates the counter or increments it. Prisma's upsert
    // reads, then inserts: two first invoices of a year at once both tried
    // to insert, and one failed on the unique index. Inside the invoice's
    // transaction the row stays locked until it commits, so an invoice that
    // fails does not leave a gap in the numbering.
    const [row] = await db.$queryRaw<Array<{ lastNumber: number }>>`
      INSERT INTO "fiscal_sequences" ("id", "tenantId", "series", "year", "lastNumber")
      VALUES (gen_random_uuid()::text, ${tenantId}, ${series}, ${year}, 1)
      ON CONFLICT ("tenantId", "series", "year")
      DO UPDATE SET "lastNumber" = "fiscal_sequences"."lastNumber" + 1
      RETURNING "lastNumber"`;

    return String(row.lastNumber).padStart(6, "0");
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
    // Recorded in VERI*FACTU: cancelling it means annulling it at the AEAT too.
    if (await this.prisma.verifactuRecord.count({ where: { invoiceId: id } })) {
      return this.anulate(tenantId, id, reason);
    }
    return this.prisma.invoice.update({
      where: { id },
      data: {
        status: InvoiceStatus.cancelled,
        notes: [invoice.notes, `CANCELLED: ${reason}`].filter(Boolean).join("\n"),
      },
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
    const recorded = this.verifactu && (await this.prisma.verifactuRecord.count({ where: { invoiceId: id } })) > 0;
    if (recorded) {
      // The anulación record and the cancellation, together.
      return this.prisma.$transaction(async (tx) => {
        await this.verifactu!.recordAnulacion(tx, id);
        const updated = await tx.invoice.update({
          where: { id },
          data: {
            status: InvoiceStatus.cancelled,
            fiscalStatus: "pending",
            notes: [invoice.notes, `ANULADA: ${reason}`].filter(Boolean).join("\n"),
          },
        });
        return { ...updated, fiscalAnulated: true };
      }, ISSUE_TRANSACTION);
    }
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
      },
    });
    return { ...updated, fiscalAnulated };
  }

  /**
   * Rectify: creates a NEW invoice with series="R" referencing the
   * original, marked with the negative amount delta. Used for partial
   * refunds, discounts, etc.
   */
  async emitRectification(
    tenantId: string,
    originalInvoiceId: string,
    lines: Array<{
      description: string;
      quantity: number;
      unitPriceCents: number;
      discountPct?: number;
      taxRate: number;
    }>,
    reason: string,
  ): Promise<{ id: string }> {
    const original = await this.findOne(tenantId, originalInvoiceId);
    return this.create({
      tenantId,
      series: "R",
      recipientType: "client",
      recipientId: original.recipientId ?? undefined,
      recipientName: original.recipientName,
      recipientTaxId: original.recipientTaxId ?? undefined,
      lines,
      notes: `Rectificación de ${original.series}${original.number}: ${reason}`,
      rectifiesInvoiceId: original.id,
    });
  }

  async resendFiscal(tenantId: string, id: string) {
    const invoice = await this.findOne(tenantId, id);
    if (invoice.fiscalStatus === "not_required") {
      throw new BadRequestException("Invoice has no fiscal mode configured");
    }
    const last = await this.prisma.verifactuRecord.findFirst({ where: { invoiceId: id }, orderBy: { sequence: "desc" } });
    if (last && this.verifactu) {
      if (last.status === "rejected" || last.status === "accepted_with_errors") {
        // A new, corrected record; the rejected one stays as it was.
        await this.verifactu.recordSubsanacion(tenantId, id);
      }
      // Waiting records go with the next submission; after a failure, try now.
      await this.prisma.verifactuChain.updateMany({
        where: { tenantId, failedAttempts: { gt: 0 } },
        data: { nextSendAt: new Date() },
      });
      void this.verifactuDispatcher?.tick();
      return this.findOne(tenantId, id);
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
    const defaultTaxRate = (settings.defaultTaxRate as number) ?? 21;

    const lines = order.items.map((it) => ({
      description: it.product?.name ?? "Producto",
      quantity: Number(it.quantity),
      unitPriceCents: Math.round(Number(it.unitPrice) * 100),
      taxRate: Number(it.product?.taxRate ?? defaultTaxRate),
      productId: it.productId,
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
   * Convert a paid appointment into an invoice. Tenant opt-in via
   * `fiscalSettings.autoInvoiceAppointments`. Skipped for tenants that
   * opted out.
   */
  async fromAppointment(appointmentId: string): Promise<{ id: string } | null> {
    const appt = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        client: true,
        service: true,
        tenant: { select: { fiscalSettings: true } },
      },
    });
    if (!appt) return null;
    if (appt.status !== "completed") return null;
    const settings =
      (appt.tenant.fiscalSettings as Record<string, unknown>) ?? {};
    if (!settings.autoInvoiceAppointments) return null;

    return this.create({
      tenantId: appt.tenantId,
      recipientType: appt.client ? "client" : "tenant",
      recipientId: appt.client?.id,
      recipientName: appt.client
        ? `${appt.client.firstName} ${appt.client.lastName}`
        : appt.tenantId,
      lines: [
        {
          description: appt.service?.name ?? "Servicio",
          quantity: 1,
          unitPriceCents: Math.round(Number(appt.price) * 100),
          taxRate: 21,
          serviceId: appt.serviceId,
        },
      ],
      notes: `Generada desde cita ${appt.id}`,
    });
  }
}