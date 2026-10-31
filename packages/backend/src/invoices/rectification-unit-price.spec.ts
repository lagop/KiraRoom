import { InvoiceService } from "./invoices.service";
import { InvoiceCalculator } from "./invoice-calculator.service";
import { invoiceStore } from "./invoice-store.testing";
import { buildInvoiceHtml } from "./pdf/invoice-template";

/**
 * Units given back after part of a line was credited by amount (a discount
 * at the till after the invoice). The credited amount was already right
 * (what is left of the line), but the line was printed at the original's
 * unit price: -2 x 8,26 next to a total of -17,00. It is now printed at the
 * unit price actually credited, base / quantity, with no discount, so
 * quantity x unit price is the credited base; when that is not whole cents,
 * whole units go in two exact lines.
 */

function setup(fiscalSettings: Record<string, unknown> = { defaultSeries: "A", defaultTaxRate: 21 }) {
  const store = invoiceStore(fiscalSettings);
  const svc = new InvoiceService(store.prisma, new InvoiceCalculator(), {} as any);
  const issue = async (lines: Parameters<InvoiceService["create"]>[0]["lines"]) =>
    store.invoices.get((await svc.create({ tenantId: "t1", recipientName: "Ana Prueba", lines })).id);
  const discount = (id: string, cents: number) => svc.rectifyByAmountIn(store.prisma, "t1", id, cents, "Descuento en caja");
  const rectify = async (id: string, lines?: any[]) => store.invoices.get((await svc.emitRectification("t1", id, lines, "x")).id);
  return { ...store, svc, issue, discount, rectify };
}

/** Each line: |quantity| x unit price is its base, exactly, and no discount hides the difference. */
function expectExactLines(rect: any) {
  for (const l of rect.lines) {
    expect(Math.round(Math.abs(Number(l.quantity)) * l.unitPriceCents)).toBe(-(l.totalCents - l.taxCents));
    expect(Number(l.discountPct)).toBe(0);
  }
}

describe("units given back after a credit by amount", () => {
  it("divides exactly: one line at the unit price credited (tax on top, 2 x 9,00 after 2,00 off)", async () => {
    const t = setup();
    const original = await t.issue([{ description: "Tinte", quantity: 2, unitPriceCents: 1000, taxRate: 21 }]);
    await t.discount(original.id, 200);
    const rect = await t.rectify(original.id, [{ originalLineId: original.lines[0].id, quantity: -2 }]);
    expect(rect.lines).toHaveLength(1);
    expect(rect.lines[0]).toMatchObject({ quantity: -2, unitPriceCents: 900, taxCents: -378, totalCents: -2178 });
    expectExactLines(rect);
  });

  it("one of two units: half of what is left, at its own unit price", async () => {
    const t = setup();
    const original = await t.issue([{ description: "Tinte", quantity: 2, unitPriceCents: 1000, taxRate: 21 }]);
    await t.discount(original.id, 200);
    const rect = await t.rectify(original.id, [{ originalLineId: original.lines[0].id, quantity: -1 }]);
    expect(rect.lines[0]).toMatchObject({ quantity: -1, unitPriceCents: 900, totalCents: -1089 });
  });

  it("does not divide: two exact lines, one cent apart, adding up to what is left (tax included)", async () => {
    const t = setup();
    // 2 x 10,00 with 21 % included: 16,53 + 3,47. 3,00 off: 2,48 + 0,52.
    const original = await t.issue([{ description: "Corte", quantity: 2, unitPriceCents: 1000, taxRate: 21, taxIncluded: true }]);
    const off = t.invoices.get((await t.discount(original.id, 300)).id);
    const rect = await t.rectify(original.id);
    // 14,05 of base left for 2 units: 7,02 + 7,03.
    expect(rect.lines.map((l: any) => [Number(l.quantity), l.unitPriceCents])).toEqual([
      [-1, 702],
      [-1, 703],
    ]);
    expect(rect.lines.every((l: any) => l.rectifiesLineId === original.lines[0].id && l.description === "Corte")).toBe(true);
    expectExactLines(rect);
    expect(rect.subtotalCents).toBe(-1405);
    expect(rect.totalCents).toBe(-1700);
    // Together, the original is credited exactly: base, tax and total.
    expect(off.totalCents + rect.totalCents).toBe(-original.totalCents);
    expect(off.subtotalCents + rect.subtotalCents).toBe(-original.subtotalCents);
    expect(await t.rectify(original.id).catch((e) => e.message)).toBe(
      "La factura ya está abonada entera: no queda nada que rectificar",
    );
  });

  it("a fractional quantity that cannot be exact keeps one line and says the unit price is rounded", async () => {
    const t = setup();
    const original = await t.issue([{ description: "Laca", quantity: 1.5, unitPriceCents: 1000, taxRate: 21 }]);
    await t.discount(original.id, 100);
    const rect = await t.rectify(original.id);
    expect(rect.lines).toHaveLength(1);
    expect(rect.lines[0]).toMatchObject({ quantity: -1.5, unitPriceCents: 933, discountPct: 0, totalCents: -1694 });
    expect(rect.lines[0].description).toBe("Laca (precio unitario redondeado; base abonada 14,00 €)");
  });

  it("a line never credited by amount keeps the original's unit price and discount (the mirror)", async () => {
    const t = setup();
    const original = await t.issue([
      { description: "Mechas", quantity: 3, unitPriceCents: 3000, discountPct: 10, taxRate: 21, taxIncluded: true },
    ]);
    await t.rectify(original.id, [{ originalLineId: original.lines[0].id, quantity: -1 }]);
    const rest = await t.rectify(original.id);
    expect(rest.lines[0]).toMatchObject({ quantity: -2, unitPriceCents: original.lines[0].unitPriceCents });
    expect(Number(rest.lines[0].discountPct)).toBe(10);
  });

  it("the PDF prints the unit price credited", async () => {
    const t = setup();
    const original = await t.issue([{ description: "Corte", quantity: 2, unitPriceCents: 1000, taxRate: 21, taxIncluded: true }]);
    await t.discount(original.id, 300);
    const rect = await t.rectify(original.id);
    // As InvoicesController.pdfStream maps the stored lines.
    const html = buildInvoiceHtml({
      tenant: { name: "Salón Luna" },
      invoice: {
        series: rect.series,
        number: rect.number,
        issueDate: new Date().toISOString(),
        recipientName: rect.recipientName,
        subtotalCents: rect.subtotalCents,
        totalCents: rect.totalCents,
        currency: "EUR",
      },
      lines: rect.lines.map((l: any) => ({
        description: l.description,
        quantity: Number(l.quantity),
        unitPriceCents: l.unitPriceCents,
        discountPct: Number(l.discountPct),
        taxRate: Number(l.taxRate),
        totalCents: l.totalCents,
      })),
      taxBreakdown: rect.taxBreakdown,
    } as any).replace(/\s+/g, " ");
    expect(html).toContain('<td class="qty">-1</td> <td class="price">7,02 €</td>');
    expect(html).toContain('<td class="qty">-1</td> <td class="price">7,03 €</td>');
    expect(html).not.toContain("8,26 €");
    expect(html).not.toContain('class="discount"');
  });
});
