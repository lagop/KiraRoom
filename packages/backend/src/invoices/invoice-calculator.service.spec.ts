import { InvoiceCalculator } from "./invoice-calculator.service";

describe("InvoiceCalculator", () => {
  const calc = new InvoiceCalculator();

  it("computes a single line at 21% IVA correctly", () => {
    const r = calc.compute([
      { description: "Corte", quantity: 1, unitPriceCents: 10000, taxRate: 21 },
    ]);
    expect(r.lines[0].taxCents).toBe(2100);
    expect(r.lines[0].totalCents).toBe(12100);
    expect(r.subtotalCents).toBe(10000);
    expect(r.taxBreakdown).toEqual([
      { rate: 21, baseCents: 10000, taxCents: 2100 },
    ]);
    expect(r.totalCents).toBe(12100);
  });

  it("applies quantity to line totals", () => {
    const r = calc.compute([
      { description: "Producto", quantity: 3, unitPriceCents: 500, taxRate: 10 },
    ]);
    expect(r.lines[0].taxCents).toBe(150);
    expect(r.lines[0].totalCents).toBe(1650);
    expect(r.subtotalCents).toBe(1500);
    expect(r.totalCents).toBe(1650);
  });

  it("applies line discount before tax", () => {
    const r = calc.compute([
      {
        description: "Tratamiento",
        quantity: 1,
        unitPriceCents: 10000,
        taxRate: 21,
        discountPct: 20,
      },
    ]);
    // discounted unit = 8000; tax = 8000 * 0.21 = 1680
    expect(r.lines[0].taxCents).toBe(1680);
    expect(r.lines[0].totalCents).toBe(9680);
  });

  it("aggregates tax breakdown across lines with the same rate", () => {
    const r = calc.compute([
      { description: "A", quantity: 1, unitPriceCents: 10000, taxRate: 21 },
      { description: "B", quantity: 2, unitPriceCents: 5000, taxRate: 21 },
    ]);
    expect(r.taxBreakdown).toHaveLength(1);
    expect(r.taxBreakdown[0]).toEqual({
      rate: 21,
      baseCents: 20000,
      taxCents: 4200,
    });
    expect(r.totalCents).toBe(24200);
  });

  it("splits breakdown by tax rate", () => {
    const r = calc.compute([
      { description: "A", quantity: 1, unitPriceCents: 10000, taxRate: 21 },
      { description: "B", quantity: 1, unitPriceCents: 5000, taxRate: 10 },
      { description: "C", quantity: 1, unitPriceCents: 2000, taxRate: 0 },
    ]);
    expect(r.taxBreakdown).toHaveLength(3);
    expect(r.totalCents).toBe(10000 + 2100 + 5000 + 500 + 2000);
  });

  it("treats 0% tax as exempt (no tax line)", () => {
    const r = calc.compute([
      { description: "Exento", quantity: 1, unitPriceCents: 5000, taxRate: 0 },
    ]);
    expect(r.taxBreakdown[0]).toEqual({ rate: 0, baseCents: 5000, taxCents: 0 });
  });

  it("clamps invalid discount to 0-100", () => {
    const r = calc.compute([
      {
        description: "X",
        quantity: 1,
        unitPriceCents: 1000,
        taxRate: 21,
        discountPct: 150,
      },
    ]);
    // discount clamped to 100 → unit price 0 → tax 0 → total 0
    expect(r.lines[0].taxCents).toBe(0);
    expect(r.lines[0].totalCents).toBe(0);
  });

  it("rejects empty line list", () => {
    expect(() => calc.compute([])).toThrow(/at least one line/);
  });

  it("rounds per-line (each line of <5 cents rounds to 0 tax)", () => {
    // Per Spanish fiscal rules, tax is rounded per line, not per invoice.
    // 100 lines of 1 cent → each line's tax is round(0.21) = 0 → total tax 0.
    const lines = Array.from({ length: 100 }, () => ({
      description: "x",
      quantity: 1,
      unitPriceCents: 1,
      taxRate: 21,
    }));
    const r = calc.compute(lines);
    expect(r.subtotalCents).toBe(100);
    expect(r.taxBreakdown[0].taxCents).toBe(0);
    expect(r.totalCents).toBe(100);
  });

  it("handles large invoices without losing cents", () => {
    // 1000 lines × 10000 cents at 21% → exactly 2,100,000 tax cents
    const lines = Array.from({ length: 1000 }, () => ({
      description: "x",
      quantity: 1,
      unitPriceCents: 10000,
      taxRate: 21,
    }));
    const r = calc.compute(lines);
    expect(r.subtotalCents).toBe(10_000_000);
    expect(r.taxBreakdown[0].taxCents).toBe(2_100_000);
    expect(r.totalCents).toBe(12_100_000);
  });
});
describe("InvoiceCalculator, tax included in the price (taxIncluded)", () => {
  const calc = new InvoiceCalculator();

  it("splits a 10,00 EUR price at 21 % into 8,26 + 1,74, keeping the total at 10,00", () => {
    const r = calc.compute([
      { description: "Corte", quantity: 1, unitPriceCents: 1000, taxRate: 21, taxIncluded: true },
    ]);
    expect(r.subtotalCents).toBe(826);
    expect(r.taxBreakdown).toEqual([{ rate: 21, baseCents: 826, taxCents: 174 }]);
    expect(r.totalCents).toBe(1000);
    // Stored unit price is the net one, like any other line.
    expect(r.lines[0].unitPriceCents).toBe(826);
  });

  it("total always equals the price, and the tax is within a cent of base x rate", () => {
    for (const rate of [21, 10, 4, 7, 9.5, 0]) {
      for (let gross = 1; gross <= 20000; gross += 7) {
        const r = calc.compute([
          { description: "x", quantity: 1, unitPriceCents: gross, taxRate: rate, taxIncluded: true },
        ]);
        expect(r.totalCents).toBe(gross);
        expect(r.subtotalCents + r.taxBreakdown[0].taxCents).toBe(gross);
        expect(Math.abs(r.taxBreakdown[0].taxCents - (r.subtotalCents * rate) / 100)).toBeLessThan(1);
      }
    }
  });

  it("applies discount and quantity to the gross amount", () => {
    const r = calc.compute([
      { description: "x", quantity: 2, unitPriceCents: 1210, discountPct: 50, taxRate: 21, taxIncluded: true },
    ]);
    expect(r.totalCents).toBe(1210);
    expect(r.subtotalCents).toBe(1000);
  });

  it("leaves lines without the flag as before (tax on top)", () => {
    const r = calc.compute([
      { description: "x", quantity: 1, unitPriceCents: 1000, taxRate: 21, taxIncluded: false },
    ]);
    expect(r.totalCents).toBe(1210);
  });
});
