import { BadRequestException } from "@nestjs/common";
import { prorateCapped } from "../pos/prorate";

/**
 * Which lines of a till sale a refund gives back (POST /payments/:id/refund
 * with `lines`), and how its money is shared over them. Pure: the payments
 * service reads the rows and writes what this works out.
 *
 * The rules (owner decision 2026-11-02):
 *
 *   - Lines named (`lines: [{ lineId, quantity }]`): those units go back.
 *     A product's units return to stock (an inventory movement "return"),
 *     and each line records what was given back of it (refundedQuantity,
 *     refundedCents) so its commission counts only what is left and it can
 *     never be given back twice. The amount defaults to what the units are
 *     worth (capped at what is left of the payment); an amount given may be
 *     less (the rest comes back from another payment of the sale) but never
 *     more than they are worth.
 *   - An amount with no lines (a price correction, a goodwill refund): no
 *     unit comes back, nothing is restocked. The money is shared over the
 *     lines the payment paid for (its Payment.type: services or products),
 *     in proportion to what is left of each, so their commissions follow.
 *   - The whole sale given back (no payment of it left paid): every unit not
 *     returned yet goes back, products to stock, every line fully refunded.
 *
 * Lines of an appointment are not chosen here: the visit's own payment is
 * refunded and its commission follows the appointment (commission-refunds.ts).
 * Gift cards sold have their own refund (back off the card).
 */

/** A till sale line as the refund reads it. */
export interface SaleLineForRefund {
  id: string;
  kind: string;
  productId?: string | null;
  appointmentId?: string | null;
  description: string;
  quantity: number;
  /** What the line was charged, money cents (after its discounts and the loyalty reward). */
  totalCents: number;
  refundedQuantity: number;
  refundedCents: number;
}

export interface RefundLineRequest {
  lineId: string;
  quantity: number;
}

/** One line of a refund, as stored on Refund.saleLines. */
export interface RefundedLine {
  lineId: string;
  /** Units given back (restocked when a tracked product). */
  quantity: number;
  /** The part of the refund's money that is this line's. */
  cents: number;
}

/** The kinds of line a refund may name: what was sold at the till itself. */
export const REFUNDABLE_KINDS = ["service", "product"] as const;

function isRefundableKind(kind: string): boolean {
  return (REFUNDABLE_KINDS as readonly string[]).includes(kind);
}

export function unitsLeft(line: SaleLineForRefund): number {
  return Math.max(0, line.quantity - line.refundedQuantity);
}

export function centsLeft(line: SaleLineForRefund): number {
  return Math.max(0, line.totalCents - line.refundedCents);
}

/**
 * What `quantity` units of the line are worth now: their share of the line's
 * total, and all that is left of it for its last units (so the cents of the
 * rounding are never lost or given twice).
 */
export function unitsValueCents(line: SaleLineForRefund, quantity: number): number {
  const left = unitsLeft(line);
  if (quantity >= left) return centsLeft(line);
  if (line.quantity <= 0) return 0;
  return Math.min(centsLeft(line), Math.round((line.totalCents * quantity) / line.quantity));
}

/** The refundable lines of a sale, as the panel's refund dialog lists them. */
export function refundableLines(lines: SaleLineForRefund[]) {
  return lines
    .filter((l) => isRefundableKind(l.kind) && !l.appointmentId)
    .map((l) => ({
      id: l.id,
      kind: l.kind,
      description: l.description,
      quantity: l.quantity,
      refundedQuantity: l.refundedQuantity,
      refundableQuantity: unitsLeft(l),
      totalCents: l.totalCents,
      refundedCents: l.refundedCents,
      refundableCents: centsLeft(l),
    }));
}

/**
 * Checks the lines asked for (400 in Spanish) and returns, per line, the
 * units and what they are worth. Each line once, of this sale, of a kind the
 * till sold itself, a whole number of units not past what is left of it.
 */
export function requestedLines(
  sale: SaleLineForRefund[],
  requests: RefundLineRequest[],
): Array<{ line: SaleLineForRefund; quantity: number; valueCents: number }> {
  const byId = new Map(sale.map((l) => [l.id, l]));
  const seen = new Set<string>();
  const out: Array<{ line: SaleLineForRefund; quantity: number; valueCents: number }> = [];
  for (const r of requests) {
    const line = byId.get(r.lineId);
    if (!line) throw new BadRequestException("Una de las líneas elegidas no es de esta venta.");
    if (seen.has(line.id)) throw new BadRequestException(`La línea "${line.description}" está repetida.`);
    seen.add(line.id);
    if (!isRefundableKind(line.kind) || line.appointmentId) {
      throw new BadRequestException(
        line.kind === "gift_card"
          ? "Una tarjeta regalo vendida se devuelve desde su propio cobro, no por líneas."
          : `"${line.description}" es una cita: devuelve el cobro de la cita.`,
      );
    }
    const quantity = Number(r.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new BadRequestException(`Indica cuántas unidades de "${line.description}" se devuelven.`);
    }
    const left = unitsLeft(line);
    if (quantity > left) {
      throw new BadRequestException(
        left === 0
          ? `"${line.description}" ya está devuelta entera.`
          : `De "${line.description}" solo quedan ${left} por devolver.`,
      );
    }
    out.push({ line, quantity, valueCents: unitsValueCents(line, quantity) });
  }
  return out;
}

/**
 * Shares `amountCents` of a refund over lines (prorate.ts: in proportion to
 * `weights`, never past what is left of each line).
 */
export function shareOverLines(
  amountCents: number,
  lines: SaleLineForRefund[],
  weights: number[],
): number[] {
  return prorateCapped(
    amountCents,
    lines.map((l, i) => ({ weight: weights[i], cap: centsLeft(l) })),
  );
}

/**
 * The lines an amount-only refund of a payment is shared over: those of the
 * payment's kind (Payment.type "service" or "product") with something left,
 * else every line the till sold itself with something left.
 */
export function linesPaidBy(paymentType: string, lines: SaleLineForRefund[]): SaleLineForRefund[] {
  const own = lines.filter((l) => isRefundableKind(l.kind) && !l.appointmentId && centsLeft(l) > 0);
  const ofKind = own.filter((l) => l.kind === paymentType);
  return ofKind.length > 0 ? ofKind : own;
}
