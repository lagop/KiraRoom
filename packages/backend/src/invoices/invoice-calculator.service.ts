import { Injectable } from "@nestjs/common";

export interface InvoiceLineInput {
  description: string;
  quantity: number;
  unitPriceCents: number;
  discountPct?: number;
  /**
   * A discount on the whole line, in cents, off unit price x quantity (a
   * discount given at the till, pos-discounts.ts). Exact where a percent
   * per unit would round: the line comes to the cents charged. Taken
   * instead of `discountPct`; the line's discountPct is then worked out
   * from it, for the PDF and the accounting export. In the price's own
   * terms: with `taxIncluded` it comes off the price with tax, otherwise
   * off the base, and the tax is computed on what is left either way.
   */
  discountCents?: number;
  taxRate: number;
  productId?: string;
  serviceId?: string;
  /**
   * `unitPriceCents` already includes the tax (a price the client sees and
   * pays). The line is split so that base + tax equals that price exactly:
   * base = gross / (1 + rate), tax = gross - base. The stored unit price is
   * the net one, like any other line. Default false: the tax is added on top.
   */
  taxIncluded?: boolean;
  /**
   * Amounts already worked out, taken as they are: a rectification
   * crediting a stored line (rectification-lines.ts), whose base, tax and
   * total have to be exactly the original's, negated, rather than
   * recomputed from its rounded net unit price (10,00 EUR with 21 % included
   * is stored at 8,26 a unit; 8,26 + 21 % on top is 9,99). With it,
   * unitPriceCents is the stored net one and discountPct is kept as given.
   */
  fixed?: { taxCents: number; totalCents: number };
}

export interface ComputedInvoiceLine {
  description: string;
  quantity: number;
  unitPriceCents: number;
  discountPct: number;
  taxRate: number;
  taxCents: number;
  totalCents: number;
  productId?: string;
  serviceId?: string;
  /** The line's price was given with the tax included (stored on InvoiceLine). */
  taxIncluded: boolean;
}

export interface TaxBreakdownEntry {
  rate: number;
  baseCents: number;
  taxCents: number;
}

export interface InvoiceComputation {
  lines: ComputedInvoiceLine[];
  subtotalCents: number;
  taxBreakdown: TaxBreakdownEntry[];
  totalCents: number;
}

/**
 * Pure-function invoice calculator. All money is in cents to avoid decimal
 * drift. Rounding is half-even (banker's) — matches Spanish fiscal rules.
 *
 * Tax breakdown is grouped by `taxRate` so that the AEAT / TicketBAI XML
 * builder can emit `<DetalleIVA>` nodes without further aggregation.
 */
@Injectable()
export class InvoiceCalculator {
  compute(input: InvoiceLineInput[]): InvoiceComputation {
    if (!Array.isArray(input) || input.length === 0) {
      throw new Error("Invoice must have at least one line");
    }

    const lines: ComputedInvoiceLine[] = input.map((l) => {
      if (l.fixed) return fixedLine(l);
      if ((l.discountCents ?? 0) > 0) return amountDiscountLine(l);
      const discountPct = clampNumber(l.discountPct ?? 0, 0, 100);
      if (l.taxIncluded) return taxIncludedLine(l, discountPct);
      const discountedUnitCents = roundHalfEven(
        l.unitPriceCents * (1 - discountPct / 100),
      );
      const lineBase = roundHalfEven(discountedUnitCents * l.quantity);
      const taxCents = roundHalfEven(lineBase * (l.taxRate / 100));
      const totalCents = lineBase + taxCents;
      return {
        description: l.description,
        quantity: l.quantity,
        unitPriceCents: l.unitPriceCents,
        discountPct,
        taxRate: l.taxRate,
        taxCents,
        totalCents,
        productId: l.productId,
        serviceId: l.serviceId,
        taxIncluded: false,
      };
    });

    const subtotalCents = lines.reduce((s, l) => s + l.totalCents - l.taxCents, 0);
    const taxBreakdown = aggregateTaxBreakdown(lines);
    const totalCents = subtotalCents + taxBreakdown.reduce((s, t) => s + t.taxCents, 0);

    return { lines, subtotalCents, taxBreakdown, totalCents };
  }
}

