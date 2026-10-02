/**
 * Libro de facturas emitidas export.
 *
 * Why these tests exist: for Sage, A3 and NCS this file *is* the
 * integration, replacing adapters that returned fake ids. A gestoría imports
 * it as is, so the layout matters: one row per invoice and rate, the tax
 * named after the salon's regime (IVA/IGIC/IPSI), Spanish decimals in the
 * CSV, real numbers and dates in the XLSX, and the same invoice set and day
 * boundaries as the Modelo 303/420 drafts.
 */

import ExcelJS from "exceljs";
import {
  INVOICE_BOOK_COLUMNS,
  InvoiceBookService,
  buildInvoiceBookRows,
  invoiceBookCsv,
} from "./invoice-book.service";

const twoRates = {
  series: "A",
  number: "000010",
  issueDate: new Date("2026-07-03T09:30:00Z"),
  recipientName: "Peluquería; Cliente \"SL\"",
  recipientTaxId: "B12345678",
  subtotalCents: 6000,
  totalCents: 7010,
  taxBreakdown: [
    { rate: 10, baseCents: 1000, taxCents: 100 },
    { rate: 21, baseCents: 5000, taxCents: 1050 },
  ],
  status: "paid" as any,
};
const simplified = {
  series: "A",
  number: "000011",
  issueDate: new Date("2026-07-04T18:00:00Z"),
  recipientName: "Cliente final",
  recipientTaxId: null,
  subtotalCents: 2000,
  totalCents: 2140,
  taxBreakdown: [{ rate: 7, baseCents: 2000, taxCents: 140 }],
  status: "issued" as any,
};

describe("buildInvoiceBookRows", () => {
  it("emits one row per invoice and rate, highest rate first", () => {
    const rows = buildInvoiceBookRows([twoRates], "IVA");
    expect(rows.map((r) => [r.rate, r.baseCents, r.taxCents, r.totalCents])).toEqual([
      [21, 5000, 1050, 7010],
      [10, 1000, 100, 7010],
    ]);
    expect(rows[0]).toMatchObject({ invoiceType: "Completa (F1)", tax: "IVA", status: "Cobrada" });
  });

  it("labels simplified invoices and rectificativas", () => {
    expect(buildInvoiceBookRows([simplified], "IGIC")[0]).toMatchObject({
      invoiceType: "Simplificada (F2)",
      tax: "IGIC",
      customerTaxId: "",
    });
    const rect = { ...simplified, series: "R", totalCents: -2140 };
    expect(buildInvoiceBookRows([rect], "IGIC")[0].invoiceType).toBe("Rectificativa");
  });
});

describe("invoiceBookCsv", () => {
  it("uses ; and decimal comma, quotes what needs it, and starts with a BOM", () => {
    const csv = invoiceBookCsv(buildInvoiceBookRows([twoRates, simplified], "IVA"));
    expect(csv.startsWith("﻿")).toBe(true);
    const lines = csv.slice(1).trimEnd().split("\r\n");
    expect(lines[0]).toBe(INVOICE_BOOK_COLUMNS.join(";"));
    expect(lines[1]).toBe(
      '03/07/2026;A;000010;A000010;Completa (F1);B12345678;"Peluquería; Cliente ""SL""";IVA;21;50,00;10,50;70,10;Cobrada',
    );
    expect(lines[3]).toBe("04/07/2026;A;000011;A000011;Simplificada (F2);;Cliente final;IVA;7;20,00;1,40;21,40;Emitida");
  });

  it("keeps the sign of negative amounts", () => {
    const rows = buildInvoiceBookRows(
      [{ ...simplified, series: "R", totalCents: -5, taxBreakdown: [{ rate: 0, baseCents: -5, taxCents: 0 }] }],
      "IVA",
    );
    expect(invoiceBookCsv(rows)).toContain(";-0,05;0,00;-0,05;");
  });
});

describe("InvoiceBookService.build", () => {
  function service(invoices: any[]) {
    const prisma: any = {
      tenant: { findUnique: jest.fn(async () => ({ fiscalSettings: { taxRegime: "igic" } })) },
      invoice: { findMany: jest.fn(async () => invoices) },
    };
    return { svc: new InvoiceBookService(prisma), prisma };
  }

  it("filters by tenant, the fiscal statuses and whole UTC days", async () => {
    const { svc, prisma } = service([simplified]);
    const file = await svc.build("tenant-1", "2026-07-01", "2026-09-30", "csv");
    const where = prisma.invoice.findMany.mock.calls[0][0].where;
    expect(where).toEqual({
      tenantId: "tenant-1",
      status: { in: ["issued", "paid", "refunded"] },
      issueDate: {
        gte: new Date("2026-07-01T00:00:00.000Z"),
        lte: new Date("2026-09-30T23:59:59.999Z"),
      },
    });
    expect(file.filename).toBe("facturas-emitidas_2026-07-01_2026-09-30.csv");
    expect(String(file.body)).toContain(";IGIC;7;");
  });

  it("produces an XLSX with real numbers and dates", async () => {
    const { svc } = service([twoRates]);
    const file = await svc.build("tenant-1", "2026-07-01", "2026-07-31", "xlsx");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.body as any);
    const sheet = wb.getWorksheet("Facturas emitidas")!;
    expect(sheet.getRow(1).getCell(1).value).toBe("Fecha expedición");
    const row = sheet.getRow(2);
    expect(row.getCell(1).value).toEqual(new Date("2026-07-03T00:00:00.000Z"));
    expect(row.getCell(10).value).toBe(50);
    expect(row.getCell(11).value).toBe(10.5);
    expect(row.getCell(12).value).toBe(70.1);
    expect(sheet.rowCount).toBe(3);
  });

  it("rejects bad or oversized ranges", async () => {
    const { svc } = service([]);
    await expect(svc.build("t", "2026-02-30", "2026-03-01", "csv")).rejects.toThrow(/AAAA-MM-DD/);
    await expect(svc.build("t", "2026-03-01", "2026-02-01", "csv")).rejects.toThrow(/anterior/);
    await expect(svc.build("t", "2025-01-01", "2026-06-01", "csv")).rejects.toThrow(/un año/);
  });
});
