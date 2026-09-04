import { Injectable } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import type { Response } from "express";
import * as Papa from "papaparse";
import ExcelJS from "exceljs";

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

@Injectable()
export class ExportsService {
  constructor(private readonly prisma: PrismaService) {}

  async stream(
    tenantId: string,
    entity: ExportEntity,
    format: ExportFormat,
    res: Response,
  ): Promise<void> {
    const fetchPage = (cursor?: any) =>
      this.fetchPage(tenantId, entity, cursor);

    const filename = `${entity}-${new Date().toISOString().slice(0, 10)}.${format}`;
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
          res.write(Papa.unparse([header]) + "\n");
        }
        // `Papa.unparse(rows)` with object arrays emits a header row by default;
        // pass `{ header: false }` so we don't duplicate the header on subsequent pages.
        res.write(Papa.unparse(rows, { header: false }));
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

  private async fetchPage(
    tenantId: string,
    entity: ExportEntity,
    cursor?: any,
  ): Promise<{ rows: any[]; nextCursor?: any }> {
    const take = PAGE_SIZE;
    switch (entity) {
      case "clients": {
        const rows = await this.prisma.client.findMany({
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
            createdAt: r.createdAt,
          })),
          nextCursor: rows.length === take ? rows[rows.length - 1].id : undefined,
        };
      }
      case "appointments": {
        const rows = await this.prisma.appointment.findMany({
          where: { tenantId },
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
            startTime: r.startTime,
            endTime: r.endTime,
            status: r.status,
            totalPrice: r.totalPrice,
          })),
          nextCursor: rows.length === take ? rows[rows.length - 1].id : undefined,
        };
      }
      case "payments": {
        const rows = await this.prisma.payment.findMany({
          where: { tenantId },
          take,
          skip: cursor ? 1 : 0,
          cursor: cursor ? { id: cursor } : undefined,
          orderBy: { id: "asc" },
        });
        return {
          rows: rows.map((r: any) => ({
            id: r.id,
            clientId: r.clientId,
            amount: r.amount,
            status: r.status,
            method: r.method,
            createdAt: r.createdAt,
          })),
          nextCursor: rows.length === take ? rows[rows.length - 1].id : undefined,
        };
      }
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
