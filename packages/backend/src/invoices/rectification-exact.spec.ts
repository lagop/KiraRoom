import "reflect-metadata";
import { BadRequestException } from "@nestjs/common";
import { InvoiceService } from "./invoices.service";
import { InvoiceCalculator } from "./invoice-calculator.service";
import { InvoicesController } from "./invoices.controller";
import { bodyParser } from "../common/validation/validated-body.testing";

/**
 * A rectifying invoice that cancels the original nets it to exactly zero:
 * every line's base, tax and total, negated, and so the invoice's subtotal,
 * tax breakdown and total.
 *
 * It was recomputed from the stored unit price, which for a price with the
 * tax included is the net one, rounded: 10,00 EUR at 21 % is stored at 8,26
 * a unit, and 8,26 with 21 % on top is 9,99. The rectificativa left 0,01 EUR
 * standing, and new salons price with the tax included (#178).
 */

function store() {
  const invoices = new Map<string, any>();
  let n = 0;
  const tx: any = {
    fiscalSequence: {
      upsert: jest.fn(async () => ({})),
      update: jest.fn(async () => ({ lastNumber: ++n })),
    },
    invoice: {
      create: jest.fn(async (args: any) => {
        const id = `inv-${invoices.size + 1}`;
        const { lines, ...rest } = args.data;
        const row = {
          id,
          ...rest,
          lines: lines.create.map((l: any, i: number) => ({ id: `${id}-line-${i + 1}`, invoiceId: id, ...l })),
        };
        invoices.set(id, row);
        return row;
      }),
    },
  };
  const prisma: any = {
    ...tx,
    tenant: {
      findUnique: jest.fn(async () => ({
        fiscalMode: "none",
        fiscalSettings: { defaultSeries: "A", defaultTaxRate: 21, pricesIncludeTax: true },
      })),
    },
    invoice: {
      ...tx.invoice,
      findFirst: jest.fn(async (args: any) => {
        const row = invoices.get(args.where.id);
        return row && row.tenantId === args.where.tenantId ? row : null;
      }),
    },
    $transaction: async (fn: any) => fn(tx),
  };
  const svc = new InvoiceService(prisma, new InvoiceCalculator(), {} as any);
  return { svc, invoices };
}

type Line = Parameters<InvoiceService["create"]>[0]["lines"][number];

async function issue(svc: InvoiceService, lines: Line[]) {
  return svc.create({ tenantId: "tenant-1", recipientName: "Ana Prueba", lines });
}

/** The two invoices together: zero everywhere, line by line and in total. */
function expectNetZero(original: any, rect: any) {
  expect(rect.series).toBe("R");
  expect(rect.subtotalCents).toBe(-original.subtotalCents);
  expect(rect.totalCents).toBe(-original.totalCents);
  expect(rect.taxBreakdown).toEqual(
    original.taxBreakdown.map((t: any) => ({ rate: t.rate, baseCents: -t.baseCents, taxCents: -t.taxCents })),
  );
  expect(rect.lines).toHaveLength(original.lines.length);
  rect.lines.forEach((l: any, i: number) => {
    const o = original.lines[i];
    expect(l.taxCents + o.taxCents).toBe(0);
    expect(l.totalCents + o.totalCents).toBe(0);
    expect(Number(l.quantity) + Number(o.quantity)).toBe(0);
    expect(l.unitPriceCents).toBe(o.unitPriceCents);
    expect(l.taxIncluded).toBe(o.taxIncluded);
  });
}

