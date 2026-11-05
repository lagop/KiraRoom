import "reflect-metadata";
import { BadRequestException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { InvoiceService, POS_SALE_SOURCE, SIMPLIFIED_INVOICE_MAX_CENTS } from "./invoices.service";
import { InvoiceCalculator } from "./invoice-calculator.service";
import { invoiceStore } from "./invoice-store.testing";
import { CancelInvoiceDto, CreateInvoiceDto, ListInvoicesQueryDto } from "./dto/invoice.dto";
import { InvoicesController } from "./invoices.controller";
import { bodyParser } from "../common/validation/validated-body.testing";
import { salonTaxRate } from "./salon-tax-settings";
import { FiscalService } from "./fiscal/fiscal.service";
import { TaxReportsService } from "./tax-reports/tax-reports.service";
import { formatInvoiceNumber, salonDay } from "./invoice-numbering";

/**
 * The invoice audit's integrity fixes: cancelling an invoice that has
 * rectificativas, manual invoices in a reserved series or with another date,
 * tax rates the regime does not have, IGIC 9,5 % in the breakdown, the
 * invoice list's query, the simplified invoices of the till, the salon's
 * default rate by regime and the anulation while fiscal submission is off.
 */

const message = (p: Promise<unknown>) =>
  p.then(
    () => "",
    (e) => (e instanceof BadRequestException ? e.message : `not a 400: ${e}`),
  );

function setup(fiscalSettings: Record<string, unknown> = { defaultSeries: "A", defaultTaxRate: 21 }) {
  const store = invoiceStore(fiscalSettings);
  const svc = new InvoiceService(store.prisma, new InvoiceCalculator(), {} as any);
  const issue = async (lines: Parameters<InvoiceService["create"]>[0]["lines"] = [corte]) =>
    store.invoices.get((await svc.create({ tenantId: "t1", recipientName: "Ana Prueba", lines })).id);
  return { ...store, svc, issue };
}

const corte = { description: "Corte", quantity: 1, unitPriceCents: 3000, taxRate: 21 };

describe("cancelling an invoice", () => {
  it("is refused while it has live rectificativas, naming them", async () => {
    const t = setup();
    const original = await t.issue();
    const rect = t.invoices.get((await t.svc.emitRectification("t1", original.id, undefined, "Error")).id);
    expect(await message(t.svc.cancel("t1", original.id, "Cliente equivocada"))).toBe(
      `La factura A000001 tiene rectificativas emitidas (R${rect.number}). ` +
        "Anula antes las rectificativas, o emite una rectificativa en lugar de anular la factura.",
    );
    expect(await message(t.svc.anulate("t1", original.id, "Cliente equivocada"))).toMatch(/tiene rectificativas/);
    expect(original.status).toBe("issued");
  });

  it("goes through once its rectificativas are cancelled; the rectificativa itself can be cancelled", async () => {
    const t = setup();
    const original = await t.issue();
    const { id: rectId } = await t.svc.emitRectification("t1", original.id, undefined, "Error");
    await t.svc.cancel("t1", rectId, "Rectificativa duplicada");
    await t.svc.cancel("t1", original.id, "Cliente equivocada");
    expect(original.status).toBe("cancelled");
    expect(original.notes).toBe("CANCELLED: Cliente equivocada");
  });

  it("needs a reason", async () => {
    const t = setup();
    const original = await t.issue();
    expect(await message(t.svc.cancel("t1", original.id, "   "))).toBe("Indica el motivo de la anulación.");
    expect(await message(t.svc.anulate("t1", original.id, ""))).toBe("Indica el motivo de la anulación.");
    const errors = await validate(plainToInstance(CancelInvoiceDto, { reason: "" }));
    expect(errors[0]?.constraints?.isNotEmpty).toBe("Indica el motivo de la anulación.");
  });

  it("locks the invoice while it decides, as a rectificativa does", async () => {
    const t = setup();
    const original = await t.issue();
    await t.svc.cancel("t1", original.id, "x");
    expect(t.locks).toEqual([original.id]);
    expect(await message(t.svc.cancel("t1", original.id, "x"))).toBe("La factura ya está anulada.");
  });
});

describe("a manual invoice (createManual)", () => {
  it("cannot use the series R or T, in either case", async () => {
    const t = setup();
    for (const series of ["R", "r", "T", " t "]) {
      expect(await message(t.svc.createManual({ tenantId: "t1", series, recipientName: "Ana", lines: [corte] }))).toMatch(
        /está reservada/,
      );
    }
    expect(t.invoices.size).toBe(0);
    await t.svc.createManual({ tenantId: "t1", series: "B", recipientName: "Ana", lines: [corte] });
    expect([...t.invoices.values()][0].series).toBe("B");
  });

  it("is dated today, the salon's: another day is refused; today, or left out, is today", async () => {
    const t = setup();
    const today = salonDay(new Date(), "Europe/Madrid");
    const yesterday = new Date(new Date(`${today}T00:00:00Z`).getTime() - 2 * 86_400_000).toISOString().slice(0, 10);
    expect(
      await message(
        t.svc.createManual({ tenantId: "t1", recipientName: "Ana", lines: [corte], issueDate: new Date(yesterday) }),
      ),
    ).toMatch(/^La fecha de expedición de una factura es la de hoy/);
    await t.svc.createManual({ tenantId: "t1", recipientName: "Ana", lines: [corte], issueDate: new Date(today) });
    await t.svc.createManual({ tenantId: "t1", recipientName: "Ana", lines: [corte] });
    const dates = [...t.invoices.values()].map((i) => i.issueDate.toISOString());
    expect(dates).toEqual([`${today}T00:00:00.000Z`, `${today}T00:00:00.000Z`]);
  });

  it("refuses a rate the salon's regime does not have, in Spanish", async () => {
    const t = setup({ defaultTaxRate: 21, taxRegime: "iva" });
    expect(
      await message(t.svc.createManual({ tenantId: "t1", recipientName: "Ana", lines: [{ ...corte, taxRate: 22 }] })),
    ).toBe("El tipo de IVA del 22 % no existe. Los tipos de IVA son: 0, 4, 10, 21 %.");
    expect(
      await message(t.svc.createManual({ tenantId: "t1", recipientName: "Ana", lines: [{ ...corte, taxRate: 7 }] })),
    ).toMatch(/El tipo de IVA del 7 % no existe/);
    const canarias = setup({ defaultTaxRate: 7, taxRegime: "igic" });
    await canarias.svc.createManual({ tenantId: "t1", recipientName: "Ana", lines: [{ ...corte, taxRate: 9.5 }] });
    expect(
      await message(canarias.svc.createManual({ tenantId: "t1", recipientName: "Ana", lines: [corte] })),
    ).toBe("El tipo de IGIC del 21 % no existe. Los tipos de IGIC son: 0, 3, 7, 9,5, 15, 20 %.");
  });

  it("refuses a line without a quantity", async () => {
    const t = setup();
    expect(
      await message(t.svc.createManual({ tenantId: "t1", recipientName: "Ana", lines: [{ ...corte, quantity: 0 }] })),
    ).toBe('La cantidad de la línea "Corte" tiene que ser mayor que cero.');
  });

  it("the body refuses a zero quantity, an empty invoice and a series with symbols", async () => {
    const parse = bodyParser(InvoicesController, "create");
    await expect(parse({ recipientName: "Ana", lines: [{ ...corte, quantity: 0 }] })).rejects.toBeDefined();
    await expect(parse({ recipientName: "Ana", lines: [] })).rejects.toBeDefined();
    await expect(parse({ recipientName: "Ana", series: "A-1", lines: [corte] })).rejects.toBeDefined();
    const ok: CreateInvoiceDto = await parse({ recipientName: "Ana", series: "B", lines: [{ ...corte, taxRate: 9.5 }] });
    expect(ok.lines[0].taxRate).toBe(9.5);
  });
});

describe("IGIC 9,5 %", () => {
  it("stays 9,5 in the breakdown (it was rounded to 10)", () => {
    const r = new InvoiceCalculator().compute([
      { description: "Tinte", quantity: 1, unitPriceCents: 10000, taxRate: 9.5 },
      { description: "Corte", quantity: 1, unitPriceCents: 10000, taxRate: 7 },
    ]);
    expect(r.taxBreakdown).toEqual([
      { rate: 9.5, baseCents: 10000, taxCents: 950 },
      { rate: 7, baseCents: 10000, taxCents: 700 },
    ]);
  });

  it("the tax report works the breakdown out from the lines: an old invoice with 10 stored is reported at 9,5", async () => {
    const stored = { id: "i1", series: "A", totalCents: 10950, taxBreakdown: [{ rate: 10, baseCents: 10000, taxCents: 950 }] };
    const prisma: any = {
      tenant: { findUnique: jest.fn(async () => ({ fiscalSettings: { taxRegime: "igic" } })) },
      invoice: {
        findMany: jest.fn(async () => [
          { ...stored, lines: [{ taxRate: "9.5", taxCents: 950, totalCents: 10950 }] },
          // No lines selected (or none stored): the stored breakdown.
          { id: "i2", series: "A", totalCents: 1070, taxBreakdown: [{ rate: 7, baseCents: 1000, taxCents: 70 }], lines: [] },
        ]),
      },
      taxReport: { upsert: jest.fn(async (args: any) => ({ id: "r1", ...args.create, status: "draft" })) },
    };
    const report = await new TaxReportsService(prisma).generate("t1", "modelo_420" as any, 2026, 4);
    const totals = report.totalsJson as Record<string, number>;
    // Rates ascending: 7 % first, then 9,5 %.
    expect([totals["02"], totals["05"]]).toEqual([7, 9.5]);
    expect([totals["04"], totals["06"]]).toEqual([10000, 950]);
  });
});

describe("the salon's default rate", () => {
  it("is its regime's general rate when it set none (IGIC 7, IPSI 10), not 21", () => {
    expect(salonTaxRate({ taxRegime: "igic" })).toBe(7);
    expect(salonTaxRate({ taxRegime: "ipsi" })).toBe(10);
    expect(salonTaxRate({ taxRegime: "iva" })).toBe(21);
    expect(salonTaxRate({})).toBe(21);
    expect(salonTaxRate(null)).toBe(21);
    // An explicit one always wins.
    expect(salonTaxRate({ taxRegime: "igic", defaultTaxRate: 3 })).toBe(3);
  });
});

describe("GET /invoices query", () => {
  const parse = (q: Record<string, unknown>) => plainToInstance(ListInvoicesQueryDto, q);

  it("takes numbers from the query string and caps the page at 100", async () => {
    const q = parse({ limit: "20", offset: "40", page: "3" });
    expect([q.limit, q.offset, q.page]).toEqual([20, 40, 3]);
    expect(await validate(q)).toEqual([]);
    const errors = await validate(parse({ limit: "500" }));
    expect(errors[0].constraints?.max).toBe("El límite no puede pasar de 100.");
  });

  it("accepts only the statuses an invoice has", async () => {
    expect(await validate(parse({ status: "issued" }))).toEqual([]);
    expect(await validate(parse({ status: "cancelled" }))).toEqual([]);
    expect((await validate(parse({ status: "paid" })))[0].constraints?.isIn).toMatch(/emitida/);
  });

  it("searches a number, a name or a NIF, by whole days, newest first, a page at a time", async () => {
    const findMany = jest.fn(async () => []);
    const svc = new InvoiceService({ invoice: { findMany } } as any, new InvoiceCalculator(), {} as any);
    await svc.list("t1", { q: "A2027-000012", dateFrom: "2027-01-01", dateTo: "2027-01-31", limit: 20, page: 3 });
    const args = (findMany.mock.calls[0] as any[])[0];
    expect(args.where.tenantId).toBe("t1");
    expect(args.where.issueDate).toEqual({
      gte: new Date("2027-01-01T00:00:00.000Z"),
      lt: new Date("2027-02-01T00:00:00.000Z"),
    });
    expect(args.where.OR).toEqual(
      expect.arrayContaining([
        { number: { contains: "A2027-000012" } },
        { recipientName: { contains: "A2027-000012", mode: "insensitive" } },
        { series: { equals: "A", mode: "insensitive" }, number: { contains: "2027-000012" } },
      ]),
    );
    expect(args.orderBy).toEqual([{ issueDate: "desc" }, { createdAt: "desc" }]);
    expect([args.take, args.skip]).toEqual([20, 40]);
    await svc.list("t1", { limit: 1000, offset: 5 });
    const second = (findMany.mock.calls[1] as any[])[0];
    expect([second.take, second.skip]).toEqual([100, 5]);
  });
});

describe("issueSimplifiedInvoiceForSale (the till's tickets)", () => {
  function till(fiscalSettings: Record<string, unknown> = { defaultSeries: "A", defaultTaxRate: 21, pricesIncludeTax: true }) {
    const t = setup(fiscalSettings);
    t.prisma.client = {
      findFirst: jest.fn(async ({ where }: any) =>
        where.id === "c1" && where.tenantId === "t1"
          ? { id: "c1", firstName: "Ana", lastName: "López", taxId: "12345678Z" }
          : null,
      ),
    };
    const sale = (extra: Record<string, unknown> = {}) =>
      t.svc.issueSimplifiedInvoiceForSale(t.prisma, {
        tenantId: "t1",
        saleId: "sale-1",
        paymentIds: ["pay-1", "pay-2"],
        lines: [{ description: "Champú", quantity: 2, unitPriceCents: 1210, taxRate: 21 }],
        ...extra,
      });
    return { ...t, sale };
  }

  it("issues a simplified invoice in series T, tied to the sale, at the till's prices", async () => {
    const t = till();
    const r = await t.sale();
    expect(r).toEqual({ id: "inv-1", fiscalMode: "none", series: "T", number: expect.any(String), created: true });
    const inv = t.invoices.get(r.id);
    expect(inv).toMatchObject({
      series: "T",
      sourceType: POS_SALE_SOURCE,
      sourceId: "sale-1",
      recipientType: "tenant",
      recipientName: "Consumidor final",
      totalCents: 2420,
      subtotalCents: 2000,
      notes: "Factura simplificada de la venta sale-1 (pagos: pay-1, pay-2)",
    });
    expect(inv.number).toBe(formatInvoiceNumber(inv.issueDate.getUTCFullYear(), 1));
  });

  it("is idempotent by the sale: a second call returns the same invoice and uses no number", async () => {
    const t = till();
    const first = await t.sale();
    const second = await t.sale();
    expect(second).toEqual({ ...first, created: false });
    expect(t.invoices.size).toBe(1);
    // Calls for one sale wait for each other (an advisory lock on the sale).
    expect(t.locks.filter((k) => k === "invoice:pos_sale:t1:sale-1")).toHaveLength(2);
  });

  it("a cancelled ticket does not count: the sale can be invoiced again", async () => {
    const t = till();
    const first = await t.sale();
    t.invoices.get(first.id).status = "cancelled";
    const again = await t.sale();
    expect(again.created).toBe(true);
    expect(again.id).not.toBe(first.id);
  });

  it("names the salon's client, with her NIF; another salon's client is refused", async () => {
    const t = till();
    const r = await t.sale({ clientId: "c1" });
    expect(t.invoices.get(r.id)).toMatchObject({
      recipientType: "client",
      recipientId: "c1",
      recipientName: "Ana López",
      recipientTaxId: "12345678Z",
    });
    expect(await message(t.sale({ saleId: "sale-2", clientId: "c-other" }))).toBe(
      "La clienta de la venta no es de este salón.",
    );
  });

  it("refuses more than 3.000 EUR (a full invoice is needed) and a sale with no lines", async () => {
    const t = till();
    expect(
      await message(
        t.sale({ lines: [{ description: "Bono", quantity: 1, unitPriceCents: SIMPLIFIED_INVOICE_MAX_CENTS + 1, taxRate: 21 }] }),
      ),
    ).toMatch(/no puede pasar de 3\.000,00 €/);
    expect(await message(t.sale({ lines: [] }))).toMatch(/at least one line/);
    expect(t.invoices.size).toBe(0);
  });

  it("follows the salon's prices: tax on top when its prices do not include it", async () => {
    const t = till({ defaultTaxRate: 21, pricesIncludeTax: false });
    const r = await t.sale();
    expect(t.invoices.get(r.id).totalCents).toBe(2928);
  });
});

describe("FiscalService.anulateInvoice while fiscal submission is off", () => {
  it("signs and sends nothing, and says the anulation is pending", async () => {
    const saved = { ...process.env };
    process.env.NODE_ENV = "production";
    delete process.env.FISCAL_SUBMISSION_ENABLED;
    try {
      const prisma: any = {
        invoice: {
          findUnique: jest.fn(async () => ({ id: "i1", tenantId: "t1", tenant: { fiscalMode: "verifactu", fiscalSettings: {} } })),
          update: jest.fn(),
        },
        fiscalChainState: { findUnique: jest.fn() },
      };
      const verifactu = { buildAnulateXml: jest.fn(), signWithTenantCert: jest.fn(), dispatch: jest.fn() };
      const service = new FiscalService(prisma, verifactu as any, {} as any, {} as any);
      expect(await service.anulateInvoice("i1", "x")).toBe(false);
      expect(verifactu.buildAnulateXml).not.toHaveBeenCalled();
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    } finally {
      process.env = saved;
    }
  });
});
