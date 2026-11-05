import "reflect-metadata";
import { InvoicesController } from "./invoices.controller";
import { InvoiceService } from "./invoices.service";
import { InvoiceCalculator } from "./invoice-calculator.service";
import { bodyParser } from "../common/validation/validated-body.testing";

/**
 * A manual invoice (POST /invoices, the "Nueva factura" form) follows the
 * salon's "Mis precios ya incluyen el impuesto": the form sends `taxIncluded`
 * on every line, and a 30,00 EUR price at 21 % is invoiced as 24,79 + 5,21.
 *
 * CreateInvoiceLineDto had no `taxIncluded`, so the global ValidationPipe
 * (whitelist) dropped it without a word and every manual line was taxed on
 * top, whatever the form showed. Left out (an API client, an older form), it
 * follows the salon's setting, decided on the server; it used to be false,
 * the tax on top even for a salon whose prices include it.
 */

const line = { description: "Corte", quantity: 1, unitPriceCents: 3000, taxRate: 21 };
const body = (extra: Record<string, unknown> = {}) => ({
  recipientName: "Ana Prueba",
  lines: [{ ...line, ...extra }],
});

describe("POST /invoices body: taxIncluded per line", () => {
  const parse = bodyParser(InvoicesController, "create");

  it("keeps true and false", async () => {
    expect((await parse(body({ taxIncluded: true }))).lines[0].taxIncluded).toBe(true);
    expect((await parse(body({ taxIncluded: false }))).lines[0].taxIncluded).toBe(false);
  });

  it("is optional", async () => {
    expect((await parse(body())).lines[0].taxIncluded).toBeUndefined();
  });

  it("refuses anything but a boolean", async () => {
    await expect(parse(body({ taxIncluded: "true" }))).rejects.toBeDefined();
    await expect(parse(body({ taxIncluded: 1 }))).rejects.toBeDefined();
  });
});

describe("InvoicesController.create passes it on", () => {
  function controller() {
    const create = jest.fn(async (_input: Parameters<InvoiceService["createManual"]>[0]) => ({ id: "inv-1" }));
    const invoices = { createManual: create } as unknown as InvoiceService;
    const ctl = new InvoicesController(invoices, {} as any, {} as any, {} as any, {} as any);
    const req = { user: { tenantId: "tenant-1" } } as any;
    return { ctl, req, create };
  }

  it("true and false stay as sent; left out is left to the salon's setting", async () => {
    const { ctl, req, create } = controller();
    await ctl.create(req, {
      recipientName: "Ana Prueba",
      lines: [
        { ...line, taxIncluded: true },
        { ...line, taxIncluded: false },
        { ...line },
      ],
    } as any);
    const input = create.mock.calls[0][0];
    expect(input.lines.map((l) => l.taxIncluded)).toEqual([true, false, undefined]);
    expect(input.taxIncludedFromSalon).toBe(true);
  });
});

describe("InvoiceService.create with a tax-included line", () => {
  function service(fiscalSettings: Record<string, unknown> = { defaultSeries: "A", defaultTaxRate: 21, pricesIncludeTax: true }) {
    const invoiceCreate = jest.fn(async (args: any) => ({ id: "inv-1", ...args.data }));
    const tx: any = {
      $queryRaw: jest.fn(async () => [{ lastNumber: 1 }]),
      invoice: { create: invoiceCreate },
    };
    const prisma: any = {
      ...tx,
      tenant: {
        findUnique: jest.fn(async () => ({
          fiscalMode: "none",
          fiscalSettings,
        })),
      },
      $transaction: async (fn: any) => fn(tx),
    };
    const svc = new InvoiceService(prisma, new InvoiceCalculator(), {} as any);
    return { svc, invoiceCreate };
  }

  it("30,00 EUR at 21 % is 24,79 + 5,21 = 30,00", async () => {
    const { svc, invoiceCreate } = service();
    await svc.create({ tenantId: "tenant-1", recipientName: "Ana Prueba", lines: [{ ...line, taxIncluded: true }] });
    const data = invoiceCreate.mock.calls[0][0].data;
    expect(data.subtotalCents).toBe(2479);
    expect(data.totalCents).toBe(3000);
    expect(data.taxBreakdown).toEqual([{ rate: 21, baseCents: 2479, taxCents: 521 }]);
    expect(data.lines.create[0]).toMatchObject({ unitPriceCents: 2479, taxCents: 521, totalCents: 3000 });
  });

  it("the same line on top is 30,00 + 6,30 = 36,30", async () => {
    const { svc, invoiceCreate } = service();
    await svc.create({ tenantId: "tenant-1", recipientName: "Ana Prueba", lines: [{ ...line, taxIncluded: false }] });
    const data = invoiceCreate.mock.calls[0][0].data;
    expect(data.subtotalCents).toBe(3000);
    expect(data.totalCents).toBe(3630);
  });
});

