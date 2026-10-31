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
 * top, whatever the form showed. Left out, it is still false: the tax on top,
 * what the endpoint always did.
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
    const create = jest.fn(async (_input: Parameters<InvoiceService["create"]>[0]) => ({ id: "inv-1" }));
    const invoices = { create } as unknown as InvoiceService;
    const ctl = new InvoicesController(invoices, {} as any, {} as any, {} as any);
    const req = { user: { tenantId: "tenant-1" } } as any;
    return { ctl, req, create };
  }

  it("true stays true, false and left out are false (tax on top)", async () => {
    const { ctl, req, create } = controller();
    await ctl.create(req, {
      recipientName: "Ana Prueba",
      lines: [
        { ...line, taxIncluded: true },
        { ...line, taxIncluded: false },
        { ...line },
      ],
    } as any);
    expect(create.mock.calls[0][0].lines.map((l) => l.taxIncluded)).toEqual([true, false, false]);
  });
});

describe("InvoiceService.create with a tax-included line", () => {
  function service() {
    const invoiceCreate = jest.fn(async (args: any) => ({ id: "inv-1", ...args.data }));
    const tx: any = {
      fiscalSequence: {
        upsert: jest.fn(async () => ({})),
        update: jest.fn(async () => ({ lastNumber: 1 })),
      },
      invoice: { create: invoiceCreate },
    };
    const prisma: any = {
      ...tx,
      tenant: {
        findUnique: jest.fn(async () => ({
          fiscalMode: "none",
          fiscalSettings: { defaultSeries: "A", defaultTaxRate: 21, pricesIncludeTax: true },
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
