import { BadRequestException } from "@nestjs/common";
import { InvoiceService } from "./invoices.service";
import { InvoiceCalculator } from "./invoice-calculator.service";
import { invoiceStore } from "./invoice-store.testing";

/**
 * What is left to credit of an invoice, across separate rectificativas.
 *
 * Two partial rectificativas could each credit the same line of the
 * original: crediting more than was invoiced. Every rectificativa line now
 * names the line it credits (rectifiesLineId) and each request is checked
 * against what earlier non-cancelled ones left (rectification-lines.ts).
 */

function setup(fiscalSettings: Record<string, unknown> = { defaultSeries: "A", defaultTaxRate: 21 }) {
  const store = invoiceStore(fiscalSettings);
  const svc = new InvoiceService(store.prisma, new InvoiceCalculator(), {} as any);
  const issue = async (lines: Parameters<InvoiceService["create"]>[0]["lines"]) => {
    const { id } = await svc.create({ tenantId: "t1", recipientName: "Ana Prueba", lines });
    return store.invoices.get(id);
  };
  const rectify = async (id: string, lines?: any[], reason = "x") =>
    store.invoices.get((await svc.emitRectification("t1", id, lines, reason)).id);
  return { ...store, svc, issue, rectify };
}

const message = (p: Promise<unknown>) => p.then(() => "", (e) => (e instanceof BadRequestException ? e.message : `not a 400: ${e}`));

describe("partial credits across rectificativas", () => {
  it("links each line to the line it credits", async () => {
    const t = setup();
    const original = await t.issue([{ description: "Corte", quantity: 2, unitPriceCents: 1000, taxRate: 21, taxIncluded: true }]);
    const rect = await t.rectify(original.id, [{ originalLineId: original.lines[0].id, quantity: -1 }]);
    expect(rect.lines[0].rectifiesLineId).toBe(original.lines[0].id);
    // The full rectification links its lines too.
    const rest = await t.rectify(original.id);
    expect(rest.lines.map((l: any) => l.rectifiesLineId)).toEqual([original.lines[0].id]);
  });

  it("two separate rectificativas cannot credit the same unit twice", async () => {
    const t = setup();
    const original = await t.issue([{ description: "Corte", quantity: 2, unitPriceCents: 1000, taxRate: 21, taxIncluded: true }]);
    const lineId = original.lines[0].id;
    const first = await t.rectify(original.id, [{ originalLineId: lineId, quantity: -1 }]);
    const second = await t.rectify(original.id, [{ originalLineId: lineId, quantity: -1 }]);
    expect(first.totalCents + second.totalCents).toBe(-2000);
    // The second one takes exactly what was left: the two net the line to zero.
    expect(first.lines[0].taxCents + second.lines[0].taxCents).toBe(-original.lines[0].taxCents);
    expect(await message(t.rectify(original.id, [{ originalLineId: lineId, quantity: -1 }]))).toBe(
      'La línea "Corte" ya está abonada entera',
    );
    expect(t.invoices.size).toBe(3);
  });

  it("refuses more units than are left, saying how many", async () => {
    const t = setup();
    const original = await t.issue([{ description: "Mechas", quantity: 3, unitPriceCents: 3000, taxRate: 21 }]);
    const lineId = original.lines[0].id;
    await t.rectify(original.id, [{ originalLineId: lineId, quantity: -2 }]);
    expect(await message(t.rectify(original.id, [{ originalLineId: lineId, quantity: -2 }]))).toBe(
      'La línea "Mechas" solo se puede abonar: entre -1 y 0 unidades, sin llegar a 0 (el resto ya está abonado en otra rectificativa)',
    );
    const last = await t.rectify(original.id, [{ originalLineId: lineId, quantity: -1 }]);
    expect(last.lines[0]).toMatchObject({ quantity: -1, totalCents: -3630 });
  });

  it("a full rectification after a partial one credits only what is left; together they net to zero", async () => {
    const t = setup();
    const original = await t.issue([
      { description: "Mechas", quantity: 3, unitPriceCents: 3000, discountPct: 10, taxRate: 21, taxIncluded: true },
      { description: "Champú", quantity: 2, unitPriceCents: 1234, taxRate: 21 },
    ]);
    const partial = await t.rectify(original.id, [{ originalLineId: original.lines[0].id, quantity: -1 }]);
    const rest = await t.rectify(original.id);
    expect(partial.totalCents + rest.totalCents).toBe(-original.totalCents);
    expect(partial.subtotalCents + rest.subtotalCents).toBe(-original.subtotalCents);
    expect(rest.lines.map((l: any) => Number(l.quantity))).toEqual([-2, -2]);
    expect(await message(t.rectify(original.id))).toBe("La factura ya está abonada entera: no queda nada que rectificar");
  });

  it("a cancelled rectificativa gives its credit back", async () => {
    const t = setup();
    const original = await t.issue([{ description: "Corte", quantity: 1, unitPriceCents: 1000, taxRate: 21 }]);
    const rect = await t.rectify(original.id);
    await t.svc.cancel("t1", rect.id, "emitida por error");
    const again = await t.rectify(original.id);
    expect(again.totalCents).toBe(-1210);
  });

  it("refuses to rectify a cancelled invoice", async () => {
    const t = setup();
    const original = await t.issue([{ description: "Corte", quantity: 1, unitPriceCents: 1000, taxRate: 21 }]);
    await t.svc.cancel("t1", original.id, "error");
    expect(await message(t.rectify(original.id))).toBe("La factura A000001 está anulada: no se puede rectificar");
  });

  it("locks the original while it is rectified, so two at once cannot both pass", async () => {
    const t = setup();
    const original = await t.issue([{ description: "Corte", quantity: 1, unitPriceCents: 1000, taxRate: 21 }]);
    await t.rectify(original.id);
    expect(t.locks).toEqual([original.id]);
  });

  it("a free line cannot take the invoice past zero", async () => {
    const t = setup();
    const original = await t.issue([{ description: "Corte", quantity: 1, unitPriceCents: 1000, taxRate: 21 }]);
    expect(
      await message(t.rectify(original.id, [{ description: "Ajuste", quantity: -1, unitPriceCents: 2000, taxRate: 21 }])),
    ).toBe(
      "La rectificativa abonaría 24,20 €, pero de esta factura solo quedan 12,10 € por abonar: lo ya abonado en otras rectificativas no se puede volver a abonar",
    );
    // An adjustment within the invoice is still fine.
    expect((await t.rectify(original.id, [{ description: "Ajuste", quantity: -1, unitPriceCents: 200, taxRate: 21 }])).totalCents).toBe(-242);
  });
});

