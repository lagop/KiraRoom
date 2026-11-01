import { Prisma } from "@prisma/client";
import { appointmentInvoiceLines, loyaltyDiscountCents, withoutLoyalty } from "./appointment-invoice-pricing";
import { InvoiceCalculator } from "./invoice-calculator.service";
import { visitChargeCents, visitDiscountInCatalogue } from "../payments/appointment-charge";
import { buildInvoiceDocument, discountLabel } from "./pdf/invoice-document";

/**
 * The loyalty reward on the invoice (owner decision 2026-11-02): a discount
 * on the lines, so the invoice comes to what the client paid and the tax
 * base and tax go down with it; named "Descuento fidelidad" on the PDF.
 */
const calc = new InvoiceCalculator();
const TAX_INCLUDED = { pricesIncludeTax: true, defaultTaxRate: 21 };
const TAX_ON_TOP = { pricesIncludeTax: false, defaultTaxRate: 21 };

const row = (id: string, serviceId: string, name: string, price: string) => ({
  id,
  serviceId,
  professionalId: null,
  scheduledStart: null,
  scheduledEnd: null,
  isParallel: false,
  type: "active",
  status: "pending",
  service: { name, price, duration: 30 },
});

/** A visit of two services, 45 + 20 = 65,00. */
const visit = (over: Record<string, unknown> = {}) => ({
  price: new Prisma.Decimal("65.00"),
  totalAmount: 6500,
  serviceId: "svc-colour",
  service: { name: "Color", price: "45" },
  services: [row("r1", "svc-colour", "Color", "45"), row("r2", "svc-cut", "Corte", "20")],
  ...over,
});

describe("the calculator carries the loyalty part of a line's discount", () => {
  it("inside the discount, never more than it; the amounts are the discounted ones", () => {
    const r = calc.compute([
      { description: "Corte", quantity: 1, unitPriceCents: 3000, taxRate: 21, taxIncluded: true, discountCents: 500, loyaltyDiscountCents: 500 },
      { description: "Champú", quantity: 1, unitPriceCents: 1000, taxRate: 21, taxIncluded: true, discountCents: 100, loyaltyDiscountCents: 900 },
      { description: "Laca", quantity: 1, unitPriceCents: 1000, taxRate: 21, taxIncluded: true },
    ]);
    expect(r.lines.map((l) => [l.totalCents, l.loyaltyDiscountCents])).toEqual([
      [2500, 500],
      [900, 100],
      [1000, undefined],
    ]);
    expect(r.totalCents).toBe(4400);
  });
});