describe("a line sent without taxIncluded follows the salon (POST /invoices)", () => {
  function issue(fiscalSettings: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const invoiceCreate = jest.fn(async (args: any) => ({ id: "inv-1", ...args.data }));
    const tx: any = {
      $queryRaw: jest.fn(async () => [{ lastNumber: 1 }]),
      invoice: { create: invoiceCreate },
    };
    const prisma: any = {
      ...tx,
      tenant: { findUnique: jest.fn(async () => ({ fiscalMode: "none", fiscalSettings })) },
      $transaction: async (fn: any) => fn(tx),
    };
    const svc = new InvoiceService(prisma, new InvoiceCalculator(), {} as any);
    const ctl = new InvoicesController(svc, {} as any, {} as any, {} as any, {} as any);
    return ctl
      .create({ user: { tenantId: "tenant-1" } } as any, { recipientName: "Ana Prueba", lines: [{ ...line, ...extra }] } as any)
      .then(() => invoiceCreate.mock.calls[0][0].data);
  }

  it("prices with the tax included: 30,00 EUR is 24,79 + 5,21, not 30,00 + 6,30", async () => {
    const data = await issue({ defaultTaxRate: 21, pricesIncludeTax: true });
    expect(data.totalCents).toBe(3000);
    expect(data.subtotalCents).toBe(2479);
    expect(data.lines.create[0]).toMatchObject({ taxIncluded: true, unitPriceCents: 2479, taxCents: 521 });
  });

  it("prices with the tax on top, or a salon from before the setting: on top, as before", async () => {
    expect((await issue({ defaultTaxRate: 21, pricesIncludeTax: false })).totalCents).toBe(3630);
    const legacy = await issue({ defaultTaxRate: 21 });
    expect(legacy.totalCents).toBe(3630);
    expect(legacy.lines.create[0].taxIncluded).toBe(false);
  });

  it("an explicit true or false still wins over the salon", async () => {
    expect((await issue({ pricesIncludeTax: true }, { taxIncluded: false })).totalCents).toBe(3630);
    expect((await issue({ pricesIncludeTax: false }, { taxIncluded: true })).totalCents).toBe(3000);
  });

  it("only POST /invoices: other callers that leave it out keep the tax on top", async () => {
    const invoiceCreate = jest.fn(async (args: any) => ({ id: "inv-1", ...args.data }));
    const tx: any = {
      $queryRaw: jest.fn(async () => [{ lastNumber: 1 }]),
      invoice: { create: invoiceCreate },
    };
    const prisma: any = {
      ...tx,
      tenant: { findUnique: jest.fn(async () => ({ fiscalMode: "none", fiscalSettings: { pricesIncludeTax: true } })) },
      $transaction: async (fn: any) => fn(tx),
    };
    const svc = new InvoiceService(prisma, new InvoiceCalculator(), {} as any);
    await svc.create({ tenantId: "tenant-1", recipientName: "Ana Prueba", lines: [{ ...line }] });
    expect(invoiceCreate.mock.calls[0][0].data.totalCents).toBe(3630);
  });
});
