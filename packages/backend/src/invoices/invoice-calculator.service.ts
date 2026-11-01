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
  /**
   * On a rectificativa: the line of the original this line credits
   * (InvoiceLine.rectifiesLineId), so what is left to credit of it is known.
   */
  rectifiesLineId?: string;
  /**
   * The part of `discountCents` that is the client's loyalty reward
   * (pos.service.ts, appointment-invoice-pricing.ts), in the same terms. It
   * is already inside discountCents: this only says which part it is, for
   * the PDF ("Descuento fidelidad"). Never more than discountCents.
   */
  loyaltyDiscountCents?: number;
  /**
   * The part of `discountCents` that is a promotion code applied at the till
   * (pos.service.ts, appointment-invoice-pricing.ts), in the same terms, and
   * the code: the PDF names it ("Descuento promoción CODE"). Already inside
   * discountCents. Never more than discountCents.
   */
  promotionDiscountCents?: number;
  promotionCode?: string;
  /**
   * Cents added to the line's tax (and so its total): the invoice's
   * rounding remainder, so it comes to the money actually charged. Used
   * where a reward given in money is taken off prices that are the base
   * (appointment-invoice-pricing.ts): base x rate rounds per line and the
   * total can land a cent or two off. The tax absorbs it, the way a
   * tax-included line does (tax = gross - base). Ignored on fixed lines and
   * when it would take the tax below zero.
   */
  roundingCents?: number;
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
  /** InvoiceLineInput.rectifiesLineId. */
  rectifiesLineId?: string;
  /** InvoiceLineInput.loyaltyDiscountCents (0 when none). */
  loyaltyDiscountCents?: number;
  /** InvoiceLineInput.promotionDiscountCents and its code (absent when none). */
  promotionDiscountCents?: number;
  promotionCode?: string;
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

    const lines: ComputedInvoiceLine[] = input.map((l) => withRounding(l, withPromotion(l, withLoyalty(l, lineOf(l)))));

    const subtotalCents = lines.reduce((s, l) => s + l.totalCents - l.taxCents, 0);
    const taxBreakdown = aggregateTaxBreakdown(lines);
    const totalCents = subtotalCents + taxBreakdown.reduce((s, t) => s + t.taxCents, 0);

    return { lines, subtotalCents, taxBreakdown, totalCents };
  }
}

/** The loyalty part of a line's discount, carried to the stored line (never more than the discount). */
function withLoyalty(l: InvoiceLineInput, computed: ComputedInvoiceLine): ComputedInvoiceLine {
  const loyalty = Math.round(Number(l.loyaltyDiscountCents ?? 0));
  if (!(loyalty > 0) || l.fixed) return computed;
  return { ...computed, loyaltyDiscountCents: Math.min(loyalty, Math.max(0, Math.round(l.discountCents ?? 0))) };
}

/** The promotion's part of a line's discount and its code, carried to the stored line (never more than the discount). */
function withPromotion(l: InvoiceLineInput, computed: ComputedInvoiceLine): ComputedInvoiceLine {
  const cents = Math.round(Number(l.promotionDiscountCents ?? 0));
  if (!(cents > 0) || l.fixed || !l.promotionCode) return computed;
  return {
    ...computed,
    promotionDiscountCents: Math.min(cents, Math.max(0, Math.round(l.discountCents ?? 0))),
    promotionCode: l.promotionCode,
  };
}

/** InvoiceLineInput.roundingCents on the line's tax and total: never a negative tax or total. */
function withRounding(l: InvoiceLineInput, computed: ComputedInvoiceLine): ComputedInvoiceLine {
  const cents = Math.round(Number(l.roundingCents ?? 0));
  if (!cents || l.fixed || computed.taxCents + cents < 0 || computed.totalCents + cents < 0) return computed;
  return { ...computed, taxCents: computed.taxCents + cents, totalCents: computed.totalCents + cents };
}

function lineOf(l: InvoiceLineInput): ComputedInvoiceLine {
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
    ...(l.rectifiesLineId ? { rectifiesLineId: l.rectifiesLineId } : {}),
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
 * A tax rate as a breakdown key: to two decimals, so 21.0 and 21.00001 do
 * not produce two buckets while IGIC's 9,5 % stays 9,5 (it used to be
 * rounded to a whole percent and stored as 10 %).
 */
export function breakdownRate(rate: number): number {
  return Math.round(Number(rate) * 100) / 100;
}

/** Group line amounts by tax rate (breakdownRate), highest rate first. */
export function aggregateTaxBreakdown(
  lines: Array<{ taxRate: number; taxCents: number; totalCents: number }>,
): TaxBreakdownEntry[] {
  const buckets = new Map<number, TaxBreakdownEntry>();
  for (const l of lines) {
    const rate = breakdownRate(l.taxRate);
    const baseCents = l.totalCents - l.taxCents;
    const entry = buckets.get(rate) ?? { rate, baseCents: 0, taxCents: 0 };
    entry.baseCents += baseCents;
    entry.taxCents += l.taxCents;
    buckets.set(rate, entry);
  }
  return [...buckets.values()].sort((a, b) => b.rate - a.rate);
}