describe("rectificativas from before the line link", () => {
  /** A rectificativa as they were issued: the note, no rectifiesLineId on its lines. */
  function legacy(t: ReturnType<typeof setup>, original: any, totalCents: number, taxCents: number, status = "issued") {
    const id = `legacy-${t.invoices.size + 1}`;
    t.invoices.set(id, {
      id,
      tenantId: "t1",
      series: "R",
      number: "000009",
      status,
      notes: `Rectificación de ${original.series}${original.number}: antigua`,
      totalCents,
      lines: [{ id: `${id}-line-1`, quantity: -1, taxCents, totalCents, rectifiesLineId: null }],
    });
  }

  it("count against the invoice as a whole: a full rectification shares them over the lines and credits the rest", async () => {
    const t = setup();
    const original = await t.issue([
      { description: "Corte", quantity: 1, unitPriceCents: 1000, taxRate: 21, taxIncluded: true },
      { description: "Tinte", quantity: 1, unitPriceCents: 3000, taxRate: 21, taxIncluded: true },
    ]);
    legacy(t, original, -1000, -174);
    const rest = await t.rectify(original.id);
    expect(rest.totalCents).toBe(-3000);
    // 10,00 off a 40,00 invoice, in proportion: 2,50 from the 10,00 line, 7,50 from the 30,00 one.
    expect(rest.lines.map((l: any) => l.totalCents)).toEqual([-750, -2250]);
    expect(await message(t.rectify(original.id))).toBe("La factura ya está abonada entera: no queda nada que rectificar");
  });

  it("a line credit past what the invoice has left is refused", async () => {
    const t = setup();
    const original = await t.issue([
      { description: "Corte", quantity: 1, unitPriceCents: 1000, taxRate: 21, taxIncluded: true },
      { description: "Tinte", quantity: 1, unitPriceCents: 3000, taxRate: 21, taxIncluded: true },
    ]);
    legacy(t, original, -3500, -607);
    expect(await message(t.rectify(original.id, [{ originalLineId: original.lines[1].id, quantity: -1 }]))).toBe(
      "La rectificativa abonaría 30,00 €, pero de esta factura solo quedan 5,00 € por abonar: lo ya abonado en otras rectificativas no se puede volver a abonar",
    );
    // Half the 10,00 line (5,00) fits in the 5,00 left.
    expect((await t.rectify(original.id, [{ originalLineId: original.lines[0].id, quantity: -0.5 }])).totalCents).toBe(-500);
  });

  it("a cancelled one does not count", async () => {
    const t = setup();
    const original = await t.issue([{ description: "Corte", quantity: 1, unitPriceCents: 1000, taxRate: 21, taxIncluded: true }]);
    legacy(t, original, -1000, -174, "cancelled");
    expect((await t.rectify(original.id)).totalCents).toBe(-1000);
  });
});

