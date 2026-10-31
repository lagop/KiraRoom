/**
 * The amounts of a manual invoice (Facturas > Nueva factura) as the form
 * previews them while the lines are typed. Display only: the server works
 * the invoice out itself (packages/backend/src/invoices/
 * invoice-calculator.service.ts) and is the one that decides. The
 * arithmetic here is the same, step by step and in integer cents, so the
 * subtotal, tax and total shown are the ones the invoice is issued with.
 *
 * Whether a typed price includes the tax follows the salon's "Mis precios ya
 * incluyen el impuesto" (Ajustes fiscales, fiscalSettings.pricesIncludeTax),
 * sent on every line as `taxIncluded`:
 *
 *   tax on top (false): unit = round(price x (1 - discount)),
 *     base = round(unit x quantity), tax = round(base x rate),
 *     total = base + tax. 30,00 EUR at 21 % is 30,00 + 6,30 = 36,30.
 *   tax included (true): gross = round(round(price x (1 - discount)) x quantity),
 *     base = round(gross / (1 + rate)), tax = gross - base, so the line is
 *     exactly the price typed: 30,00 EUR at 21 % is 24,79 + 5,21 = 30,00.
 *
 * Rounding is the server's (Math.round to the cent). The invoice's subtotal
 * is the sum of the line bases, its tax the sum of the line taxes, and its
 * total the two added.
 */

export interface InvoiceLineAmountsInput {
  quantity: number;
  /** Cents per unit, as typed: with the tax when `taxIncluded`, without it otherwise. */
  unitPriceCents: number;
  /** Percent off the unit price, 0-100. */
  discountPct?: number;
  /** Percent, 21 for 21 %. */
  taxRate: number;
  taxIncluded?: boolean;
}

export interface InvoiceLineAmounts {
  /** Taxable base of the line. */
  baseCents: number;
  taxCents: number;
  totalCents: number;
}

export interface InvoiceTotals {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** The server clamps the discount to 0-100 (and a non-number to 0). */
function clampDiscount(value: number | undefined): number {
  return Math.max(0, Math.min(100, finiteOr(value, 0)));
}

export function computeInvoiceLine(line: InvoiceLineAmountsInput): InvoiceLineAmounts {
  const quantity = finiteOr(line.quantity, 0);
  const unitPriceCents = finiteOr(line.unitPriceCents, 0);
  const taxRate = finiteOr(line.taxRate, 0);
  const discountPct = clampDiscount(line.discountPct);
  const discountedUnitCents = Math.round(unitPriceCents * (1 - discountPct / 100));
  const lineCents = Math.round(discountedUnitCents * quantity);

  if (line.taxIncluded) {
    const baseCents = Math.round(lineCents / (1 + taxRate / 100));
    return { baseCents, taxCents: lineCents - baseCents, totalCents: lineCents };
  }
  const taxCents = Math.round(lineCents * (taxRate / 100));
  return { baseCents: lineCents, taxCents, totalCents: lineCents + taxCents };
}

export function computeInvoiceTotals(lines: InvoiceLineAmountsInput[]): InvoiceTotals {
  let subtotalCents = 0;
  let taxCents = 0;
  for (const line of lines) {
    const amounts = computeInvoiceLine(line);
    subtotalCents += amounts.baseCents;
    taxCents += amounts.taxCents;
  }
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}

/**
 * The hint above the lines, for `t()`: whether the prices typed include the
 * tax, named after the salon's regime (IVA, IGIC, IPSI).
 *   true:  "Precios con IVA incluido (según Ajustes fiscales)"
 *   false: "Precios sin IVA: el IVA se suma"
 */
export function pricesTaxHintKey(pricesIncludeTax: boolean): string {
  return pricesIncludeTax
    ? "invoices.form.pricesIncludeTaxHint"
    : "invoices.form.pricesExcludeTaxHint";
}
