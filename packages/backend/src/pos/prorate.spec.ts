import { prorateCapped } from "./prorate";
import { loyaltyShares, invoiceLineOf } from "./pos-ticket";
import { InvoiceCalculator } from "../invoices/invoice-calculator.service";

/**
 * Sharing cents over lines: whole cents adding up exactly, the rounding on
 * the largest line, no line past its cap. Used for the loyalty reward on
 * the invoice and for refunds over a sale's lines.
 */
describe("prorateCapped", () => {
  it("in proportion, whole cents, adding up to the amount", () => {
    expect(prorateCapped(1000, [{ weight: 1, cap: 5000 }, { weight: 1, cap: 5000 }])).toEqual([500, 500]);
    const shares = prorateCapped(1001, [{ weight: 3, cap: 9999 }, { weight: 3, cap: 9999 }, { weight: 3, cap: 9999 }]);
    expect(shares.reduce((s, x) => s + x, 0)).toBe(1001);
  });

  it("the rounding cents go to the largest line, not by remainder", () => {
    // 100 over 1 : 1 : 1 -> 33,33 each: the extra cent to the largest weight (the first on a tie).
    expect(prorateCapped(100, [{ weight: 1, cap: 999 }, { weight: 1, cap: 999 }, { weight: 1, cap: 999 }])).toEqual([34, 33, 33]);
    // 10 over 1 : 2 : 4 -> 1,43 / 2,86 / 5,71: floors 1 / 2 / 5, the 2 cents left on the largest.
    expect(prorateCapped(10, [{ weight: 1, cap: 99 }, { weight: 2, cap: 99 }, { weight: 4, cap: 99 }])).toEqual([1, 2, 7]);
  });

  it("never past a line's cap: what it cannot take is shared over the others", () => {
    // 0 % line (base 100 for 100 of money) and a 21 % line (base 100 for 121): all 221 off.
    expect(prorateCapped(221, [{ weight: 100, cap: 100 }, { weight: 100, cap: 121 }])).toEqual([100, 121]);
    expect(prorateCapped(150, [{ weight: 100, cap: 50 }, { weight: 1, cap: 500 }])).toEqual([50, 100]);
  });

  it("an amount over the caps is placed up to them; nothing for no weight or no amount", () => {
    expect(prorateCapped(500, [{ weight: 1, cap: 100 }, { weight: 1, cap: 100 }])).toEqual([100, 100]);
    expect(prorateCapped(0, [{ weight: 1, cap: 100 }])).toEqual([0]);
    expect(prorateCapped(50, [])).toEqual([]);
    // No weights at all: shared by the caps.
    expect(prorateCapped(30, [{ weight: 0, cap: 100 }, { weight: 0, cap: 200 }])).toEqual([10, 20]);
  });
});

describe("the loyalty reward on a sale's invoice (pos-ticket.ts)", () => {
  const calculator = new InvoiceCalculator();
  const line = (price: number, taxRate: number, kind: "service" | "product" = "service") => ({
    kind,
    name: kind === "service" ? "Corte" : "Crema",
    price,
    quantity: 1,
    taxRate,
    lineDiscountCents: 0,
    orderDiscountCents: 0,
    netCents: price,
  });

  it("one rate: in proportion to the lines (their bases), the invoice comes to what was charged", () => {
    const lines = [line(3000, 21), line(1000, 21, "product")];
    const shares = loyaltyShares(lines, 500);
    // Bases 24,79 and 8,26: 3,7504 / 1,2496 -> 375 / 124, the cent left on the largest.
    expect(shares).toEqual([376, 124]);
    const invoice = calculator.compute(lines.map((l, i) => invoiceLineOf(l as any, shares[i])));
    expect(invoice.totalCents).toBe(3500);
    expect(invoice.lines.map((l) => l.loyaltyDiscountCents)).toEqual([376, 124]);
  });

  it("mixed rates: by tax base, each rate's base and tax go down by its share", () => {
    const lines = [line(3000, 21), line(1000, 10, "product")];
    // Bases 24,79 and 9,09: 3,6585 / 1,3415 -> 365 / 134, the cent left on the largest.
    const shares = loyaltyShares(lines, 500);
    expect(shares).toEqual([366, 134]);
    const invoice = calculator.compute(lines.map((l, i) => invoiceLineOf(l as any, shares[i])));
    expect(invoice.totalCents).toBe(3500);
    expect(invoice.taxBreakdown).toEqual([
      { rate: 21, baseCents: 2177, taxCents: 457 },
      { rate: 10, baseCents: 787, taxCents: 79 },
    ]);
  });

  it("a reward as large as the ticket leaves every line at zero, never below", () => {
    const lines = [line(1000, 0, "product"), line(1210, 21)];
    const shares = loyaltyShares(lines, 2210);
    expect(shares).toEqual([1000, 1210]);
    const invoice = calculator.compute(lines.map((l, i) => invoiceLineOf(l as any, shares[i])));
    expect(invoice.totalCents).toBe(0);
  });

  it("the line's own discounts stay, the reward adds to them and is named", () => {
    const discounted = { ...line(3000, 21), lineDiscountCents: 300, netCents: 2700 };
    expect(invoiceLineOf(discounted as any, 200)).toMatchObject({ discountCents: 500, loyaltyDiscountCents: 200, taxIncluded: true });
    expect(invoiceLineOf(discounted as any)).not.toHaveProperty("loyaltyDiscountCents");
  });
});