describe("a visit's invoice with the loyalty reward", () => {
  it("reads the reward the till recorded (discount.loyalty) and nothing else", () => {
    expect(loyaltyDiscountCents({ loyalty: { catalogueCents: 500, moneyCents: 500 } })).toBe(500);
    expect(loyaltyDiscountCents({ pos: { amountCents: 300 } })).toBe(0);
    expect(loyaltyDiscountCents(null)).toBe(0);
    expect(withoutLoyalty({ discount: { pos: { amountCents: 1 }, loyalty: { catalogueCents: 2 } } }).discount).toEqual({ pos: { amountCents: 1 } });
  });

  it("several services: shared in proportion, the rounding cent on the largest line, total = what was paid", () => {
    // 10,01 off 45 : 20 -> 6,93 / 3,08 (6,93 + 3,08 = 10,01; the extra cent on Color).
    const lines = appointmentInvoiceLines(visit({ discount: { loyalty: { catalogueCents: 1001 } } }), TAX_INCLUDED);
    expect(lines.map((l) => [l.description, l.discountCents, l.loyaltyDiscountCents])).toEqual([
      ["Color", 693, 693],
      ["Corte", 308, 308],
    ]);
    const r = calc.compute(lines);
    expect(r.totalCents).toBe(6500 - 1001);
    expect(r.subtotalCents + r.taxBreakdown[0].taxCents).toBe(r.totalCents);
  });

  it("with a till discount too: both on the lines, only the reward named", () => {
    // The till took 5,00 off (price 60,00), the reward 6,00 more: invoice 54,00.
    const lines = appointmentInvoiceLines(
      visit({ price: new Prisma.Decimal("60.00"), totalAmount: 6000, discount: { pos: { amountCents: 500 }, loyalty: { catalogueCents: 600 } } }),
      TAX_INCLUDED,
    );
    const r = calc.compute(lines);
    expect(r.totalCents).toBe(5400);
    expect(lines.reduce((s, l) => s + (l.loyaltyDiscountCents ?? 0), 0)).toBe(600);
    expect(lines.reduce((s, l) => s + (l.discountCents ?? 0), 0)).toBe(1100);
  });

  it("one line: the reward off it", () => {
    const lines = appointmentInvoiceLines(
      { price: new Prisma.Decimal("30.00"), serviceId: "svc-1", service: { name: "Corte" }, discount: { loyalty: { catalogueCents: 500 } } },
      TAX_INCLUDED,
    );
    expect(lines).toEqual([expect.objectContaining({ unitPriceCents: 3000, discountCents: 500, loyaltyDiscountCents: 500 })]);
    expect(calc.compute(lines).totalCents).toBe(2500);
  });

  it("what the visit costs (the till's owed amount) is before the reward: it was paid with points", () => {
    const v = visit({ discount: { loyalty: { catalogueCents: 500 } } });
    expect(visitChargeCents(v, TAX_INCLUDED)).toBe(6500);
    expect(visitChargeCents(v, TAX_ON_TOP)).toBe(visitChargeCents(visit(), TAX_ON_TOP));
  });

  it("prices as the base: the reward in catalogue terms brings the invoice to the money paid, to the cent", () => {
    const one = { price: new Prisma.Decimal("30.00"), totalAmount: 3000, serviceId: "svc-1", service: { name: "Corte", price: "30" } };
    // 30,00 + 21 % = 36,30 of money; 5,00 of reward -> 31,30 paid.
    const { catalogueCents } = visitDiscountInCatalogue(one, TAX_ON_TOP, 500);
    expect(catalogueCents).toBe(413);
    const lines = appointmentInvoiceLines({ ...one, discount: { loyalty: { catalogueCents } } }, TAX_ON_TOP);
    expect(Math.abs(calc.compute(lines).totalCents - 3130)).toBeLessThanOrEqual(1);
  });
});

describe("the PDF names it", () => {
  it("the whole discount is the reward: 'Descuento fidelidad 5,00 €'", () => {
    // Stored as the till does: tax included, the net unit price, the discount as a percent.
    const label = discountLabel(16.666667, 500, { unitPriceCents: 2479, quantity: 1, taxRate: 21, taxIncluded: true });
    expect(label).toMatch(/^Descuento fidelidad 5,00\s€$/);
  });

  it("with a till discount too: the percent, and the reward inside it", () => {
    const label = discountLabel(20, 300, { unitPriceCents: 2479, quantity: 1, taxRate: 21, taxIncluded: true });
    expect(label).toMatch(/^Dto\. 20 % \(incluye Descuento fidelidad 3,00\s€\)$/);
    expect(discountLabel(10, 0, { unitPriceCents: 1000, quantity: 1 })).toBe("Dto. 10 %");
  });

  it("on the document's line", () => {
    const doc = buildInvoiceDocument({
      tenant: { name: "Salón" },
      invoice: {
        series: "T",
        number: "000001",
        issueDate: "2026-11-02T00:00:00Z",
        recipientName: "Consumidor final",
        subtotalCents: 2066,
        totalCents: 2500,
        currency: "EUR",
      },
      lines: [{ description: "Corte", quantity: 1, unitPriceCents: 2479, taxRate: 21, discountPct: 16.666667, loyaltyDiscountCents: 500, taxIncluded: true, totalCents: 2500 }],
      taxBreakdown: [{ rate: 21, baseCents: 2066, taxCents: 434 }],
    });
    expect(doc.lines[0].discount).toMatch(/Descuento fidelidad 5,00/);
    expect(doc.totals.total).toMatch(/25,00/);
  });
});
