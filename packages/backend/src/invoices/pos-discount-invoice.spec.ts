import { Prisma } from "@prisma/client";
import { appointmentInvoiceLines, tillDiscountCents } from "./appointment-invoice-pricing";
import { InvoiceCalculator } from "./invoice-calculator.service";
import { buildInvoiceHtml } from "./pdf/invoice-template";

/**
 * A discount given at the till lowers what the visit costs (pos.service.ts)
 * and stays on the appointment under `discount.pos`. Its invoice shows the
 * price before the discount and the discount on each line, comes to what
 * was charged, and computes the tax on the discounted amount, whether the
 * salon's prices include the tax or not.
 */

const calc = new InvoiceCalculator();

describe("invoice lines with a discount in cents", () => {
  it("tax on top: the tax is on the discounted base (30,00 - 3,00 = 27,00 + 5,67 IVA)", () => {
    const r = calc.compute([{ description: "Corte", quantity: 1, unitPriceCents: 3000, discountCents: 300, taxRate: 21 }]);
    expect(r.lines[0]).toMatchObject({ unitPriceCents: 3000, discountPct: 10, taxCents: 567, totalCents: 3267 });
    expect(r.subtotalCents).toBe(2700);
    expect(r.taxBreakdown).toEqual([{ rate: 21, baseCents: 2700, taxCents: 567 }]);
    expect(r.totalCents).toBe(3267);
  });

  it("tax included: the line comes to what was charged (27,00 = 22,31 + 4,69 IVA)", () => {
    const r = calc.compute([
      { description: "Corte", quantity: 1, unitPriceCents: 3000, discountCents: 300, taxRate: 21, taxIncluded: true },
    ]);
    expect(r.lines[0]).toMatchObject({ unitPriceCents: 2479, discountPct: 10, taxCents: 469, totalCents: 2700 });
    expect(r.subtotalCents).toBe(2231);
    expect(r.totalCents).toBe(2700);
  });

  it("is exact on several units, where a percent per unit would round (3 x 12,50 - 10,00 = 27,50)", () => {
    const onTop = calc.compute([{ description: "Champú", quantity: 3, unitPriceCents: 1250, discountCents: 1000, taxRate: 21 }]);
    expect(onTop.subtotalCents).toBe(2750);
    expect(onTop.lines[0].discountPct).toBeCloseTo(26.666667, 6);
    const included = calc.compute([
      { description: "Champú", quantity: 3, unitPriceCents: 1250, discountCents: 1000, taxRate: 21, taxIncluded: true },
    ]);
    expect(included.totalCents).toBe(2750);
  });

  it("never takes more than the line, and leaves lines without it as they were", () => {
    const r = calc.compute([
      { description: "Corte", quantity: 1, unitPriceCents: 3000, discountCents: 5000, taxRate: 21 },
      { description: "Tinte", quantity: 1, unitPriceCents: 2000, taxRate: 21 },
    ]);
    expect(r.lines[0]).toMatchObject({ discountPct: 100, taxCents: 0, totalCents: 0 });
    expect(r.lines[1]).toMatchObject({ discountPct: 0, taxCents: 420, totalCents: 2420 });
  });
});

