import { Prisma } from "@prisma/client";
import { appointmentInvoiceLines, tillPromotionOf } from "./appointment-invoice-pricing";
import { InvoiceCalculator } from "./invoice-calculator.service";
import { buildInvoiceDocument, discountLabel } from "./pdf/invoice-document";

/**
 * A promotion code applied at the till is a discount on the invoice, named
 * on the lines it came off: "Descuento promoción CODE" (the sale's own
 * invoice: pos.service.ts; a visit's: appointment-invoice-pricing.ts).
 */
const calc = new InvoiceCalculator();
const TAX_INCLUDED = { pricesIncludeTax: true, defaultTaxRate: 21 };

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

describe("the calculator carries the promotion's part of a line's discount", () => {
  it("with its code, never more than the discount, never on a line without a code", () => {
    const r = calc.compute([
      { description: "Corte", quantity: 1, unitPriceCents: 3000, taxRate: 21, taxIncluded: true, discountCents: 300, promotionDiscountCents: 300, promotionCode: "OTONO10" },
      { description: "Tinte", quantity: 1, unitPriceCents: 1000, taxRate: 21, taxIncluded: true, discountCents: 100, promotionDiscountCents: 900, promotionCode: "OTONO10" },
      { description: "Laca", quantity: 1, unitPriceCents: 1000, taxRate: 21, taxIncluded: true, discountCents: 100, promotionDiscountCents: 100 },
    ]);
    expect(r.lines.map((l) => [l.totalCents, l.promotionDiscountCents, l.promotionCode])).toEqual([
      [2700, 300, "OTONO10"],
      [900, 100, "OTONO10"],
      [900, undefined, undefined],
    ]);
  });
});

describe("a visit's invoice with a promotion code", () => {
  /** A visit of two services, 45 + 20 = 65,00, charged 58,50 after 10 % off at the till. */
  const visit = {
    price: new Prisma.Decimal("58.50"),
    totalAmount: 5850,
    serviceId: "svc-colour",
    service: { name: "Color", price: "45" },
    services: [row("r1", "svc-colour", "Color", "45"), row("r2", "svc-cut", "Corte", "20")],
    discount: { pos: { amountCents: 650, promotion: { promotionId: "p1", code: "OTONO10", moneyCents: 650, catalogueCents: 650 } } },
  };

  it("reads the promotion the till recorded, within its till discount", () => {
    expect(tillPromotionOf(visit.discount)).toEqual({ code: "OTONO10", catalogueCents: 650 });
    expect(tillPromotionOf({ pos: { amountCents: 100, promotion: { code: "X", catalogueCents: 300 } } })).toEqual({ code: "X", catalogueCents: 100 });
    expect(tillPromotionOf({ pos: { amountCents: 300 } })).toBeNull();
    expect(tillPromotionOf(null)).toBeNull();
  });

  it("names it on each line in proportion, and the invoice comes to what was charged", () => {
    const lines = appointmentInvoiceLines(visit as any, TAX_INCLUDED);
    expect(lines.map((l) => [l.description, l.discountCents, l.promotionDiscountCents, l.promotionCode])).toEqual([
      ["Color", 450, 450, "OTONO10"],
      ["Corte", 200, 200, "OTONO10"],
    ]);
    expect(calc.compute(lines).totalCents).toBe(5850);
  });

  it("on a one-line visit too, with a manual discount beside it", () => {
    const one = {
      price: new Prisma.Decimal("30.00"),
      totalAmount: 3000,
      serviceId: "svc-cut",
      service: { name: "Corte", price: "40" },
      discount: { pos: { amountCents: 1000, promotion: { code: "OTONO10", catalogueCents: 400, moneyCents: 400 } } },
    };
    const [line] = appointmentInvoiceLines(one as any, TAX_INCLUDED);
    expect(line).toMatchObject({ unitPriceCents: 4000, discountCents: 1000, promotionDiscountCents: 400, promotionCode: "OTONO10" });
  });
});

describe("the PDF", () => {
  const line = { unitPriceCents: 3000, quantity: 1, taxRate: 21, taxIncluded: false };

  it("names a promotion that is all of the discount: 'Descuento promoción CODE'", () => {
    expect(discountLabel(10, 0, line, "EUR", { cents: 300, code: "OTONO10" })).toMatch(/^Descuento promoción OTONO10 3,00\s€$/);
  });

  it("with a manual discount, the percentage including it", () => {
    expect(discountLabel(20, 0, line, "EUR", { cents: 300, code: "OTONO10" })).toMatch(
      /^Dto\. 20 % \(incluye Descuento promoción OTONO10 3,00\s€\)$/,
    );
  });

  it("with the loyalty reward, both named", () => {
    expect(discountLabel(20, 300, line, "EUR", { cents: 300, code: "OTONO10" })).toMatch(
      /^Descuento promoción OTONO10 3,00\s€ \+ Descuento fidelidad 3,00\s€$/,
    );
    // Without a promotion, as before.
    expect(discountLabel(10, 300, line)).toMatch(/^Descuento fidelidad 3,00\s€$/);
    expect(discountLabel(10, 0, line)).toBe("Dto. 10 %");
  });

  it("reads them from the stored line", () => {
    const doc = buildInvoiceDocument({
      invoice: {
        series: "T",
        number: "000001",
        issueDate: new Date("2026-11-02T10:00:00Z"),
        status: "issued",
        recipientName: "Consumidor final",
        subtotalCents: 2479,
        totalCents: 2700,
        currency: "EUR",
      },
      tenant: { name: "Salón", taxId: "B00000000" },
      lines: [
        {
          description: "Corte",
          quantity: 1,
          unitPriceCents: 2479,
          discountPct: 10,
          taxRate: 21,
          taxIncluded: true,
          promotionDiscountCents: 300,
          promotionCode: "OTONO10",
          totalCents: 2700,
        },
      ],
      taxBreakdown: [{ rate: 21, baseCents: 2231, taxCents: 469 }],
    } as any);
    expect(doc.lines[0].discount).toMatch(/^Descuento promoción OTONO10 3,00\s€$/);
  });
});