/**
 * A line whose price includes the tax. Taking the tax as gross - base (not
 * round(base * rate)) keeps the total equal to the price: 10,00 EUR at 21 %
 * is 8,26 + 1,74, where rounding each part gave 8,26 + 1,73 = 9,99. The
 * difference from base * rate is under one cent.
 */
function taxIncludedLine(l: InvoiceLineInput, discountPct: number): ComputedInvoiceLine {
  const divisor = 1 + l.taxRate / 100;
  const discountedUnitCents = roundHalfEven(l.unitPriceCents * (1 - discountPct / 100));
  const grossCents = roundHalfEven(discountedUnitCents * l.quantity);
  const lineBase = roundHalfEven(grossCents / divisor);
  return {
    description: l.description,
    quantity: l.quantity,
    unitPriceCents: roundHalfEven(l.unitPriceCents / divisor),
    discountPct,
    taxRate: l.taxRate,
    taxCents: grossCents - lineBase,
    totalCents: grossCents,
    productId: l.productId,
    serviceId: l.serviceId,
    taxIncluded: true,
  };
}

/** A line whose amounts were worked out already (InvoiceLineInput.fixed). */
function fixedLine(l: InvoiceLineInput): ComputedInvoiceLine {
  const fixed = l.fixed as { taxCents: number; totalCents: number };
  return {
    description: l.description,
    quantity: l.quantity,
    unitPriceCents: l.unitPriceCents,
    discountPct: clampNumber(l.discountPct ?? 0, 0, 100),
    taxRate: l.taxRate,
    taxCents: fixed.taxCents,
    totalCents: fixed.totalCents,
    productId: l.productId,
    serviceId: l.serviceId,
    taxIncluded: l.taxIncluded === true,
  };
}

/**
 * A line with a discount in cents (InvoiceLineInput.discountCents): the
 * line is price x quantity less that amount, exactly. 30,00 EUR with 3,00
 * off at 21 %: tax on top, base 27,00 + 5,67 IVA; tax included, 27,00 =
 * 22,31 + 4,69 IVA. Its discountPct is that amount over the line, as a
 * percent with up to 6 decimals.
 */
function amountDiscountLine(l: InvoiceLineInput): ComputedInvoiceLine {
  const lineCents = roundHalfEven(l.unitPriceCents * l.quantity);
  const discount = Math.min(Math.max(0, Math.round(l.discountCents ?? 0)), Math.max(0, lineCents));
  const discountPct = lineCents > 0 ? Math.round((discount / lineCents) * 100 * 1e6) / 1e6 : 0;
  const afterDiscount = lineCents - discount;
  let unitPriceCents = l.unitPriceCents;
  let base: number;
  let taxCents: number;
  if (l.taxIncluded) {
    const divisor = 1 + l.taxRate / 100;
    unitPriceCents = roundHalfEven(l.unitPriceCents / divisor);
    base = roundHalfEven(afterDiscount / divisor);
    taxCents = afterDiscount - base;
  } else {
    base = afterDiscount;
    taxCents = roundHalfEven(base * (l.taxRate / 100));
  }
  return {
    description: l.description,
    quantity: l.quantity,
    unitPriceCents,
    discountPct,
    taxRate: l.taxRate,
    taxCents,
    totalCents: base + taxCents,
    productId: l.productId,
    serviceId: l.serviceId,
    taxIncluded: l.taxIncluded === true,
  };
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function roundHalfEven(value: number): number {
  return Math.round(value);
}

/**
 * Group line totals by taxRate. Rates are normalised to whole percent so
 * 21.0 and 21.00001 do not produce two separate buckets.
 */
function aggregateTaxBreakdown(
  lines: ComputedInvoiceLine[],
): TaxBreakdownEntry[] {
  const buckets = new Map<number, TaxBreakdownEntry>();
  for (const l of lines) {
    const rate = Math.round(l.taxRate);
    const baseCents = l.totalCents - l.taxCents;
    const entry = buckets.get(rate) ?? { rate, baseCents: 0, taxCents: 0 };
    entry.baseCents += baseCents;
    entry.taxCents += l.taxCents;
    buckets.set(rate, entry);
  }
  return [...buckets.values()].sort((a, b) => b.rate - a.rate);
}