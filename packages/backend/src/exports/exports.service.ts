import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import type { Response } from "express";
import * as Papa from "papaparse";
import ExcelJS from "exceljs";
import { PaymentFilters, paymentWhere } from "../payments/payments-query";
import { scheduledDateRange } from "../analytics/analytics-metrics";

export type ExportEntity =
  | "clients"
  | "appointments"
  | "payments"
  | "services"
  | "professionals"
  | "wallet-transactions"
  | "gift-cards";

export type ExportFormat = "csv" | "xlsx";

const PAGE_SIZE = 1000;
const MAX_XLSX_ROWS = 100_000;

/**
 * A client's name or notes starting with `=`, `+`, `-`, `@`, a tab or a
 * carriage return is read as a formula when the CSV is opened in a
 * spreadsheet. `escapeFormulae` prefixes those cells with a quote so they
 * stay text. (XLSX cells are written as strings, never formulas.)
 */
const CSV_OPTIONS = { escapeFormulae: true } as const;

/**
 * The payments file is read by a salon in a Spanish spreadsheet: amounts in
 * euros with a decimal comma, so the columns are separated by semicolons
 * (what Excel in Spanish expects), and a BOM so accents open right.
 */
const PAYMENTS_CSV_OPTIONS = { ...CSV_OPTIONS, delimiter: ";" } as const;

const METHOD_LABELS: Record<string, string> = {
  cash: "Efectivo",
  card: "Tarjeta",
  bank_transfer: "Transferencia",
  wallet: "Cartera",
  gift_card: "Tarjeta regalo",
  loyalty_points: "Puntos",
};
const STATUS_LABELS: Record<string, string> = {
  pending: "Pendiente",
  paid: "Pagado",
  failed: "Fallido",
  refunded: "Devuelto",
};

/** 5000 -> "50,00" (CSV) or 50 (XLSX, a number cell). */
function eurosCell(cents: number, format: ExportFormat): string | number {
  const euros = Math.round(cents) / 100;
  return format === "csv" ? euros.toFixed(2).replace(".", ",") : euros;
}

/** "dd/mm/aaaa hh:mm" on the salon's clock. */
function salonDateTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("es-ES", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(date)
    .replace(",", "");
}

const DAY = /^d{4}-d{2}-d{2}$/;

