import { BadRequestException, Injectable } from "@nestjs/common";
import ExcelJS from "exceljs";
import { InvoiceStatus } from "@prisma/client";
import { TAX_REGIME_LABELS, taxRegimeOf } from "@kira/shared";
import { PrismaService } from "../common/prisma/prisma.service";

/**
 * Libro registro de facturas emitidas, as a file the salon hands to its
 * gestoría.
 *
 * This is how Sage, A3 and NCS users get their invoices into accounting.
 * The programs Spanish gestorías keep the books in (Sage 200 / Sage
 * Despachos, a3ASESOR / a3innuva, NCS) have no public API a SaaS can call
 * on its own: Wolters Kluwer integrates through its a3Marketplace partner
 * programme, Sage 200 is on-premise, NCS publishes none. (Sage's small-
 * business cloud product, Sage Accounting, does have a public OAuth API;
 * it is not integrated yet.) What all of them import is a spreadsheet of
 * issued invoices, so that is what we produce, from real data.
 *
 * Layout: one row per invoice and tax rate, the shape of the AEAT's own
 * "libro registro de facturas expedidas". An invoice with two rates takes
 * two rows and repeats its total, as in the AEAT model; bases and cuotas
 * add up across rows, totals do not.
 *
 * Which invoices: issued, paid and refunded, by issue date, the same set
 * and the same UTC day boundaries as the Modelo 303/420 drafts in
 * TaxReportsService, so the export and the quarterly return reconcile.
 * Drafts and cancelled (anuladas) invoices are left out.
 */

export const INVOICE_BOOK_COLUMNS = [
  "Fecha expedición",
  "Serie",
  "Número",
  "Factura",
  "Tipo de factura",
  "NIF cliente",
  "Nombre cliente",
  "Impuesto",
  "Tipo impositivo (%)",
  "Base imponible",
  "Cuota",
  "Total factura",
  "Estado",
] as const;

export interface InvoiceBookRow {
  date: Date;
  series: string;
  number: string;
  invoiceType: string;
  customerTaxId: string;
  customerName: string;
  tax: string;
  rate: number;
  baseCents: number;
  taxCents: number;
  totalCents: number;
  status: string;
}

const BOOK_STATUSES: InvoiceStatus[] = [
  InvoiceStatus.issued,
  InvoiceStatus.paid,
  InvoiceStatus.refunded,
];

const STATUS_LABELS: Partial<Record<InvoiceStatus, string>> = {
  issued: "Emitida",
  paid: "Cobrada",
  refunded: "Reembolsada",
};

/** A year and a day, so a full calendar year (leap or not) fits. */
const MAX_RANGE_DAYS = 366;

interface BookInvoice {
  series: string;
  number: string;
  issueDate: Date;
  recipientName: string;
  recipientTaxId: string | null;
  subtotalCents: number;
  totalCents: number;
  taxBreakdown: unknown;
  status: InvoiceStatus;
}

/** Pure: invoices in, rows out. Exported for the spec. */
export function buildInvoiceBookRows(invoices: BookInvoice[], taxLabel: string): InvoiceBookRow[] {
  const rows: InvoiceBookRow[] = [];
  for (const inv of invoices) {
    const breakdown = (Array.isArray(inv.taxBreakdown) ? inv.taxBreakdown : []) as Array<{
      rate?: number;
      baseCents?: number;
      taxCents?: number;
    }>;
    const buckets = breakdown.length
      ? [...breakdown].sort((a, b) => Number(b.rate ?? 0) - Number(a.rate ?? 0))
      : // An invoice without a breakdown has a single 0 % base.
        [{ rate: 0, baseCents: inv.subtotalCents, taxCents: 0 }];
    const rectificativa = inv.series === "R" || inv.totalCents < 0;
    const invoiceType = rectificativa
      ? "Rectificativa"
      : inv.recipientTaxId
        ? "Completa (F1)"
        : "Simplificada (F2)";
    for (const b of buckets) {
      rows.push({
        date: inv.issueDate,
        series: inv.series,
        number: inv.number,
        invoiceType,
        customerTaxId: inv.recipientTaxId ?? "",
        customerName: inv.recipientName,
        tax: taxLabel,
        rate: Number(b.rate ?? 0),
        baseCents: Number(b.baseCents ?? 0),
        taxCents: Number(b.taxCents ?? 0),
        totalCents: inv.totalCents,
        status: STATUS_LABELS[inv.status] ?? inv.status,
      });
    }
  }
  return rows;
}

