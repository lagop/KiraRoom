import { Injectable, NotFoundException } from "@nestjs/common";
import { taxLabelOf } from "@kira/shared";
import { PrismaService } from "../../common/prisma/prisma.service";
import { InvoicePdfService } from "./invoice-pdf.service";
import { buildInvoiceDocument, InvoiceDocument, InvoicePdfInput, isRectifying, parseRectificationNote } from "./invoice-document";

/**
 * An invoice of the salon, as its PDF: what GET /invoices/:id/pdf serves and
 * POST /invoices/:id/email attaches.
 *
 * Gathers what the PDF must say (invoice-document.ts) from the database: the
 * salon's razón social, NIF and full address (the PDF used to get null for
 * both), preferring what was snapshotted on the invoice when it was issued
 * (issuerNameAtIssue / issuerTaxIdAtIssue); the salon's timezone for the
 * date; and, on a rectificativa, the number and date of the invoice it
 * rectifies.
 */
@Injectable()
export class InvoiceRenderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdf: InvoicePdfService,
  ) {}

  async render(tenantId: string, invoiceId: string) {
    const { input, invoice } = await this.pdfInput(tenantId, invoiceId);
    const doc: InvoiceDocument = buildInvoiceDocument(input);
    const pdf = await this.pdf.generate(input);
    return { pdf, filename: invoicePdfFilename(invoice), doc, invoice, input };
  }

  async pdfInput(tenantId: string, invoiceId: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, tenantId },
      include: { lines: true },
    });
    if (!invoice) throw new NotFoundException("Invoice not found");
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        name: true,
        legalName: true,
        taxId: true,
        street: true,
        city: true,
        state: true,
        postalCode: true,
        country: true,
        email: true,
        phone: true,
        timezone: true,
        fiscalSettings: true,
      },
    });
    if (!tenant) throw new NotFoundException("Tenant not found");
    const settings = (tenant.fiscalSettings as Record<string, unknown> | null) ?? {};

    const input: InvoicePdfInput = {
      tenant: {
        name: tenant.name,
        legalName: tenant.legalName,
        // The NIF lives on the tenant; older salons only have it in the fiscal settings.
        taxId: tenant.taxId ?? (typeof settings.tenantNif === "string" ? settings.tenantNif : null),
        address: {
          street: tenant.street,
          city: tenant.city,
          state: tenant.state,
          postalCode: tenant.postalCode,
          country: tenant.country,
        },
        email: tenant.email,
        phone: tenant.phone,
      },
      invoice: {
        series: invoice.series,
        number: invoice.number,
        issueDate: invoice.issueDate,
        recipientName: invoice.recipientName,
        recipientTaxId: invoice.recipientTaxId,
        recipientAddress: invoice.recipientAddress,
        subtotalCents: invoice.subtotalCents,
        totalCents: invoice.totalCents,
        currency: invoice.currency,
        status: invoice.status,
        notes: invoice.notes,
        fiscalReference: invoice.fiscalReference,
        fiscalHash: invoice.fiscalHash,
        fiscalQrUrl: invoice.fiscalQrUrl,
        issuerNameAtIssue: invoice.issuerNameAtIssue,
        issuerTaxIdAtIssue: invoice.issuerTaxIdAtIssue,
      },
      // Prisma Decimals arrive as objects: numbers for the PDF.
      lines: invoice.lines.map((l) => ({
        description: l.description,
        quantity: Number(l.quantity),
        unitPriceCents: l.unitPriceCents,
        discountPct: Number(l.discountPct),
        taxRate: Number(l.taxRate),
        totalCents: l.totalCents,
      })),
      taxBreakdown: Array.isArray(invoice.taxBreakdown)
        ? (invoice.taxBreakdown as Array<{ rate: number; baseCents: number; taxCents: number }>)
        : [],
      // IGIC for a Canarian salon, IPSI in Ceuta and Melilla: not always IVA.
      taxLabel: taxLabelOf(tenant.fiscalSettings),
      timezone: tenant.timezone,
      rectifies: isRectifying(invoice) ? await this.original(tenantId, invoice) : null,
    };
    return { input, invoice };
  }

  /**
   * The invoice a rectificativa rectifies: by its lines' link to the
   * original's lines, else by the number in its note ("Rectificación de
   * A000123: ..."), the only link the ones issued before the line link have.
   */
  private async original(
    tenantId: string,
    invoice: { notes: string | null; lines: Array<{ rectifiesLineId: string | null }> },
  ): Promise<{ series: string; number: string; issueDate: Date } | null> {
    const lineIds = invoice.lines.map((l) => l.rectifiesLineId).filter((id): id is string => !!id);
    if (lineIds.length) {
      const line = await this.prisma.invoiceLine.findFirst({
        where: { id: { in: lineIds }, invoice: { tenantId } },
        select: { invoice: { select: { series: true, number: true, issueDate: true } } },
      });
      if (line) return line.invoice;
    }
    const note = parseRectificationNote(invoice.notes);
    const m = note ? /^(.*?)(\d+)$/.exec(note.original) : null;
    if (!m) return null;
    return this.prisma.invoice.findFirst({
      where: { tenantId, series: m[1], number: m[2] },
      select: { series: true, number: true, issueDate: true },
    });
  }
}

/** "factura-A000001.pdf". */
export function invoicePdfFilename(invoice: { series: string; number: string }): string {
  const id = `${invoice.series}${invoice.number}`.replace(/[^A-Za-z0-9_-]/g, "");
  return `factura-${id || "sin-numero"}.pdf`;
}