describe("an appointment discounted at the till: its invoice", () => {
  const pos = (amountCents: number) => ({ pos: { saleId: "sale-1", amountCents, reason: "Retraso" } });
  // Charged 36,00 (Appointment.price, euros, after the discount) for a 40,00 visit.
  const appt = {
    price: new Prisma.Decimal("36.00"),
    serviceId: "svc-cut",
    service: { name: "Corte", price: "40" },
    discount: pos(400),
  };

  it("reads the discount the till recorded, and nothing else", () => {
    expect(tillDiscountCents(pos(400))).toBe(400);
    expect(tillDiscountCents({})).toBe(0);
    expect(tillDiscountCents(null)).toBe(0);
    expect(tillDiscountCents({ noShowFee: 1500 })).toBe(0);
    expect(tillDiscountCents({ type: "percentage", value: 10, reason: "x" })).toBe(0);
    expect(tillDiscountCents({ pos: { amountCents: "abc" } })).toBe(0);
  });

  it("tax on top: the list price, 10 % off, tax on 36,00", () => {
    const lines = appointmentInvoiceLines(appt, { defaultTaxRate: 21 });
    expect(lines).toEqual([expect.objectContaining({ unitPriceCents: 4000, discountCents: 400, taxIncluded: false })]);
    const r = calc.compute(lines);
    expect(r.lines[0].discountPct).toBe(10);
    expect(r.subtotalCents).toBe(3600);
    expect(r.taxBreakdown).toEqual([{ rate: 21, baseCents: 3600, taxCents: 756 }]);
    expect(r.totalCents).toBe(4356);
  });

  it("tax included: the invoice totals the 36,00 charged (29,75 + 6,25 IVA)", () => {
    const lines = appointmentInvoiceLines(appt, { defaultTaxRate: 21, pricesIncludeTax: true });
    const r = calc.compute(lines);
    expect(r.totalCents).toBe(3600);
    expect(r.subtotalCents).toBe(2975);
    expect(r.taxBreakdown).toEqual([{ rate: 21, baseCents: 2975, taxCents: 625 }]);
    expect(r.lines[0]).toMatchObject({ unitPriceCents: 3306, discountPct: 10 });
  });

  it("a visit of several services: the discount is shared over its lines, which still add up", () => {
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
    // 45 + 20 + 2 x 4 = 73,00; 7,30 off at the till: 65,70 charged.
    const visit = {
      price: new Prisma.Decimal("65.70"),
      serviceId: "svc-colour",
      service: { name: "Color", price: "45" },
      services: [row("r1", "svc-colour", "Color", "45"), row("r2", "svc-cut", "Corte", "20")],
      addons: [{ quantity: 2, service: { id: "svc-mask", name: "Mascarilla", price: "4" } }],
      discount: pos(730),
    };
    const lines = appointmentInvoiceLines(visit, { defaultTaxRate: 21 });
    expect(lines.map((l) => [l.description, l.unitPriceCents, l.quantity, l.discountCents])).toEqual([
      ["Color", 4500, 1, 450],
      ["Corte", 2000, 1, 200],
      ["Mascarilla", 400, 2, 80],
    ]);
    expect(calc.compute(lines).subtotalCents).toBe(6570);
    const included = calc.compute(appointmentInvoiceLines(visit, { defaultTaxRate: 21, pricesIncludeTax: true }));
    expect(included.totalCents).toBe(6570);
  });

  it("a 100 % discount is an invoice at 0 that still names the service and the discount", () => {
    const lines = appointmentInvoiceLines({ ...appt, price: new Prisma.Decimal("0"), discount: pos(4000) }, {});
    const r = calc.compute(lines);
    expect(r.lines[0]).toMatchObject({ description: "Corte", unitPriceCents: 4000, discountPct: 100, totalCents: 0 });
    expect(r.totalCents).toBe(0);
  });

  it("without a till discount nothing changes", () => {
    const lines = appointmentInvoiceLines({ ...appt, price: new Prisma.Decimal("40.00"), discount: {} }, {});
    expect(lines).toEqual([
      { description: "Corte", quantity: 1, unitPriceCents: 4000, taxRate: 21, taxIncluded: false, serviceId: "svc-cut" },
    ]);
  });

  it("the PDF shows the discount under the line, and the price net of it", () => {
    const r = calc.compute(appointmentInvoiceLines(appt, { defaultTaxRate: 21 }));
    const html = buildInvoiceHtml({
      tenant: { name: "Salón Luna" },
      invoice: {
        series: "A",
        number: "000001",
        issueDate: "2026-10-31",
        recipientName: "Ana López",
        subtotalCents: r.subtotalCents,
        totalCents: r.totalCents,
        currency: "EUR",
      },
      lines: r.lines,
      taxBreakdown: r.taxBreakdown,
    });
    expect(html).toContain('<div class="discount">Dto. 10 %</div>');
    expect(html.replace(/\s/g, " ")).toMatch(/36,00 €/);
  });
});