/** dd/mm/yyyy in UTC, the day the range filter used. */
function formatDate(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
}

/** Spanish decimal comma, no thousands separator (importers choke on it). */
function formatAmount(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
}

function formatRate(rate: number): string {
  return String(rate).replace(".", ",");
}

function csvCell(value: string): string {
  return /[";\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Semicolon-separated, decimal comma, UTF-8 with BOM: the dialect Excel in
 * Spanish opens correctly with a double click, and what A3/Sage/ContaPlus
 * import wizards default to.
 */
export function invoiceBookCsv(rows: InvoiceBookRow[]): string {
  const lines = [INVOICE_BOOK_COLUMNS.join(";")];
  for (const r of rows) {
    lines.push(
      [
        formatDate(r.date),
        r.series,
        r.number,
        `${r.series}${r.number}`,
        r.invoiceType,
        r.customerTaxId,
        r.customerName,
        r.tax,
        formatRate(r.rate),
        formatAmount(r.baseCents),
        formatAmount(r.taxCents),
        formatAmount(r.totalCents),
        r.status,
      ]
        .map((v) => csvCell(String(v)))
        .join(";"),
    );
  }
  return "﻿" + lines.join("\r\n") + "\r\n";
}

export async function invoiceBookXlsx(rows: InvoiceBookRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Facturas emitidas");
  sheet.columns = INVOICE_BOOK_COLUMNS.map((header) => ({ header, width: 16 }));
  for (const r of rows) {
    sheet.addRow([
      // Excel dates are wall-clock: build a date-only value from the UTC day.
      new Date(Date.UTC(r.date.getUTCFullYear(), r.date.getUTCMonth(), r.date.getUTCDate())),
      r.series,
      r.number,
      `${r.series}${r.number}`,
      r.invoiceType,
      r.customerTaxId,
      r.customerName,
      r.tax,
      r.rate,
      r.baseCents / 100,
      r.taxCents / 100,
      r.totalCents / 100,
      r.status,
    ]);
  }
  sheet.getColumn(1).numFmt = "dd/mm/yyyy";
  for (const col of [10, 11, 12]) sheet.getColumn(col).numFmt = "#,##0.00";
  sheet.getRow(1).font = { bold: true };
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

/** Parses YYYY-MM-DD as a UTC day; null when malformed. */
function parseDay(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCMonth() === Number(m[2]) - 1 ? d : null;
}

@Injectable()
export class InvoiceBookService {
  constructor(private readonly prisma: PrismaService) {}

  async build(
    tenantId: string,
    from: string,
    to: string,
    format: "csv" | "xlsx",
  ): Promise<{ filename: string; contentType: string; body: Buffer | string; rows: number }> {
    const start = parseDay(from);
    const endDay = parseDay(to);
    if (!start || !endDay) {
      throw new BadRequestException("Fechas no válidas: usa el formato AAAA-MM-DD.");
    }
    if (endDay < start) {
      throw new BadRequestException("La fecha final es anterior a la inicial.");
    }
    if ((endDay.getTime() - start.getTime()) / 86_400_000 > MAX_RANGE_DAYS) {
      throw new BadRequestException("El periodo máximo es de un año.");
    }
    const end = new Date(endDay.getTime() + 86_400_000 - 1);

    const [tenant, invoices] = await Promise.all([
      this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { fiscalSettings: true },
      }),
      this.prisma.invoice.findMany({
        where: {
          tenantId,
          status: { in: BOOK_STATUSES },
          issueDate: { gte: start, lte: end },
        },
        orderBy: [{ issueDate: "asc" }, { series: "asc" }, { number: "asc" }],
        select: {
          series: true,
          number: true,
          issueDate: true,
          recipientName: true,
          recipientTaxId: true,
          subtotalCents: true,
          totalCents: true,
          taxBreakdown: true,
          status: true,
        },
      }),
    ]);

    const taxLabel = TAX_REGIME_LABELS[taxRegimeOf(tenant?.fiscalSettings)];
    const rows = buildInvoiceBookRows(invoices, taxLabel);
    const base = `facturas-emitidas_${from}_${to}`;
    if (format === "xlsx") {
      return {
        filename: `${base}.xlsx`,
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        body: await invoiceBookXlsx(rows),
        rows: rows.length,
      };
    }
    return {
      filename: `${base}.csv`,
      contentType: "text/csv; charset=utf-8",
      body: invoiceBookCsv(rows),
      rows: rows.length,
    };
  }
}
