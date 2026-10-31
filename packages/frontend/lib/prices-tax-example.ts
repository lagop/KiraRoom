/**
 * The worked example under "Mis precios ya incluyen el impuesto" in Ajustes
 * fiscales: what a 30,00 € service becomes on an invoice at the salon's rate,
 * with the tax inside the price or on top of it.
 *
 * Same arithmetic as the backend's invoice calculator
 * (packages/backend/src/invoices/invoice-calculator.service.ts), so the
 * example matches the invoices the salon will issue:
 *
 *   included: base = round(price / (1 + rate)), tax = price - base, so
 *             base + tax is exactly the price (24,79 + 5,21 = 30,00 at 21 %).
 *   on top:   tax = round(price * rate), total = price + tax
 *             (30,00 + 6,30 = 36,30).
 */

/** The example service price, in cents. */
export const EXAMPLE_PRICE_CENTS = 3000;

export interface PricesTaxExample {
  /** The price set on the service, "30,00 €". */
  price: string;
  /** The taxable base on the invoice. */
  base: string;
  /** The tax amount on the invoice. */
  tax: string;
  /** What the client pays. */
  total: string;
}

/** Cents as Spanish money: 2479 -> "24,79 €", 123456 -> "1.234,56 €". */
export function formatEuros(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const euros = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const rest = String(abs % 100).padStart(2, "0");
  return `${sign}${euros},${rest} €`;
}

export function pricesTaxExample(
  ratePercent: number,
  pricesIncludeTax: boolean,
  priceCents: number = EXAMPLE_PRICE_CENTS,
): PricesTaxExample {
  const rate = Number.isFinite(ratePercent) && ratePercent > 0 ? ratePercent : 0;
  if (pricesIncludeTax) {
    const base = Math.round(priceCents / (1 + rate / 100));
    return {
      price: formatEuros(priceCents),
      base: formatEuros(base),
      tax: formatEuros(priceCents - base),
      total: formatEuros(priceCents),
    };
  }
  const tax = Math.round(priceCents * (rate / 100));
  return {
    price: formatEuros(priceCents),
    base: formatEuros(priceCents),
    tax: formatEuros(tax),
    total: formatEuros(priceCents + tax),
  };
}

/**
 * The message key and parameters for the example sentence, for `t()`:
 *   included: "Un servicio de 30,00 € se factura como 24,79 € + 5,21 € de IVA"
 *   on top:   "Un servicio de 30,00 € se factura como 30,00 € + 6,30 € de IVA = 36,30 €"
 */
export function pricesTaxExampleMessage(
  ratePercent: number,
  pricesIncludeTax: boolean,
  taxLabel: string,
): { key: string; params: Record<string, string> } {
  const ex = pricesTaxExample(ratePercent, pricesIncludeTax);
  return {
    key: pricesIncludeTax
      ? "invoices.fiscalSettings.pricesIncludeTaxExampleIncluded"
      : "invoices.fiscalSettings.pricesIncludeTaxExampleOnTop",
    params: { ...ex, label: taxLabel },
  };
}