/** A real calendar day "YYYY-MM-DD" (2026-02-31 is not one). */
function isDay(value: string): boolean {
  if (!DAY.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * The appointments export's optional date range, as a filter on
 * `scheduledDate`: salon calendar days, both inclusive (an appointment's day
 * is stored as the salon's calendar date, so no timezone is needed). Either
 * end may be left open. 400 for a day that is not one, or from after to.
 */
export function appointmentDayFilter(dateFrom?: string, dateTo?: string): { gte?: Date; lt?: Date } | undefined {
  if (!dateFrom && !dateTo) return undefined;
  for (const d of [dateFrom, dateTo]) {
    if (d && !isDay(d)) throw new BadRequestException("La fecha no es válida: usa el formato AAAA-MM-DD.");
  }
  if (dateFrom && dateTo && dateFrom > dateTo) {
    throw new BadRequestException("La fecha desde no puede ser posterior a la fecha hasta.");
  }
  return {
    ...(dateFrom ? { gte: scheduledDateRange({ start: dateFrom, end: dateFrom }).gte } : {}),
    ...(dateTo ? { lt: scheduledDateRange({ start: dateTo, end: dateTo }).lt } : {}),
  };
}

/** What a payment was for: its appointment's service, else a till sale. */
export function paymentConcept(p: {
  description?: string | null;
  metadata?: unknown;
  appointment?: { service?: { name?: string | null } | null } | null;
}): string {
  const service = p.appointment?.service?.name;
  if (service) return service;
  const desc = (p.description ?? "").trim();
  const sale = desc.replace(/^POS Sale:\s*/i, "");
  if ((p.metadata as { posSaleId?: string } | null)?.posSaleId || sale !== desc) {
    return sale ? `Venta en caja: ${sale}` : "Venta en caja";
  }
  return desc;
}

@Injectable()
export class ExportsService {
  constructor(private readonly prisma: PrismaService) {}

  async stream(
    tenantId: string,
    entity: ExportEntity,
    format: ExportFormat,
    res: Response,
    /**
     * Payments: the Pagos page's filters (status, method, dates).
     * Appointments: dateFrom / dateTo only, salon days (appointmentDayFilter).
     */
    filters: PaymentFilters = {},
  ): Promise<void> {
    const timeZone = entity === "payments" ? await this.timezoneOf(tenantId) : "Europe/Madrid";
    const fetchPage = (cursor?: any) =>
      entity === "payments"
        ? this.fetchPayments(tenantId, filters, timeZone, format, cursor)
        : this.fetchPage(tenantId, entity, cursor, filters);
    const csvOptions = entity === "payments" ? PAYMENTS_CSV_OPTIONS : CSV_OPTIONS;

    const filename = `${entity === "payments" ? "pagos" : entity}-${new Date().toISOString().slice(0, 10)}.${format}`;
    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`,
      );
    } else {
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`,
      );
    }

    if (format === "csv") {
      let header: string[] | null = null;
      let cursor: any = undefined;
      let hasMore = true;
      while (hasMore) {
        const { rows, nextCursor } = await fetchPage(cursor);
        if (rows.length === 0) {
          hasMore = false;
          break;
        }
        if (!header) {
          header = Object.keys(rows[0]);
          res.write((entity === "payments" ? "﻿" : "") + Papa.unparse([header], csvOptions) + "\n");
        }
        // `Papa.unparse(rows)` with object arrays emits a header row by default;
        // pass `{ header: false }` so we don't duplicate the header on subsequent pages.
        // Each page ends its last line: the next page's first row was glued to it.
        res.write(Papa.unparse(rows, { ...csvOptions, header: false }) + "\n");
        if (!nextCursor) {
          hasMore = false;
          break;
        }
        cursor = nextCursor;
      }
      if (!header) {
        res.write("");
      }
      res.end();
      return;
    }

    // XLSX streaming
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: false,
    });
    const sheet = workbook.addWorksheet(entity);
    let header: string[] | null = null;
    let totalRows = 0;
    let cursor: any = undefined;
    while (totalRows < MAX_XLSX_ROWS) {
      const { rows, nextCursor } = await fetchPage(cursor);
      if (rows.length === 0) break;
      if (!header) {
        header = Object.keys(rows[0]);
        sheet.columns = header.map((h) => ({ header: h, key: h }));
      }
      rows.forEach((row: any) => {
        sheet.addRow(row).commit();
        totalRows += 1;
      });
      if (!nextCursor) break;
      cursor = nextCursor;
    }
    if (!header) {
      sheet.addRow({}).commit();
    }
    await workbook.commit();
  }

  private async timezoneOf(tenantId: string): Promise<string> {
    try {
      const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
      return tenant?.timezone || "Europe/Madrid";
    } catch {
      return "Europe/Madrid";
    }
  }

  /**
   * The Pagos page's list as a file: its filters, newest first, Spanish
   * headers, the client's name, what it was for, euros (not cents) and what
   * was refunded of each payment.
   */
  private async fetchPayments(
    tenantId: string,
    filters: PaymentFilters,
    timeZone: string,
    format: ExportFormat,
    cursor?: string,
  ): Promise<{ rows: any[]; nextCursor?: any }> {
    const take = PAGE_SIZE;
    const rows = await this.prisma.payment.findMany({
      where: paymentWhere(tenantId, filters, timeZone),
      take,
      skip: cursor ? 1 : 0,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: {
        client: { select: { firstName: true, lastName: true } },
        appointment: { select: { service: { select: { name: true } } } },
        refunds: { where: { status: "succeeded" }, select: { amount: true } },
      },
    });
    return {
      rows: rows.map((r: any) => {
        const refunded = (r.refunds ?? []).reduce((s: number, x: { amount: number }) => s + x.amount, 0);
        const name = r.client ? `${r.client.firstName ?? ""} ${r.client.lastName ?? ""}`.trim() : "";
        return {
          Fecha: r.createdAt instanceof Date ? salonDateTime(r.createdAt, timeZone) : String(r.createdAt ?? ""),
          Clienta: name,
          Concepto: paymentConcept(r),
          "Forma de pago": METHOD_LABELS[r.method] ?? r.method,
          Estado: STATUS_LABELS[r.status] ?? r.status,
          "Importe (€)": eurosCell(r.amount ?? 0, format),
          "Devuelto (€)": eurosCell(refunded, format),
          "ID del cobro": r.id,
        };
      }),
      nextCursor: rows.length === take ? rows[rows.length - 1].id : undefined,
    };
  }

  private async fetchPage(
    tenantId: string,
    entity: ExportEntity,
    cursor?: any,
    filters: PaymentFilters = {},
  ): Promise<{ rows: any[]; nextCursor?: any }> {
    const take = PAGE_SIZE;
    switch (entity) {
      case "clients": {
        const rows = await this.prisma.client.findMany({
          where: { tenantId },
          // Only the exported columns: never the password hash or tokens.
          select: { id: true, firstName: true, lastName: true, email: true, phone: true, createdAt: true },
          take,
          skip: cursor ? 1 : 0,
          cursor: cursor ? { id: cursor } : undefined,
          orderBy: { id: "asc" },
        });
        return {
          rows: rows.map((r: any) => ({
            id: r.id,
            firstName: r.firstName,
            lastName: r.lastName,
            email: r.email,
            phone: r.phone,
            createdAt: r.createdAt,
          })),
          nextCursor: rows.length === take ? rows[rows.length - 1].id : undefined,
        };
      }
      case "appointments": {
        const scheduledDate = appointmentDayFilter(filters.dateFrom, filters.dateTo);
        const rows = await this.prisma.appointment.findMany({
          where: { tenantId, ...(scheduledDate ? { scheduledDate } : {}) },
          take,
          skip: cursor ? 1 : 0,
          cursor: cursor ? { id: cursor } : undefined,
          orderBy: { id: "asc" },
        });
        return {
          rows: rows.map((r: any) => ({
            id: r.id,
            clientId: r.clientId,
            professionalId: r.professionalId,
            // The salon day and clock it is booked for (startTime is when it was started).
            date: r.scheduledDate instanceof Date ? r.scheduledDate.toISOString().slice(0, 10) : r.scheduledDate,
            scheduledTime: r.scheduledTime,
            startTime: r.startTime,
            endTime: r.endTime,
            status: r.status,
            // Euros, from totalAmount (cents): it read a totalPrice column that does not exist and was always empty.
            totalPrice: r.totalAmount === undefined || r.totalAmount === null ? null : Number(r.totalAmount) / 100,
          })),
          nextCursor: rows.length === take ? rows[rows.length - 1].id : undefined,
        };
      }
      case "payments":
        return this.fetchPayments(tenantId, {}, "Europe/Madrid", "csv", cursor);
      case "services": {
        const rows = await this.prisma.service.findMany({
          where: { tenantId },
          take,
          skip: cursor ? 1 : 0,
          cursor: cursor ? { id: cursor } : undefined,
          orderBy: { id: "asc" },
        });
        return {
          rows: rows.map((r: any) => ({
            id: r.id,
            name: r.name,
            duration: r.duration,
            price: r.price,
            isActive: r.isActive,
          })),
          nextCursor: rows.length === take ? rows[rows.length - 1].id : undefined,
        };
      }
      case "professionals": {
        const rows = await this.prisma.professional.findMany({
          where: { tenantId },
          take,
          skip: cursor ? 1 : 0,
          cursor: cursor ? { id: cursor } : undefined,
          orderBy: { id: "asc" },
        });
        return {
          rows: rows.map((r: any) => ({
            id: r.id,
            firstName: r.firstName,
            lastName: r.lastName,
            email: r.email,
            phone: r.phone,
            isActive: r.isActive,
          })),
          nextCursor: rows.length === take ? rows[rows.length - 1].id : undefined,
        };
      }
      case "wallet-transactions": {
        const rows = await this.prisma.walletTransaction.findMany({
          where: { wallet: { tenantId } },
          take,
          skip: cursor ? 1 : 0,
          cursor: cursor ? { id: cursor } : undefined,
          orderBy: { id: "asc" },
        });
        return {
          rows: rows.map((r: any) => ({
            id: r.id,
            walletId: r.walletId,
            type: r.type,
            amount: r.amount,
            balanceAfter: r.balanceAfter,
            // How a top-up was paid (cash, card, bizum, bank_transfer); empty for other movements.
            method: r.method ?? "",
            createdAt: r.createdAt,
          })),
          nextCursor: rows.length === take ? rows[rows.length - 1].id : undefined,
        };
      }
      case "gift-cards": {
        const rows = await this.prisma.giftCard.findMany({
          where: { tenantId },
          take,
          skip: cursor ? 1 : 0,
          cursor: cursor ? { id: cursor } : undefined,
          orderBy: { id: "asc" },
        });
        return {
          rows: rows.map((r: any) => ({
            id: r.id,
            code: r.code,
            initialAmount: r.initialAmount,
            currentBalance: r.currentBalance,
            isActive: r.isActive,
            expiresAt: r.expiresAt,
            createdAt: r.createdAt,
          })),
          nextCursor: rows.length === take ? rows[rows.length - 1].id : undefined,
        };
      }
    }
  }
}
