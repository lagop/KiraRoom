import { Injectable } from "@nestjs/common";

export interface InvoiceLineInput {
  description: string;
  quantity: number;
  unitPriceCents: number;
  discountPct?: number;
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