describe("a full rectification nets the original to zero", () => {
  it("10,00 EUR with 21 % included: 8,26 + 1,74 back, not 9,99", async () => {
    const { svc, invoices } = store();
    const { id } = await issue(svc, [{ description: "Corte", quantity: 1, unitPriceCents: 1000, taxRate: 21, taxIncluded: true }]);
    const original = invoices.get(id);
    expect(original).toMatchObject({ subtotalCents: 826, totalCents: 1000 });
    expect(original.lines[0]).toMatchObject({ unitPriceCents: 826, taxCents: 174, taxIncluded: true });

    const rect = invoices.get((await svc.emitRectification("tenant-1", id, undefined, "Anulada")).id);
    expectNetZero(original, rect);
    expect(rect).toMatchObject({ subtotalCents: -826, totalCents: -1000 });
    expect(rect.notes).toMatch(/Rectificación de A000001: Anulada/);
  });

  it("recomputing from the stored unit price is what left the cent", async () => {
    const { svc, invoices } = store();
    const { id } = await issue(svc, [{ description: "Corte", quantity: 1, unitPriceCents: 1000, taxRate: 21, taxIncluded: true }]);
    const stored = invoices.get(id).lines[0];
    const rect = invoices.get(
      (
        await svc.emitRectification(
          "tenant-1",
          id,
          [{ description: "Corte", quantity: -1, unitPriceCents: stored.unitPriceCents, taxRate: 21 }],
          "a mano",
        )
      ).id,
    );
    expect(rect.totalCents).toBe(-999);
  });

  it("IGIC 7 %, 10,00 EUR included: 9,35 + 0,65 back", async () => {
    const { svc, invoices } = store();
    const { id } = await issue(svc, [{ description: "Manicura", quantity: 1, unitPriceCents: 1000, taxRate: 7, taxIncluded: true }]);
    const original = invoices.get(id);
    expect(original.taxBreakdown).toEqual([{ rate: 7, baseCents: 935, taxCents: 65 }]);
    const rect = invoices.get((await svc.emitRectification("tenant-1", id, undefined, "Anulada")).id);
    expectNetZero(original, rect);
    expect(rect.totalCents).toBe(-1000);
  });

  it("several lines, rates and discounts, included and on top", async () => {
    const { svc, invoices } = store();
    const { id } = await issue(svc, [
      { description: "Mechas", quantity: 3, unitPriceCents: 3000, discountPct: 10, taxRate: 21, taxIncluded: true },
      { description: "Tratamiento", quantity: 1, unitPriceCents: 1999, discountPct: 15, taxRate: 10, taxIncluded: true },
      { description: "Champú", quantity: 2, unitPriceCents: 1234, discountPct: 5, taxRate: 21 },
      { description: "Peinado", quantity: 1, unitPriceCents: 2500, discountCents: 300, taxRate: 21, taxIncluded: true },
      { description: "Laca", quantity: 1.5, unitPriceCents: 777, taxRate: 7, taxIncluded: true },
    ]);
    const original = invoices.get(id);
    const rect = invoices.get((await svc.emitRectification("tenant-1", id, undefined, "Anulada")).id);
    expectNetZero(original, rect);
    expect(original.totalCents + rect.totalCents).toBe(0);
  });

  it("naming every line with its whole quantity is the same", async () => {
    const { svc, invoices } = store();
    const { id } = await issue(svc, [
      { description: "Mechas", quantity: 3, unitPriceCents: 3000, discountPct: 10, taxRate: 21, taxIncluded: true },
      { description: "Champú", quantity: 2, unitPriceCents: 1234, taxRate: 21 },
    ]);
    const original = invoices.get(id);
    const lines = original.lines.map((l: any) => ({ originalLineId: l.id, quantity: -Number(l.quantity) }));
    const rect = invoices.get((await svc.emitRectification("tenant-1", id, lines, "Anulada")).id);
    expectNetZero(original, rect);
  });
});

describe("crediting part of a line", () => {
  it("1 of 3 units of 10,00 EUR included is 10,00 back, split like the original", async () => {
    const { svc, invoices } = store();
    const { id } = await issue(svc, [{ description: "Corte", quantity: 3, unitPriceCents: 1000, taxRate: 21, taxIncluded: true }]);
    const lineId = invoices.get(id).lines[0].id;
    const rect = invoices.get((await svc.emitRectification("tenant-1", id, [{ originalLineId: lineId, quantity: -1 }], "Una no")).id);
    expect(rect.lines[0]).toMatchObject({ quantity: -1, taxCents: -174, totalCents: -1000, taxIncluded: true });
    expect(rect.totalCents).toBe(-1000);
  });

  it("a line with the tax on top: the share of the base, and its tax", async () => {
    const { svc, invoices } = store();
    const { id } = await issue(svc, [{ description: "Champú", quantity: 2, unitPriceCents: 1234, taxRate: 21 }]);
    const lineId = invoices.get(id).lines[0].id;
    const rect = invoices.get((await svc.emitRectification("tenant-1", id, [{ originalLineId: lineId, quantity: -1 }], "Uno no")).id);
    // 12,34 + 2,59
    expect(rect.lines[0]).toMatchObject({ taxCents: -259, totalCents: -1493 });
  });

  it("refuses a line from another invoice, a quantity that is not a credit, and crediting more than the line", async () => {
    const { svc, invoices } = store();
    const { id } = await issue(svc, [{ description: "Corte", quantity: 2, unitPriceCents: 1000, taxRate: 21, taxIncluded: true }]);
    const lineId = invoices.get(id).lines[0].id;
    await expect(svc.emitRectification("tenant-1", id, [{ originalLineId: "other-line", quantity: -1 }], "x")).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.emitRectification("tenant-1", id, [{ originalLineId: lineId, quantity: 1 }], "x")).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.emitRectification("tenant-1", id, [{ originalLineId: lineId, quantity: -3 }], "x")).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.emitRectification("tenant-1", id, [{ originalLineId: lineId, quantity: -2 }, { originalLineId: lineId, quantity: -1 }], "x"),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("POST /invoices/:id/rectify body", () => {
  const parse = bodyParser(InvoicesController, "rectify");

  it("lines are optional: without them the whole invoice is rectified", async () => {
    expect((await parse({ reason: "Anulada" })).lines).toBeUndefined();
  });

  it("a line naming the original needs only the quantity", async () => {
    const body = await parse({ reason: "x", lines: [{ originalLineId: "inv-1-line-1", quantity: -1 }] });
    expect(body.lines[0]).toMatchObject({ originalLineId: "inv-1-line-1", quantity: -1 });
  });

  it("a free line still needs its description, price and rate", async () => {
    await expect(parse({ reason: "x", lines: [{ quantity: -1 }] })).rejects.toBeDefined();
    const ok = await parse({ reason: "x", lines: [{ description: "Ajuste", quantity: -1, unitPriceCents: 500, taxRate: 21 }] });
    expect(ok.lines[0].description).toBe("Ajuste");
  });
});
