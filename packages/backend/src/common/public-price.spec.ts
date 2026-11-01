import { publicPrice, publicPriceSettings, taxIncludedNote } from "./public-price";
import { InvoiceCalculator } from "../invoices/invoice-calculator.service";

describe("publicPrice: what a client sees is what the invoice comes to", () => {
  it("a catalogue with the tax inside is shown as it is", () => {
    const s = publicPriceSettings({ pricesIncludeTax: true, defaultTaxRate: 21 });
    expect(publicPrice(30, s)).toBe(30);
    expect(publicPrice("18.50", s)).toBe(18.5);
  });

  it("a net catalogue gets the salon's IVA on top: 30,00 -> 36,30", () => {
    const s = publicPriceSettings({ pricesIncludeTax: false, defaultTaxRate: 21 });
    expect(publicPrice(30, s)).toBe(36.3);
    expect(publicPrice("25.00", s)).toBe(30.25);
  });

  it("a salon from before the setting (no key) is net, at 21 % when it set no rate", () => {
    const s = publicPriceSettings({});
    expect(s).toEqual({ pricesIncludeTax: false, ratePercent: 21, taxLabel: "IVA" });
    expect(publicPrice(30, s)).toBe(36.3);
    expect(publicPrice(30, publicPriceSettings(null))).toBe(36.3);
  });

  it("IGIC 7 % in the Canaries, and the label says IGIC", () => {
    const s = publicPriceSettings({ pricesIncludeTax: false, defaultTaxRate: 7, taxRegime: "igic" });
    expect(publicPrice(30, s)).toBe(32.1);
    expect(s.taxLabel).toBe("IGIC");
    expect(taxIncludedNote(s)).toBe("IGIC incluido");
  });

  it("IPSI in Ceuta and Melilla", () => {
    const s = publicPriceSettings({ pricesIncludeTax: false, defaultTaxRate: 10, taxRegime: "ipsi" });
    expect(publicPrice(30, s)).toBe(33);
    expect(taxIncludedNote(s)).toBe("IPSI incluido");
  });

  it("a 0 % (exempt) rate leaves the price as it is", () => {
    const s = publicPriceSettings({ pricesIncludeTax: false, defaultTaxRate: 0 });
    expect(publicPrice(30, s)).toBe(30);
    expect(publicPrice(30, { pricesIncludeTax: false, ratePercent: Number.NaN })).toBe(30);
  });

  it("rounds to the cent the way the invoice does", () => {
    const net = { pricesIncludeTax: false, ratePercent: 21 };
    // 19,99 + 4,1979 -> 4,20 = 24,19
    expect(publicPrice(19.99, net)).toBe(24.19);
    // 12,345 is 12,35 in cents before the tax: 12,35 + 2,59 = 14,94
    expect(publicPrice(12.345, net)).toBe(14.94);
    // 9,5 % IGIC on 10,10: 0,9595 -> 0,96
    expect(publicPrice(10.1, { pricesIncludeTax: false, ratePercent: 9.5 })).toBe(11.06);
  });

  it("matches the invoice calculator for a range of net prices and rates", () => {
    for (const rate of [21, 10, 7, 9.5, 4, 3]) {
      for (let cents = 1; cents <= 20000; cents += 37) {
        const invoice = new InvoiceCalculator().compute([
          { description: "x", quantity: 1, unitPriceCents: cents, taxRate: rate, taxIncluded: false },
        ]);
        expect(Math.round(publicPrice(cents / 100, { pricesIncludeTax: false, ratePercent: rate }) * 100)).toBe(
          invoice.totalCents,
        );
      }
    }
  });

  it("anything not a number is 0, never NaN on a price list", () => {
    const s = publicPriceSettings({ pricesIncludeTax: false, defaultTaxRate: 21 });
    expect(publicPrice(undefined, s)).toBe(0);
    expect(publicPrice("abc", s)).toBe(0);
  });

  it("only the boolean true means the catalogue includes the tax", () => {
    expect(publicPriceSettings({ pricesIncludeTax: "true" }).pricesIncludeTax).toBe(false);
    expect(publicPriceSettings({ pricesIncludeTax: true }).pricesIncludeTax).toBe(true);
  });
});
