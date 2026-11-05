import type { DiscountSpec } from "./pos-discounts";
import { prorateCapped } from "./prorate";
import type { SimplifiedInvoiceLine } from "../invoices/invoices.service";

/**
 * The till's ticket, in MONEY (tax included: what the client pays and what
 * the invoice says; appointment-charge.ts explains money vs catalogue).
 *
 * The rules, in one place:
 *
 *   - Every line is priced by the server in money: a service or product at
 *     its catalogue price plus the tax when the salon's prices are the base
 *     (round per unit, the public price), an appointment at what it still
 *     owes of its invoice total (amountDue). Discounts (pos-discounts.ts),
 *     the loyalty reward and the tenders all work on those figures, so what
 *     the panel shows, what is charged and what the invoice says are one
 *     number.
 *   - Lines without an appointment (services, products) go on the sale's
 *     simplified invoice (series T) as tax-included lines at those prices,
 *     with their discounts: its total is exactly what they cost. A visit
 *     keeps its own invoice (the appointment flow), never both.
 *   - A gift card sold is its own line kind: a multi-purpose voucher is not
 *     taxed when sold, so it is not on the invoice and carries no tax.
 *   - The loyalty reward is paid with points and is a discount on the
 *     invoice (owner decision 2026-11-02), so the invoice comes to what was
 *     charged: an appointment's share goes on the visit's invoice
 *     (appointment-invoice-pricing.ts), the rest is shared over the sale's
 *     own lines in proportion to their tax base (loyaltyShares), added to
 *     each line's discount and named on it ("Descuento fidelidad").
 *   - Commissions: an appointment's come from it (a percent of its
 *     catalogue total, as before); a service sold without one is recorded
 *     on its sale line with the professional who did it, its commission a
 *     percent of the line in catalogue terms (without the tax when the
 *     salon's prices are the base), so both are on the same basis.
 */
export type PosLineKind = "appointment" | "service" | "product";

/**
 * A cart line as the server prices it: money cents per unit, from the
 * database. The client sends only what is sold and how many, and the
 * discount it asks for, never a price.
 */
export interface PricedLine {
  kind: PosLineKind;
  serviceId?: string;
  productId?: string;
  appointmentId?: string;
  /** Who did it: the appointment's professional, or the one picked at the till. */
  professionalId?: string;
  name: string;
  /** Money cents per unit, tax included. */
  price: number;
  quantity: number;
  /** Percent (21). */
  taxRate: number;
  discount?: DiscountSpec;
  /** A product whose stock is counted. */
  trackInventory?: boolean;
  /** The line's price in catalogue cents per unit (commission basis). */
  catalogueUnitCents?: number;
  /**
   * Its share of the promotion code applied at the till (money cents),
   * after the manual discounts: netCents is after it too
   * (promotions/promotion-at-till.ts).
   */
  promotionDiscountCents?: number;
}

/** Every discount on a ticket line before the loyalty reward: its own, its share of the ticket's, the promotion's. */
export function lineOffCents(line: { lineDiscountCents: number; orderDiscountCents: number; promotionDiscountCents?: number }): number {
  return line.lineDiscountCents + line.orderDiscountCents + (line.promotionDiscountCents ?? 0);
}

/** A gift card sold on the ticket. Not taxed, not discounted, not invoiced. */
export interface GiftCardLine {
  amountCents: number;
  recipientName?: string;
  recipientEmail?: string;
  message?: string;
}

/** The tax inside a tax-included amount: amount - round(amount / (1 + rate)), as InvoiceCalculator. */
export function includedTaxCents(amountCents: number, ratePercent: number): number {
  if (!(ratePercent > 0) || amountCents === 0) return 0;
  return amountCents - Math.round(amountCents / (1 + ratePercent / 100));
}

/**
 * The loyalty reward's share of each line (money cents): in proportion to
 * the line's tax base after its discounts, never more than the line, in
 * whole cents with the rounding on the largest line (prorate.ts). With one
 * tax rate that is in proportion to the lines' money; with mixed rates the
 * base decides, so each rate's base and tax go down by its share.
 */
export function loyaltyShares(lines: Array<{ netCents: number; taxRate: number }>, loyaltyCents: number): number[] {
  return prorateCapped(
    loyaltyCents,
    lines.map((l) => ({ weight: Math.max(0, l.netCents - includedTaxCents(l.netCents, l.taxRate)), cap: Math.max(0, l.netCents) })),
  );
}

/**
 * The invoice line of a line sold without an appointment (tax included, at
 * the till's price), with its discounts, its share of the promotion code
 * (named on it: "Descuento promoción CODE") and of the loyalty reward.
 */
export function invoiceLineOf(
  line: PricedLine & { lineDiscountCents: number; orderDiscountCents: number },
  loyaltyCents = 0,
  promotionCode?: string,
): SimplifiedInvoiceLine {
  const promotion = Math.max(0, line.promotionDiscountCents ?? 0);
  const off = lineOffCents(line) + Math.max(0, loyaltyCents);
  return {
    description: line.name.slice(0, 200),
    quantity: line.quantity,
    unitPriceCents: line.price,
    taxRate: line.taxRate,
    taxIncluded: true,
    ...(off > 0 ? { discountCents: off } : {}),
    ...(loyaltyCents > 0 ? { loyaltyDiscountCents: loyaltyCents } : {}),
    ...(promotion > 0 && promotionCode ? { promotionDiscountCents: promotion, promotionCode } : {}),
    ...(line.serviceId ? { serviceId: line.serviceId } : {}),
    ...(line.productId ? { productId: line.productId } : {}),
  };
}

/** What a payment row pays for, beyond an appointment: Payment.type. */
export type PaymentBucket = "service" | "product" | "gift_card";

/**
 * Splits the money that no appointment took (splitTicket's rows without an
 * appointment) over what else the ticket sells, so each payment row has the
 * right Payment.type: services, then products, then gift cards. `buckets`
 * are what each kind costs in money after its discounts and the part of the
 * loyalty reward that came off it. Each row keeps its method; what is left
 * over (nothing, normally) stays with the last kind.
 */
export function rowsByBucket<R extends { method: string; amount: number; giftCardCode?: string }>(
  rows: R[],
  buckets: Array<{ type: PaymentBucket; cents: number }>,
): Array<R & { type: PaymentBucket }> {
  const left = buckets.filter((b) => b.cents > 0).map((b) => ({ ...b }));
  const out: Array<R & { type: PaymentBucket }> = [];
  for (const row of rows) {
    let amount = row.amount;
    if (amount === 0) {
      out.push({ ...row, type: left[0]?.type ?? buckets[0]?.type ?? "service" });
      continue;
    }
    for (const bucket of left) {
      if (amount <= 0) break;
      const take = Math.min(amount, bucket.cents);
      if (take <= 0) continue;
      out.push({ ...row, amount: take, type: bucket.type });
      bucket.cents -= take;
      amount -= take;
    }
    if (amount > 0) out.push({ ...row, amount, type: left[left.length - 1]?.type ?? "service" });
  }
  return out;
}

/** "Venta en caja: Corte, Champú", at most 500 characters. */
export function saleDescription(prefix: string, names: string[]): string {
  return `${prefix}: ${names.join(", ")}`.slice(0, 500);
}
