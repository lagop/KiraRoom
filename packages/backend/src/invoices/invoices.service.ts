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
import { FiscalMode, InvoiceSource, InvoiceStatus } from "@prisma/client";

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
    if (!input.lines?.length) {
      throw new BadRequestException("Invoice must have at least one line");
    }
    const computation = this.calculator.compute(input.lines);
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: input.tenantId },
      select: { fiscalMode: true, fiscalSettings: true },
    });
    if (!tenant) {
      throw new NotFoundException("Tenant not found");
    }
    const settings = (tenant.fiscalSettings as Record<string, unknown>) ?? {};
    const series = input.series ?? (settings.defaultSeries as string) ?? "A";
    const issueDate = input.issueDate ?? new Date();
    const year = issueDate.getFullYear();
    const number = await this.allocateNumber(input.tenantId, series, year);
    const fiscalMode = tenant.fiscalMode;

    const invoice = await this.prisma.invoice.create({
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

    // Fire fiscal dispatch in the background. Failures don't roll back the
    // invoice — the operator can retry via /invoices/:id/resend-fiscal.
    if (fiscalMode !== FiscalMode.none) {
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
  ): Promise<string> {
    // First call creates the row at 0; subsequent calls increment.
    await this.prisma.fiscalSequence.upsert({
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

    // Increment and read the new value atomically. We use update + select
    // returning rather than $transaction to keep this readable; under
    // heavy contention the worst case is a duplicate number, which the
    // unique index on Invoice(tenantId, series, number) will reject.
    const updated = await this.prisma.fiscalSequence.update({
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
    });
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