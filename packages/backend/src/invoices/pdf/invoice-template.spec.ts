import { buildInvoiceHtml, InvoiceTemplateData } from "./invoice-template";
import { InvoiceCalculator } from "../invoice-calculator.service";

/**
 * The invoice PDF for a salon whose prices include the tax and for one that
 * adds it on top. Either way the unit price column is the base, the line
 * total includes the tax, and Subtotal + tax = Total. The tax is named after
 * the salon's regime (IGIC in the Canaries), not always IVA.
 */
const calc = new InvoiceCalculator();
// \s also matches the no-break space toLocaleString puts before the euro sign.
const plain = (html: string) => html.replace(/\s+/g, " ");

function htmlFor(taxIncluded: boolean, taxRate: number, taxLabel?: string): string {
  const c = calc.compute([{ description: "Corte", quantity: 1, unitPriceCents: 3000, taxRate, taxIncluded }]);
  const data: InvoiceTemplateData = {
    tenant: { name: "Salón Luna" },
    invoice: {
      series: "A",
      number: "000001",
      issueDate: "2026-10-31T10:00:00.000Z",
      recipientName: "Ana López",
      subtotalCents: c.subtotalCents,
      totalCents: c.totalCents,
      currency: "EUR",
    },
    lines: c.lines.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitPriceCents: l.unitPriceCents,
      discountPct: l.discountPct,
      taxRate: l.taxRate,
      totalCents: l.totalCents,
    })),
    taxBreakdown: c.taxBreakdown,
    taxLabel,
  };
  return plain(buildInvoiceHtml(data));
}

describe("invoice PDF template", () => {
  it("prices including the tax: 24,79 + 5,21 IVA = 30,00", () => {
    const html = htmlFor(true, 21, "IVA");
    expect(html).toContain('<td class="price">24,79 €</td>');
    expect(html).toContain('<td class="total">30,00 €</td>');
    expect(html).toContain('<td class="label">Subtotal</td><td class="num">24,79 €</td>');
    expect(html).toContain('<td class="label">IVA 21%</td><td class="num">5,21 €</td>');
    expect(html).toContain('<tr class="total"><td class="label">Total</td><td class="num">30,00 €</td>');
  });

  it("tax on top: 30,00 + 6,30 IVA = 36,30", () => {
    const html = htmlFor(false, 21, "IVA");
    expect(html).toContain('<td class="price">30,00 €</td>');
    expect(html).toContain('<td class="total">36,30 €</td>');
    expect(html).toContain('<td class="label">Subtotal</td><td class="num">30,00 €</td>');
    expect(html).toContain('<td class="label">IVA 21%</td><td class="num">6,30 €</td>');
    expect(html).toContain('<tr class="total"><td class="label">Total</td><td class="num">36,30 €</td>');
  });

  it("a Canarian salon's invoice says IGIC", () => {
    const html = htmlFor(true, 7, "IGIC");
    expect(html).toContain('<th class="tax">IGIC</th>');
    expect(html).toContain('<td class="label">IGIC 7%</td><td class="num">1,96 €</td>');
    expect(html).not.toContain("IVA");
  });

  it("without a label it says IVA, as before", () => {
    expect(htmlFor(false, 21)).toContain('<th class="tax">IVA</th>');
  });
});