describe("a credit by amount (a discount after the invoice)", () => {
  async function byAmount(t: ReturnType<typeof setup>, id: string, cents: number) {
    const issued = await t.svc.rectifyByAmountIn(t.prisma, "t1", id, cents, "Descuento en caja");
    return t.invoices.get(issued.id);
  }

  it("with the tax included: 5,00 off is 4,13 + 0,87 back; the units stay", async () => {
    const t = setup();
    const original = await t.issue([{ description: "Corte", quantity: 1, unitPriceCents: 4000, taxRate: 21, taxIncluded: true }]);
    const rect = await byAmount(t, original.id, 500);
    expect(rect).toMatchObject({ series: "R", totalCents: -500, subtotalCents: -413 });
    expect(rect.notes).toBe("Rectificación de A000001: Descuento en caja");
    expect(rect.lines[0]).toMatchObject({
      description: "Descuento: Corte",
      quantity: 1,
      unitPriceCents: -413,
      taxCents: -87,
      totalCents: -500,
      taxIncluded: true,
      rectifiesLineId: original.lines[0].id,
    });
    // Returning the service afterwards credits what is left: 35,00, not 40,00.
    const rest = await t.rectify(original.id, [{ originalLineId: original.lines[0].id, quantity: -1 }]);
    expect(rest.totalCents).toBe(-3500);
    expect(rect.totalCents + rest.totalCents).toBe(-original.totalCents);
  });

  it("with the tax on top: 5,00 off the base is 5,00 + 1,05 back", async () => {
    const t = setup();
    const original = await t.issue([{ description: "Corte", quantity: 1, unitPriceCents: 4000, taxRate: 21 }]);
    const rect = await byAmount(t, original.id, 500);
    expect(rect).toMatchObject({ subtotalCents: -500, totalCents: -605 });
  });

  it("several lines: shared in proportion, adding up exactly", async () => {
    const t = setup();
    const original = await t.issue([
      { description: "Corte", quantity: 1, unitPriceCents: 1000, taxRate: 21, taxIncluded: true },
      { description: "Tinte", quantity: 1, unitPriceCents: 2000, taxRate: 21, taxIncluded: true },
    ]);
    const rect = await byAmount(t, original.id, 1000);
    expect(rect.lines.map((l: any) => l.totalCents)).toEqual([-333, -667]);
    expect(rect.totalCents).toBe(-1000);
  });

  it("refuses more than is left, and a fully credited invoice", async () => {
    const t = setup();
    const original = await t.issue([{ description: "Corte", quantity: 1, unitPriceCents: 1000, taxRate: 21, taxIncluded: true }]);
    await t.rectify(original.id, [{ originalLineId: original.lines[0].id, quantity: -0.5 }]);
    expect(await message(byAmount(t, original.id, 600))).toBe(
      "El abono (6,00 €) supera lo que queda por abonar de la factura (5,00 €)",
    );
    expect((await byAmount(t, original.id, 500)).totalCents).toBe(-500);
    expect(await message(byAmount(t, original.id, 1))).toBe("La factura ya está abonada entera: no queda nada que rectificar");
    expect(await message(t.svc.assertCreditable("t1", original.id, 1))).toBe(
      "La factura ya está abonada entera: no queda nada que rectificar",
    );
  });
});
